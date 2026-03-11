let audioContext;
let workletNode;
let mediaDestination;
let sessionInfo;
let currentPeer;
let sourceConnected = false;
let activeSenderProfileId = 'balanced';

const senderProfiles = {
  balanced: {
    id: 'balanced',
    maxBufferMs: 52,
    targetBufferMs: 20,
    startBufferMs: 16,
    resumeBufferMs: 10,
    maxBitrate: 256000
  },
  aggressive: {
    id: 'aggressive',
    maxBufferMs: 32,
    targetBufferMs: 12,
    startBufferMs: 9,
    resumeBufferMs: 6,
    maxBitrate: 256000
  }
};

function getSenderProfile(profileId) {
  return senderProfiles[profileId] ?? senderProfiles.balanced;
}

async function loadSession() {
  if (sessionInfo) {
    return sessionInfo;
  }

  const response = await fetch('/session');
  sessionInfo = await response.json();
  return sessionInfo;
}

function ensureSourceConnection() {
  if (sourceConnected || !window.lowLatencySource?.onFrame || !workletNode) {
    return;
  }

  window.lowLatencySource.onFrame((payload) => {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const copy = new Uint8Array(bytes);
    workletNode.port.postMessage({ type: 'push', payload: copy.buffer }, [copy.buffer]);
  });
  sourceConnected = true;
}

function applySenderProfile(profileId) {
  const profile = getSenderProfile(profileId);
  activeSenderProfileId = profile.id;

  if (!workletNode) {
    return profile;
  }

  const channels = Math.max(1, Math.min(sessionInfo?.channels ?? 2, 2));
  workletNode.port.postMessage({
    type: 'config',
    channels,
    maxBufferMs: profile.maxBufferMs,
    targetBufferMs: profile.targetBufferMs,
    startBufferMs: profile.startBufferMs,
    resumeBufferMs: profile.resumeBufferMs
  });

  return profile;
}

async function ensureAudioGraph(profileId = 'balanced') {
  if (audioContext && mediaDestination && workletNode) {
    applySenderProfile(profileId);
    ensureSourceConnection();
    return;
  }

  const sampleRate = sessionInfo?.sampleRate ?? 48000;
  const channels = Math.max(1, Math.min(sessionInfo?.channels ?? 2, 2));

  audioContext = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  mediaDestination = audioContext.createMediaStreamDestination();
  await audioContext.audioWorklet.addModule('/sender-worklet.js');
  workletNode = new AudioWorkletNode(audioContext, 'pcm-queue-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    channelCount: channels,
    channelCountMode: 'explicit'
  });
  workletNode.connect(mediaDestination);
  applySenderProfile(profileId);
  ensureSourceConnection();
}

async function ensureSenderReady(profileId = 'balanced') {
  await loadSession();
  await ensureAudioGraph(profileId);
  await audioContext.resume();
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

function mergeFmtp(existing, updates) {
  const values = new Map();

  for (const part of existing.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim();
    if (!key) {
      continue;
    }

    values.set(key, (rawValue ?? '').trim());
  }

  for (const [key, value] of Object.entries(updates)) {
    values.set(key, value);
  }

  return [...values.entries()].map(([key, value]) => `${key}=${value}`).join(';');
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
  const fmtpUpdates = {
    stereo: '1',
    'sprop-stereo': '1',
    minptime: '10',
    maxaveragebitrate: '256000',
    maxplaybackrate: '48000',
    useinbandfec: '1',
    usedtx: '0'
  };

  if (fmtpPattern.test(sdp)) {
    sdp = sdp.replace(fmtpPattern, (_match, existing) => `a=fmtp:${payloadType} ${mergeFmtp(existing, fmtpUpdates)}`);
  } else {
    sdp = sdp.replace(new RegExp(`a=rtpmap:${payloadType} opus/48000/2`), `$&\r\na=fmtp:${payloadType} ${mergeFmtp('', fmtpUpdates)}`);
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

window.createLowLatencyAnswer = async (offer, profileId = 'balanced') => {
  const profile = getSenderProfile(profileId);
  await ensureSenderReady(profile.id);

  currentPeer?.close();
  currentPeer = new RTCPeerConnection({
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });

  const [audioTrack] = mediaDestination.stream.getAudioTracks();
  if (!audioTrack) {
    throw new Error('Sender audio track is unavailable.');
  }

  audioTrack.contentHint = 'music';
  const sender = currentPeer.addTrack(audioTrack, mediaDestination.stream);
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  parameters.encodings[0].maxBitrate = profile.maxBitrate;
  await sender.setParameters(parameters).catch(() => undefined);

  await currentPeer.setRemoteDescription(offer);
  const answer = await currentPeer.createAnswer();
  answer.sdp = tuneOpusSdp(answer.sdp);
  await currentPeer.setLocalDescription(answer);
  await waitForIceGatheringComplete(currentPeer);
  return currentPeer.localDescription.toJSON();
};

