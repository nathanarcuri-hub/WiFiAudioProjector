const stateEl = document.getElementById('state');
const toggleButton = document.getElementById('toggle');
const badgeEl = document.getElementById('badge');
const audioEl = document.getElementById('audio');
const metaBlockEl = document.getElementById('meta-block');
const bassSliderEl = document.getElementById('bass');
const midSliderEl = document.getElementById('mid');
const trebleSliderEl = document.getElementById('treble');
const bassValueEl = document.getElementById('bass-value');
const midValueEl = document.getElementById('mid-value');
const trebleValueEl = document.getElementById('treble-value');

const eqStorageKey = 'wifi-audio-projector:eq';
const mode = {
  label: 'Lossless PCM',
  pathLabel: 'WebSocket PCM',
  detail: 'Lossless PCM path with clock-matched recovery.',
  note: 'Telemetry below is receiver-side only and is here to help us catch the remaining chops.',
  endpoint: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`,
  ws: {
    maxBufferMs: 118,
    targetBufferMs: 64,
    startBufferMs: 40,
    resumeBufferMs: 28,
    reconnectDelayMs: 500,
    processorFrames: 1024,
    rateAdjustWindowMs: 2500,
    maxRateAdjust: 0.0045,
    emergencyTrimMs: 12,
    timestampSmoothing: 0.02,
    maxSourceRateDrift: 0.03
  }
};

const adaptiveBuffer = {
  maxBoostMs: 36,
  stepMs: 4,
  decayStepMs: 1,
  decayCycles: 120,
  boostMs: 0,
  stableCycles: 0
};

const telemetry = createTelemetry();
const eq = loadEqSettings();

let audioContext;
let mediaDestination;
let processor;
let preampNode;
let bassFilter;
let midFilter;
let trebleFilter;
let socket;
let sessionInfo;
let wakeLock;
let reconnectTimer;
let started = false;
let channels = 2;
let sourceSampleRate = 48000;
let estimatedSourceSampleRate = 48000;
let outputSampleRate = 48000;
let lastSourceTimestampUs = null;
let lastSourceTimestampSequence = null;
let queuedFrames = 0;
let ringBuffer = new Int16Array(0);
let ringCapacityFrames = 0;
let ringReadFrame = 0;
let ringWriteFrame = 0;
let playbackCursor = 0;
let lastSamples = new Float32Array(channels);
let holdSamples = new Float32Array(channels);
let holdDecay = 0;
let buffering = true;
let hasPlayedAudio = false;
let telemetryInterval = window.setInterval(updateTelemetryUi, 2000);

updateEqUi();
updateTelemetryUi();
setPlayingUi(false);

audioEl.controls = true;
audioEl.autoplay = true;
audioEl.playsInline = true;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

bassSliderEl?.addEventListener('input', () => updateEqBand('bass', Number(bassSliderEl.value)));
midSliderEl?.addEventListener('input', () => updateEqBand('mid', Number(midSliderEl.value)));
trebleSliderEl?.addEventListener('input', () => updateEqBand('treble', Number(trebleSliderEl.value)));

toggleButton.addEventListener('click', async () => {
  if (started) {
    await stopPlayback();
    return;
  }

  await startPlayback();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && started) {
    void requestWakeLock();
    if (audioContext?.state === 'suspended') {
      void audioContext.resume();
    }
    if (audioEl.paused) {
      void audioEl.play().catch(() => undefined);
    }
  }
});

window.addEventListener('beforeunload', () => {
  window.clearInterval(telemetryInterval);
  void stopPlayback({ preserveUi: true });
});

loadSession().catch(() => {
  sessionInfo = undefined;
  updateTelemetryUi();
});

function createTelemetry() {
  return {
    startedAtMs: 0,
    receivedFrames: 0,
    receivedBytes: 0,
    lastSequence: null,
    sequenceGaps: 0,
    underruns: 0,
    softTrimEvents: 0,
    softTrimFrames: 0,
    dropEvents: 0,
    droppedFrames: 0,
    reconnects: 0,
    socketErrors: 0,
    openEvents: 0,
    maxQueueMs: 0,
    maxBoostMs: 0,
    lastFrameAtMs: 0,
    lastRenderAtMs: 0,
    lastRateAdjust: 0,
    maxRateAdjust: 0
  };
}

function resetTelemetryCounters() {
  telemetry.startedAtMs = performance.now();
  telemetry.receivedFrames = 0;
  telemetry.receivedBytes = 0;
  telemetry.lastSequence = null;
  telemetry.sequenceGaps = 0;
  telemetry.underruns = 0;
  telemetry.softTrimEvents = 0;
  telemetry.softTrimFrames = 0;
  telemetry.dropEvents = 0;
  telemetry.droppedFrames = 0;
  telemetry.reconnects = 0;
  telemetry.socketErrors = 0;
  telemetry.openEvents = 0;
  telemetry.maxQueueMs = 0;
  telemetry.maxBoostMs = 0;
  telemetry.lastFrameAtMs = 0;
  telemetry.lastRenderAtMs = 0;
  telemetry.lastRateAdjust = 0;
  telemetry.maxRateAdjust = 0;
  resetSourceClockTracking();
}

function resetSourceClockTracking() {
  estimatedSourceSampleRate = sourceSampleRate;
  lastSourceTimestampUs = null;
  lastSourceTimestampSequence = null;
}

function updateSourceClockEstimate(sequence, timestampUs, frameCount) {
  if (!Number.isFinite(timestampUs) || timestampUs <= 0) {
    return;
  }

  if (lastSourceTimestampUs !== null && lastSourceTimestampSequence !== null && sequence > lastSourceTimestampSequence && timestampUs > lastSourceTimestampUs) {
    const sequenceDelta = sequence - lastSourceTimestampSequence;
    const frameDelta = Math.max(1, sequenceDelta * frameCount);
    const elapsedUs = timestampUs - lastSourceTimestampUs;
    const instantRate = (frameDelta * 1_000_000) / elapsedUs;
    const minRate = sourceSampleRate * (1 - mode.ws.maxSourceRateDrift);
    const maxRate = sourceSampleRate * (1 + mode.ws.maxSourceRateDrift);

    if (instantRate >= minRate && instantRate <= maxRate) {
      estimatedSourceSampleRate += (instantRate - estimatedSourceSampleRate) * mode.ws.timestampSmoothing;
    }
  }

  lastSourceTimestampUs = timestampUs;
  lastSourceTimestampSequence = sequence;
}
function clampEqValue(value) {
  return Math.max(-12, Math.min(12, Math.round(Number(value) || 0)));
}

function loadEqSettings() {
  const defaults = { bass: 0, mid: 0, treble: 0 };

  try {
    const raw = localStorage.getItem(eqStorageKey);
    if (!raw) {
      return defaults;
    }

    const parsed = JSON.parse(raw);
    return {
      bass: clampEqValue(parsed?.bass),
      mid: clampEqValue(parsed?.mid),
      treble: clampEqValue(parsed?.treble)
    };
  } catch {
    return defaults;
  }
}

function saveEqSettings() {
  try {
    localStorage.setItem(eqStorageKey, JSON.stringify(eq));
  } catch {
    // Ignore storage failures.
  }
}

function formatEqValue(value) {
  const normalized = clampEqValue(value);
  return `${normalized > 0 ? '+' : ''}${normalized} dB`;
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function smoothAudioParam(param, value) {
  if (!param) {
    return;
  }

  if (!audioContext || audioContext.state === 'closed') {
    param.value = value;
    return;
  }

  const now = audioContext.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, 0.01);
}

function computePreampDb() {
  const highestBoost = Math.max(eq.bass, eq.mid, eq.treble, 0);
  return -Math.min(9, highestBoost * 0.75);
}

function updateEqUi() {
  if (bassSliderEl) {
    bassSliderEl.value = String(eq.bass);
  }
  if (midSliderEl) {
    midSliderEl.value = String(eq.mid);
  }
  if (trebleSliderEl) {
    trebleSliderEl.value = String(eq.treble);
  }
  if (bassValueEl) {
    bassValueEl.textContent = formatEqValue(eq.bass);
  }
  if (midValueEl) {
    midValueEl.textContent = formatEqValue(eq.mid);
  }
  if (trebleValueEl) {
    trebleValueEl.textContent = formatEqValue(eq.treble);
  }
}

function applyEqSettings() {
  updateEqUi();
  saveEqSettings();

  if (!preampNode || !bassFilter || !midFilter || !trebleFilter) {
    return;
  }

  smoothAudioParam(preampNode.gain, dbToGain(computePreampDb()));
  smoothAudioParam(bassFilter.gain, eq.bass);
  smoothAudioParam(midFilter.gain, eq.mid);
  smoothAudioParam(trebleFilter.gain, eq.treble);
}

function updateEqBand(band, value) {
  eq[band] = clampEqValue(value);
  applyEqSettings();
}

async function loadSession() {
  if (sessionInfo) {
    return sessionInfo;
  }

  const response = await fetch('/session');
  sessionInfo = await response.json();
  updateTelemetryUi();
  return sessionInfo;
}

function setState(text) {
  stateEl.textContent = text;
}

function setPlayingUi(isPlaying) {
  toggleButton.textContent = isPlaying ? 'Stop Stream' : 'Play Stream';
  toggleButton.classList.toggle('stop', isPlaying);
  badgeEl.textContent = isPlaying ? 'Live' : 'Standby';
  badgeEl.classList.toggle('live', isPlaying);
}

function framesToMs(frameCount) {
  if (sourceSampleRate <= 0) {
    return 0;
  }

  return (frameCount / sourceSampleRate) * 1000;
}

function bufferedFramesFor(milliseconds) {
  return Math.max(1, Math.floor((sourceSampleRate * milliseconds) / 1000));
}

function effectiveBufferMs(baseMs) {
  return baseMs + adaptiveBuffer.boostMs;
}

function resetAdaptiveBuffer() {
  adaptiveBuffer.boostMs = 0;
  adaptiveBuffer.stableCycles = 0;
}

function increaseAdaptiveBuffer() {
  adaptiveBuffer.boostMs = Math.min(adaptiveBuffer.maxBoostMs, adaptiveBuffer.boostMs + adaptiveBuffer.stepMs);
  adaptiveBuffer.stableCycles = 0;
  telemetry.maxBoostMs = Math.max(telemetry.maxBoostMs, adaptiveBuffer.boostMs);
}

function settleAdaptiveBuffer() {
  if (adaptiveBuffer.boostMs <= 0) {
    return;
  }

  adaptiveBuffer.stableCycles += 1;
  if (adaptiveBuffer.stableCycles >= adaptiveBuffer.decayCycles) {
    adaptiveBuffer.boostMs = Math.max(0, adaptiveBuffer.boostMs - adaptiveBuffer.decayStepMs);
    adaptiveBuffer.stableCycles = 0;
  }
}

function ensureRingBufferCapacity(minFrames = 0) {
  const desiredFrames = Math.max(Math.ceil(sourceSampleRate * 2), minFrames, 4096);
  if (ringCapacityFrames >= desiredFrames) {
    return;
  }

  let nextCapacityFrames = 1;
  while (nextCapacityFrames < desiredFrames) {
    nextCapacityFrames <<= 1;
  }

  const nextBuffer = new Int16Array(nextCapacityFrames * channels);
  if (ringCapacityFrames > 0 && queuedFrames > 0) {
    const firstFrames = Math.min(queuedFrames, ringCapacityFrames - ringReadFrame);
    nextBuffer.set(
      ringBuffer.subarray(ringReadFrame * channels, (ringReadFrame + firstFrames) * channels),
      0
    );

    if (firstFrames < queuedFrames) {
      const remainingFrames = queuedFrames - firstFrames;
      nextBuffer.set(
        ringBuffer.subarray(0, remainingFrames * channels),
        firstFrames * channels
      );
    }
  }

  ringBuffer = nextBuffer;
  ringCapacityFrames = nextCapacityFrames;
  ringReadFrame = 0;
  ringWriteFrame = queuedFrames % ringCapacityFrames;
}

function clearQueue() {
  queuedFrames = 0;
  ringReadFrame = 0;
  ringWriteFrame = 0;
  playbackCursor = 0;
  buffering = true;
  hasPlayedAudio = false;
  holdDecay = 0;
  resetAdaptiveBuffer();
}

function shiftQueuedFrames(frameCount) {
  const consumedFrames = Math.min(frameCount, queuedFrames);
  if (consumedFrames <= 0 || ringCapacityFrames <= 0) {
    return 0;
  }

  ringReadFrame = (ringReadFrame + consumedFrames) % ringCapacityFrames;
  queuedFrames -= consumedFrames;

  if (queuedFrames === 0) {
    ringReadFrame = 0;
    ringWriteFrame = 0;
  }

  return consumedFrames;
}

function writeQueuedSamples(samples, frameCount) {
  if (frameCount <= 0) {
    return;
  }

  ensureRingBufferCapacity(queuedFrames + frameCount + bufferedFramesFor(500));
  const totalSamples = frameCount * channels;
  const writeSampleIndex = ringWriteFrame * channels;
  const samplesUntilWrap = ringBuffer.length - writeSampleIndex;

  if (totalSamples <= samplesUntilWrap) {
    ringBuffer.set(samples.subarray(0, totalSamples), writeSampleIndex);
  } else {
    ringBuffer.set(samples.subarray(0, samplesUntilWrap), writeSampleIndex);
    ringBuffer.set(samples.subarray(samplesUntilWrap, totalSamples), 0);
  }

  ringWriteFrame = (ringWriteFrame + frameCount) % ringCapacityFrames;
  queuedFrames += frameCount;
}

function recordSoftTrim(frameCount) {
  if (frameCount <= 0) {
    return;
  }

  telemetry.softTrimEvents += 1;
  telemetry.softTrimFrames += frameCount;
}

function recordHardDrop(frameCount) {
  if (frameCount <= 0) {
    return;
  }

  telemetry.dropEvents += 1;
  telemetry.droppedFrames += frameCount;
}

function trimQueue() {
  let maxFrames = bufferedFramesFor(effectiveBufferMs(mode.ws.maxBufferMs));
  if (queuedFrames <= maxFrames) {
    return;
  }

  increaseAdaptiveBuffer();
  maxFrames = bufferedFramesFor(effectiveBufferMs(mode.ws.maxBufferMs));
  if (queuedFrames <= maxFrames) {
    return;
  }

  const emergencyTargetFrames = bufferedFramesFor(effectiveBufferMs(mode.ws.targetBufferMs + mode.ws.emergencyTrimMs));
  const droppedFrames = shiftQueuedFrames(Math.max(1, queuedFrames - emergencyTargetFrames));
  if (droppedFrames > 0) {
    playbackCursor = 0;
    recordHardDrop(droppedFrames);
  }
}

function peekQueuedFrameSample(relativeFrame, channel) {
  if (queuedFrames <= 0 || relativeFrame >= queuedFrames || ringCapacityFrames <= 0) {
    return lastSamples[channel] ?? 0;
  }

  const frameIndex = (ringReadFrame + relativeFrame) % ringCapacityFrames;
  return ringBuffer[(frameIndex * channels) + channel] / 32768;
}

function beginHold() {
  for (let channel = 0; channel < channels; channel += 1) {
    holdSamples[channel] = lastSamples[channel] ?? 0;
  }
  holdDecay = 1;
}

function fillGap(outputs, frameCount, startFrame = 0, startChannel = 0) {
  for (let frame = startFrame; frame < frameCount; frame += 1) {
    for (let channel = frame === startFrame ? startChannel : 0; channel < channels; channel += 1) {
      if (!hasPlayedAudio || holdDecay <= 0.0001) {
        outputs[channel][frame] = 0;
        continue;
      }

      outputs[channel][frame] = holdSamples[channel] * holdDecay;
    }

    if (holdDecay > 0.0001) {
      holdDecay *= 0.994;
    }
  }
}

function handleUnderrun(outputs, frameCount, startFrame, startChannel = 0) {
  buffering = true;
  telemetry.underruns += 1;
  increaseAdaptiveBuffer();
  playbackCursor = 0;
  beginHold();
  fillGap(outputs, frameCount, startFrame, startChannel);
}

function computePlaybackStep() {
  const targetFrames = bufferedFramesFor(effectiveBufferMs(mode.ws.targetBufferMs));
  const correctionWindowFrames = bufferedFramesFor(mode.ws.rateAdjustWindowMs);
  const queueErrorFrames = queuedFrames - targetFrames;
  const nominalBaseStep = outputSampleRate > 0 ? sourceSampleRate / outputSampleRate : 1;
  const baseStep = outputSampleRate > 0 ? estimatedSourceSampleRate / outputSampleRate : nominalBaseStep;
  const positiveAdjustment = Math.max(0, queueErrorFrames / correctionWindowFrames);
  const negativeAdjustment = Math.min(0, queueErrorFrames / correctionWindowFrames);
  const overflowFrames = Math.max(0, queueErrorFrames - bufferedFramesFor(8));
  const burstCatchUp = overflowFrames > 0
    ? Math.min(0.01, overflowFrames / bufferedFramesFor(1200))
    : 0;
  const adjustment = Math.max(
    -mode.ws.maxRateAdjust,
    Math.min(mode.ws.maxRateAdjust + 0.01, positiveAdjustment + burstCatchUp) + negativeAdjustment
  );
  const playbackStep = baseStep + adjustment;
  const totalRateAdjust = nominalBaseStep > 0 ? (playbackStep / nominalBaseStep) - 1 : adjustment;

  telemetry.lastRateAdjust = totalRateAdjust;
  telemetry.maxRateAdjust = Math.max(telemetry.maxRateAdjust, Math.abs(totalRateAdjust));

  return playbackStep;
}

async function ensureAudioGraph() {
  if (audioContext) {
    return;
  }

  channels = Math.max(1, Math.min(sessionInfo?.channels ?? 2, 2));
  sourceSampleRate = sessionInfo?.sampleRate ?? 48000;
  resetSourceClockTracking();
  lastSamples = new Float32Array(channels);
  holdSamples = new Float32Array(channels);

  audioContext = new AudioContext({ sampleRate: sourceSampleRate, latencyHint: 'interactive' });
  outputSampleRate = audioContext.sampleRate || sourceSampleRate;
  mediaDestination = audioContext.createMediaStreamDestination();
  audioEl.srcObject = mediaDestination.stream;

  preampNode = audioContext.createGain();
  bassFilter = audioContext.createBiquadFilter();
  midFilter = audioContext.createBiquadFilter();
  trebleFilter = audioContext.createBiquadFilter();

  bassFilter.type = 'lowshelf';
  bassFilter.frequency.value = 180;
  midFilter.type = 'peaking';
  midFilter.frequency.value = 1400;
  midFilter.Q.value = 0.9;
  trebleFilter.type = 'highshelf';
  trebleFilter.frequency.value = 4200;

  preampNode.connect(bassFilter);
  bassFilter.connect(midFilter);
  midFilter.connect(trebleFilter);
  trebleFilter.connect(mediaDestination);
  applyEqSettings();

  processor = audioContext.createScriptProcessor(mode.ws.processorFrames, 0, channels);
  processor.connect(preampNode);
  processor.onaudioprocess = (event) => {
    telemetry.lastRenderAtMs = performance.now();

    const outputs = [];
    const frameCount = event.outputBuffer.length;
    const resumeThreshold = hasPlayedAudio
      ? bufferedFramesFor(effectiveBufferMs(mode.ws.resumeBufferMs))
      : bufferedFramesFor(effectiveBufferMs(mode.ws.startBufferMs));

    for (let channel = 0; channel < channels; channel += 1) {
      outputs[channel] = event.outputBuffer.getChannelData(channel);
    }

    if (buffering && queuedFrames < resumeThreshold) {
      fillGap(outputs, frameCount);
      return;
    }

    buffering = false;
    const playbackStep = computePlaybackStep();

    for (let frame = 0; frame < frameCount; frame += 1) {
      if (queuedFrames <= 0) {
        handleUnderrun(outputs, frameCount, frame);
        return;
      }

      const interpolation = playbackCursor;
      for (let channel = 0; channel < channels; channel += 1) {
        const currentSample = peekQueuedFrameSample(0, channel);
        const nextSample = queuedFrames > 1 ? peekQueuedFrameSample(1, channel) : currentSample;
        const sample = currentSample + ((nextSample - currentSample) * interpolation);
        outputs[channel][frame] = sample;
        lastSamples[channel] = sample;
      }

      hasPlayedAudio = true;
      holdDecay = 0;
      playbackCursor += playbackStep;

      const framesToConsume = Math.floor(playbackCursor);
      if (framesToConsume > 0) {
        const consumedFrames = shiftQueuedFrames(framesToConsume);
        playbackCursor -= consumedFrames;

        if (consumedFrames < framesToConsume) {
          playbackCursor = 0;
          handleUnderrun(outputs, frameCount, frame + 1);
          return;
        }
      }
    }

    settleAdaptiveBuffer();
  };

  updateTelemetryUi();
}

function handleStatusMessage(message) {
  if (message.type !== 'status') {
    return;
  }

  setState(message.streaming ? `Streaming / ${message.connectedClients} client(s)` : 'Connected');
}

function handleHelloMessage(message) {
  if (message.type !== 'hello') {
    return;
  }

  sessionInfo = message;
  channels = Math.max(1, Math.min(sessionInfo?.channels ?? channels, 2));
  sourceSampleRate = sessionInfo?.sampleRate ?? sourceSampleRate;
  if (telemetry.receivedFrames === 0) {
    resetSourceClockTracking();
  }
  updateTelemetryUi();
}

function readFrameTimestampUs(packet) {
  if (typeof packet.getBigUint64 === 'function') {
    return Number(packet.getBigUint64(0, true));
  }

  const low = packet.getUint32(0, true);
  const high = packet.getUint32(4, true);
  return (high * 4294967296) + low;
}
function handleBinaryMessage(payload) {
  const packet = new DataView(payload);
  const timestampUs = readFrameTimestampUs(packet);
  const sequence = packet.getUint32(8, true);
  const payloadLength = packet.getUint32(12, true);
  const rawSampleCount = Math.floor(payloadLength / 2);
  const usableSampleCount = rawSampleCount - (rawSampleCount % channels);
  if (usableSampleCount <= 0) {
    return;
  }

  const samples = new Int16Array(payload, 16, usableSampleCount);
  const frameCount = usableSampleCount / channels;

  if (telemetry.lastSequence !== null && sequence > telemetry.lastSequence + 1) {
    telemetry.sequenceGaps += sequence - telemetry.lastSequence - 1;
  }

  updateSourceClockEstimate(sequence, timestampUs, frameCount);

  telemetry.lastSequence = sequence;
  telemetry.receivedFrames += 1;
  telemetry.receivedBytes += payloadLength;
  telemetry.lastFrameAtMs = performance.now();

  writeQueuedSamples(samples, frameCount);
  telemetry.maxQueueMs = Math.max(telemetry.maxQueueMs, framesToMs(queuedFrames));
  trimQueue();
}

function scheduleReconnect() {
  if (!started || reconnectTimer) {
    return;
  }

  telemetry.reconnects += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    if (started) {
      void connectStream(false).catch(() => {
        if (started) {
          scheduleReconnect();
        }
      });
    }
  }, mode.ws.reconnectDelayMs);
}

function connectStream(initialConnect) {
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;

    socket = new WebSocket(mode.endpoint());
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      opened = true;
      telemetry.openEvents += 1;
      setState('Connected');
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        handleStatusMessage(message);
        handleHelloMessage(message);
        return;
      }

      handleBinaryMessage(event.data);
    });

    socket.addEventListener('close', () => {
      socket = undefined;

      if (!opened && initialConnect && !settled) {
        settled = true;
        reject(new Error('The receiver stream closed before it connected.'));
        return;
      }

      if (!started) {
        return;
      }

      setState('Reconnecting...');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      telemetry.socketErrors += 1;
      if (initialConnect && !opened && !settled) {
        settled = true;
        reject(new Error('Unable to reach the receiver stream.'));
      }
    });
  });
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = undefined;
    });
  } catch {
    // Ignore wake lock failures.
  }
}

async function releaseWakeLock() {
  if (!wakeLock) {
    return;
  }

  try {
    await wakeLock.release();
  } catch {
    // Ignore release failures.
  }

  wakeLock = undefined;
}

function applyMediaSession() {
  if (!('mediaSession' in navigator)) {
    return;
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'WifiAudioProjector',
      artist: 'Receiver',
      album: mode.label
    });
    navigator.mediaSession.playbackState = started ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => {
      if (!started) {
        void startPlayback();
      }
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      void stopPlayback();
    });
    navigator.mediaSession.setActionHandler('stop', () => {
      void stopPlayback();
    });
  } catch {
    // Ignore media session failures.
  }
}

function formatLatencyValue(seconds) {
  return Number.isFinite(seconds) ? `${(seconds * 1000).toFixed(1)} ms` : 'n/a';
}

function formatRuntimeValue() {
  if (!telemetry.startedAtMs) {
    return '0.0 s';
  }

  return `${((performance.now() - telemetry.startedAtMs) / 1000).toFixed(1)} s`;
}

function formatRateAdjustValue() {
  const sign = telemetry.lastRateAdjust >= 0 ? '+' : '';
  return `${sign}${(telemetry.lastRateAdjust * 100).toFixed(3)}%`;
}

function formatMetaBlock() {
  const queueMs = framesToMs(queuedFrames).toFixed(1);
  const peakQueueMs = telemetry.maxQueueMs.toFixed(1);
  const softTrimMs = framesToMs(telemetry.softTrimFrames).toFixed(3);
  const droppedMs = framesToMs(telemetry.droppedFrames).toFixed(3);
  const kbps = telemetry.startedAtMs && performance.now() > telemetry.startedAtMs
    ? ((telemetry.receivedBytes * 8) / ((performance.now() - telemetry.startedAtMs) / 1000) / 1000).toFixed(1)
    : '0.0';
  const secondsSinceFrame = telemetry.lastFrameAtMs
    ? `${((performance.now() - telemetry.lastFrameAtMs) / 1000).toFixed(2)} s`
    : 'n/a';
  const baseLatency = audioContext?.baseLatency;
  const outputLatency = typeof audioContext?.outputLatency === 'number' ? audioContext.outputLatency : Number.NaN;
  const sessionText = sessionInfo
    ? `${sessionInfo.codec.toUpperCase()} / ${sessionInfo.sampleRate} Hz / ${sessionInfo.channels} ch / ${sessionInfo.bitsPerSample}-bit / ${sessionInfo.frameDurationMs} ms`
    : 'Session unavailable';

  return [
    `${mode.detail}`,
    `${mode.note}`,
    `Runtime: ${formatRuntimeValue()}`,
    `Signal Path: ${mode.pathLabel}`,
    `Session: ${sessionText}`,
    `Queue: ${queueMs} ms`,
    `Peak: ${peakQueueMs} ms`,
    `Boost: +${adaptiveBuffer.boostMs} ms`,
    `Underruns: ${telemetry.underruns}`,
    `Soft Trims: ${telemetry.softTrimEvents} (${softTrimMs} ms)`,
    `Hard Drops: ${telemetry.dropEvents} (${droppedMs} ms)`,
    `Reconnects: ${telemetry.reconnects}`,
    `Gaps: ${telemetry.sequenceGaps}`,
    `Frames: ${telemetry.receivedFrames}`,
    `Opens: ${telemetry.openEvents}`,
    `Socket Errors: ${telemetry.socketErrors}`,
    `Rate: ${kbps} kbps`,
    `Drift Match: ${formatRateAdjustValue()}`,
    `Source Rate: ${sourceSampleRate} Hz`,
    `Estimated Source Pace: ${estimatedSourceSampleRate.toFixed(1)} Hz`,
    `Output Rate: ${outputSampleRate} Hz`,
    `Audio Base Latency: ${formatLatencyValue(baseLatency)}`,
    `Audio Output Latency: ${formatLatencyValue(outputLatency)}`,
    `Last Frame: ${secondsSinceFrame}`,
    `Endpoint: ${mode.endpoint()}`
  ].join('\n');
}

function updateTelemetryUi() {
  if (!metaBlockEl) {
    return;
  }

  metaBlockEl.textContent = formatMetaBlock();
}

async function startPlayback() {
  toggleButton.disabled = true;
  setState(`Starting ${mode.label}...`);
  resetTelemetryCounters();
  clearQueue();
  updateTelemetryUi();

  try {
    await loadSession();
    await ensureAudioGraph();
    await audioContext.resume();
    await audioEl.play().catch(() => undefined);
    await requestWakeLock();
    await connectStream(true);
    started = true;
    setPlayingUi(true);
    applyMediaSession();
    updateTelemetryUi();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start audio';
    await stopPlayback({ preserveUi: true });
    setState(`Error: ${message}`);
    updateTelemetryUi();
  } finally {
    toggleButton.disabled = false;
  }
}

async function stopPlayback(options = {}) {
  const { preserveUi = false } = options;
  started = false;

  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  socket?.close();
  socket = undefined;
  clearQueue();
  setPlayingUi(false);

  if (!preserveUi) {
    setState('Stopped');
  }

  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = undefined;
  }

  if (preampNode) {
    preampNode.disconnect();
    preampNode = undefined;
  }

  if (bassFilter) {
    bassFilter.disconnect();
    bassFilter = undefined;
  }

  if (midFilter) {
    midFilter.disconnect();
    midFilter = undefined;
  }

  if (trebleFilter) {
    trebleFilter.disconnect();
    trebleFilter = undefined;
  }

  const closeContext = audioContext?.state !== 'closed'
    ? audioContext.close().catch(() => undefined)
    : Promise.resolve();

  audioContext = undefined;
  mediaDestination = undefined;
  estimatedSourceSampleRate = sourceSampleRate;
  outputSampleRate = sourceSampleRate;
  lastSourceTimestampUs = null;
  lastSourceTimestampSequence = null;
  audioEl.pause();
  audioEl.srcObject = null;
  await releaseWakeLock();

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'paused';
    } catch {
      // Ignore media session failures.
    }
  }

  updateTelemetryUi();
  return closeContext;
}










