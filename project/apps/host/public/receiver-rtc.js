const stateEl = document.getElementById('state');
const sessionEl = document.getElementById('session');
const endpointEl = document.getElementById('endpoint');
const toggleButton = document.getElementById('toggle');
const audioEl = document.getElementById('audio');
const badgeEl = document.getElementById('badge');
const noteEl = document.getElementById('note');
const metaBlockEl = document.getElementById('meta-block');
const bassSliderEl = document.getElementById('bass');
const midSliderEl = document.getElementById('mid');
const trebleSliderEl = document.getElementById('treble');
const bassValueEl = document.getElementById('bass-value');
const midValueEl = document.getElementById('mid-value');
const trebleValueEl = document.getElementById('treble-value');

const eqStorageKey = 'wifi-audio-projector:eq';
const receiverProfileId = 'balanced';
const offerUrl = `${location.origin}/webrtc/offer?profile=${encodeURIComponent(receiverProfileId)}`;

const eq = loadEqSettings();
const telemetry = createTelemetry();

let sessionInfo;
let peerConnection;
let audioContext;
let mediaElementSource;
let preampNode;
let bassFilter;
let midFilter;
let trebleFilter;
let statsTimer;
let wakeLock;
let playing = false;

endpointEl.textContent = offerUrl;
audioEl.autoplay = true;
audioEl.playsInline = true;
audioEl.controls = true;

updateEqUi();
updateTelemetryUi();
setButtonState(false);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

bassSliderEl?.addEventListener('input', () => updateEqBand('bass', Number(bassSliderEl.value)));
midSliderEl?.addEventListener('input', () => updateEqBand('mid', Number(midSliderEl.value)));
trebleSliderEl?.addEventListener('input', () => updateEqBand('treble', Number(trebleSliderEl.value)));

toggleButton.addEventListener('click', async () => {
  if (playing) {
    await stopPlayback();
    return;
  }

  await startPlayback();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && playing) {
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
  void stopPlayback({ preserveUi: true });
});

function createTelemetry() {
  return {
    startedAtMs: 0,
    connectionState: 'Idle',
    iceConnectionState: 'new',
    bytesReceived: 0,
    bitrateKbps: 0,
    packetsLost: 0,
    packetsReceived: 0,
    jitterMs: Number.NaN,
    concealedSamples: 0,
    removedSamplesForAcceleration: 0,
    insertedSamplesForDeceleration: 0,
    framesDecoded: 0,
    codec: 'n/a'
  };
}

function resetTelemetry() {
  telemetry.startedAtMs = performance.now();
  telemetry.connectionState = 'Negotiating';
  telemetry.iceConnectionState = 'new';
  telemetry.bytesReceived = 0;
  telemetry.bitrateKbps = 0;
  telemetry.packetsLost = 0;
  telemetry.packetsReceived = 0;
  telemetry.jitterMs = Number.NaN;
  telemetry.concealedSamples = 0;
  telemetry.removedSamplesForAcceleration = 0;
  telemetry.insertedSamplesForDeceleration = 0;
  telemetry.framesDecoded = 0;
  telemetry.codec = 'n/a';
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
  sessionEl.textContent = `${sessionInfo.codec.toUpperCase()} / ${sessionInfo.sampleRate} Hz / ${sessionInfo.channels} channels / ${sessionInfo.bitsPerSample}-bit / ${sessionInfo.frameDurationMs} ms frames`;
  updateTelemetryUi();
  return sessionInfo;
}

function setState(text) {
  stateEl.textContent = text;
}

function setButtonState(isPlaying) {
  toggleButton.textContent = isPlaying ? 'Stop Stream' : 'Play Stream';
  toggleButton.classList.toggle('stop', isPlaying);
  badgeEl.textContent = isPlaying ? 'Live' : 'Standby';
  badgeEl.classList.toggle('live', isPlaying);
}

async function ensureAudioGraph() {
  if (audioContext) {
    return;
  }

  audioContext = new AudioContext({ latencyHint: 'interactive' });
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
  trebleFilter.connect(audioContext.destination);

  applyEqSettings();
}

function attachMediaElementSource() {
  if (!audioContext || mediaElementSource) {
    return;
  }

  mediaElementSource = audioContext.createMediaElementSource(audioEl);
  mediaElementSource.connect(preampNode);
}

function tuneOpusSdp(sdp) {
  if (!sdp) {
    return sdp;
  }

  const payloadMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!payloadMatch) {
    return sdp;
  }

  const payloadType = payloadMatch[1];
  const fmtpPattern = new RegExp(`a=fmtp:${payloadType} ([^\\r\\n]*)`);
  const preferred = 'stereo=1;sprop-stereo=1;minptime=10;maxaveragebitrate=256000;maxplaybackrate=48000;useinbandfec=1;usedtx=0';

  if (fmtpPattern.test(sdp)) {
    sdp = sdp.replace(fmtpPattern, `a=fmtp:${payloadType} ${preferred}`);
  } else {
    sdp = sdp.replace(new RegExp(`a=rtpmap:${payloadType} opus/48000/2`), `$&\r\na=fmtp:${payloadType} ${preferred}`);
  }

  if (/a=ptime:/m.test(sdp)) {
    sdp = sdp.replace(/a=ptime:\d+/m, 'a=ptime:10');
  } else {
    sdp = sdp.replace(/(m=audio .*\r\n)/, '$1a=ptime:10\r\n');
  }

  if (/a=maxptime:/m.test(sdp)) {
    sdp = sdp.replace(/a=maxptime:\d+/m, 'a=maxptime:10');
  } else {
    sdp = sdp.replace(/(a=ptime:10\r\n)/, '$1a=maxptime:10\r\n');
  }

  return sdp;
}

function waitForIceGatheringComplete(connection) {
  if (connection.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handleChange = () => {
      if (connection.iceGatheringState === 'complete') {
        connection.removeEventListener('icegatheringstatechange', handleChange);
        resolve();
      }
    };

    connection.addEventListener('icegatheringstatechange', handleChange);
  });
}

function formatLatencyValue(milliseconds) {
  return Number.isFinite(milliseconds) ? `${milliseconds.toFixed(1)} ms` : 'n/a';
}

function formatRuntimeValue() {
  if (!telemetry.startedAtMs) {
    return '0.0 s';
  }

  return `${((performance.now() - telemetry.startedAtMs) / 1000).toFixed(1)} s`;
}

function formatMetaBlock() {
  const sessionText = sessionInfo
    ? `${sessionInfo.codec.toUpperCase()} / ${sessionInfo.sampleRate} Hz / ${sessionInfo.channels} ch / ${sessionInfo.bitsPerSample}-bit / ${sessionInfo.frameDurationMs} ms`
    : 'Session unavailable';

  return [
    'WebRTC audio path with browser-managed jitter handling.',
    `Runtime: ${formatRuntimeValue()}`,
    `Signal Path: WebRTC / Opus`,
    `Session: ${sessionText}`,
    `State: ${telemetry.connectionState}`,
    `ICE: ${telemetry.iceConnectionState}`,
    `Bitrate: ${telemetry.bitrateKbps.toFixed(1)} kbps`,
    `Packets: ${telemetry.packetsReceived}`,
    `Lost: ${telemetry.packetsLost}`,
    `Jitter: ${formatLatencyValue(telemetry.jitterMs)}`,
    `Concealed Samples: ${telemetry.concealedSamples}`,
    `Stretch Drops: ${telemetry.removedSamplesForAcceleration}`,
    `Stretch Inserts: ${telemetry.insertedSamplesForDeceleration}`,
    `Frames Decoded: ${telemetry.framesDecoded}`,
    `Codec: ${telemetry.codec}`,
    `Audio Context Rate: ${audioContext?.sampleRate ?? 'n/a'} Hz`,
    `Endpoint: ${offerUrl}`
  ].join('\n');
}

function updateTelemetryUi() {
  if (!metaBlockEl) {
    return;
  }

  metaBlockEl.textContent = formatMetaBlock();
}

async function pollStats() {
  if (!peerConnection) {
    return;
  }

  try {
    const stats = await peerConnection.getStats();
    let inbound;
    let codec;

    for (const report of stats.values()) {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        inbound = report;
        if (report.codecId) {
          codec = stats.get(report.codecId);
        }
        break;
      }
    }

    if (!inbound) {
      updateTelemetryUi();
      return;
    }

    const nextBytesReceived = Number(inbound.bytesReceived ?? telemetry.bytesReceived);
    const nowMs = performance.now();

    if (telemetry.startedAtMs && telemetry.bytesReceived > 0 && nextBytesReceived >= telemetry.bytesReceived) {
      const elapsedMs = Math.max(1, nowMs - telemetry.startedAtMs);
      telemetry.bitrateKbps = (nextBytesReceived * 8) / elapsedMs;
    }

    telemetry.bytesReceived = nextBytesReceived;
    telemetry.packetsLost = Number(inbound.packetsLost ?? telemetry.packetsLost);
    telemetry.packetsReceived = Number(inbound.packetsReceived ?? telemetry.packetsReceived);
    telemetry.jitterMs = typeof inbound.jitter === 'number' ? inbound.jitter * 1000 : telemetry.jitterMs;
    telemetry.concealedSamples = Number(inbound.concealedSamples ?? telemetry.concealedSamples);
    telemetry.removedSamplesForAcceleration = Number(
      inbound.removedSamplesForAcceleration ?? telemetry.removedSamplesForAcceleration
    );
    telemetry.insertedSamplesForDeceleration = Number(
      inbound.insertedSamplesForDeceleration ?? telemetry.insertedSamplesForDeceleration
    );
    telemetry.framesDecoded = Number(inbound.framesDecoded ?? telemetry.framesDecoded);
    telemetry.codec = codec?.mimeType ?? telemetry.codec;
    updateTelemetryUi();
  } catch {
    updateTelemetryUi();
  }
}

function startStatsPolling() {
  stopStatsPolling();
  statsTimer = window.setInterval(() => {
    void pollStats();
  }, 1000);
}

function stopStatsPolling() {
  if (!statsTimer) {
    return;
  }

  window.clearInterval(statsTimer);
  statsTimer = undefined;
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
      album: 'WebRTC'
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => {
      if (!playing) {
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

function handleConnectionStateChange(connection) {
  telemetry.connectionState = connection.connectionState || 'unknown';
  telemetry.iceConnectionState = connection.iceConnectionState || 'unknown';

  switch (connection.connectionState) {
    case 'connecting':
      setState('Connecting...');
      noteEl.textContent = 'Negotiating the low-latency audio path.';
      break;
    case 'connected':
      setState('Connected');
      noteEl.textContent = 'You are hearing the live WebRTC path.';
      break;
    case 'failed':
      setState('Connection failed');
      noteEl.textContent = 'The direct audio path failed to hold.';
      break;
    case 'disconnected':
      setState('Disconnected');
      noteEl.textContent = 'The stream disconnected.';
      break;
    case 'closed':
      if (!playing) {
        noteEl.textContent = 'Tap play to reconnect to the direct low-latency audio path.';
      }
      break;
    default:
      break;
  }

  updateTelemetryUi();
}

async function startPlayback() {
  toggleButton.disabled = true;
  resetTelemetry();
  updateTelemetryUi();
  setState('Negotiating low-latency path...');
  noteEl.textContent = 'Preparing the direct path from your PC to this receiver.';

  try {
    await loadSession();
    await ensureAudioGraph();
    await audioContext.resume();
    await requestWakeLock();

    const connection = new RTCPeerConnection({
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    peerConnection = connection;

    const transceiver = connection.addTransceiver('audio', { direction: 'recvonly' });
    if ('jitterBufferTarget' in transceiver.receiver) {
      try {
        transceiver.receiver.jitterBufferTarget = 20;
      } catch {
        // Safari may ignore this hint.
      }
    }
    if ('playoutDelayHint' in transceiver.receiver) {
      try {
        transceiver.receiver.playoutDelayHint = 0.02;
      } catch {
        // Ignore unsupported playout delay hints.
      }
    }

    connection.ontrack = async (event) => {
      const [stream] = event.streams;
      audioEl.srcObject = stream;
      attachMediaElementSource();
      await audioEl.play().catch(() => undefined);
      setState('Playing');
      noteEl.textContent = 'You are hearing the live WebRTC path.';
      void pollStats();
    };

    connection.onconnectionstatechange = () => {
      handleConnectionStateChange(connection);
    };

    connection.oniceconnectionstatechange = () => {
      handleConnectionStateChange(connection);
    };

    const offer = await connection.createOffer({ offerToReceiveAudio: true });
    offer.sdp = tuneOpusSdp(offer.sdp);
    await connection.setLocalDescription(offer);
    await waitForIceGatheringComplete(connection);

    const response = await fetch(offerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connection.localDescription)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Negotiation failed' }));
      throw new Error(error.error ?? 'Negotiation failed');
    }

    const answer = await response.json();
    answer.sdp = tuneOpusSdp(answer.sdp);
    await connection.setRemoteDescription(answer);
    playing = true;
    setButtonState(true);
    applyMediaSession();
    startStatsPolling();
    setState('Connecting...');
    noteEl.textContent = 'Waiting for the transport to come up.';
    updateTelemetryUi();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start low-latency stream';
    await stopPlayback({ preserveUi: true });
    setState(`Error: ${message}`);
    noteEl.textContent = 'The direct path did not come up cleanly.';
    updateTelemetryUi();
  } finally {
    toggleButton.disabled = false;
  }
}

async function stopPlayback(options = {}) {
  const { preserveUi = false } = options;

  playing = false;
  stopStatsPolling();
  peerConnection?.close();
  peerConnection = undefined;
  audioEl.pause();
  audioEl.srcObject = null;
  setButtonState(false);

  if (!preserveUi) {
    setState('Stopped');
    noteEl.textContent = 'Tap play to reconnect to the direct low-latency audio path.';
  }

  await releaseWakeLock();

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'paused';
    } catch {
      // Ignore media session failures.
    }
  }

  updateTelemetryUi();
}

loadSession().catch(() => {
  sessionEl.textContent = 'Session unavailable';
  updateTelemetryUi();
});

