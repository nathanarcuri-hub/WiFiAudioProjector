const stateEl = document.getElementById('state');
const sessionEl = document.getElementById('session');
const endpointEl = document.getElementById('endpoint');
const toggleButton = document.getElementById('toggle');
const audioEl = document.getElementById('audio');
const badgeEl = document.getElementById('badge');
const meterEl = document.getElementById('meter');
const noteEl = document.getElementById('note');

let peerConnection;
let playing = false;
let audioActivityTimer;
const offerUrl = `${location.origin}/webrtc/offer`;
endpointEl.textContent = offerUrl;

async function loadSession() {
  const response = await fetch('/session');
  const session = await response.json();
  sessionEl.textContent = `${session.codec.toUpperCase()} • ${session.sampleRate} Hz • ${session.channels} channels • ${session.bitsPerSample}-bit • ${session.frameDurationMs} ms frames`;
}

function setButtonState(isPlaying) {
  toggleButton.textContent = isPlaying ? 'Stop Stream' : 'Play Stream';
  toggleButton.classList.toggle('stop', isPlaying);
  badgeEl.textContent = isPlaying ? 'Live' : 'Standby';
  badgeEl.classList.toggle('live', isPlaying);
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
  const preferred = 'stereo=1;sprop-stereo=1;minptime=10;maxaveragebitrate=256000;maxplaybackrate=48000;useinbandfec=0;usedtx=0';

  if (fmtpPattern.test(sdp)) {
    sdp = sdp.replace(fmtpPattern, `a=fmtp:${payloadType} ${preferred}`);
  } else {
    sdp = sdp.replace(new RegExp(`a=rtpmap:${payloadType} opus/48000/2`), `$&\r\na=fmtp:${payloadType} ${preferred}`);
  }

  if (/a=ptime:/m.test(sdp)) {
    sdp = sdp.replace(/a=ptime:\d+/m, 'a=ptime:10');
  } else {
    sdp = sdp.replace(/(m=audio .*\r\n)/, `$1a=ptime:10\r\n`);
  }

  if (/a=maxptime:/m.test(sdp)) {
    sdp = sdp.replace(/a=maxptime:\d+/m, 'a=maxptime:10');
  } else {
    sdp = sdp.replace(/(a=ptime:10\r\n)/, `$1a=maxptime:10\r\n`);
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

function pulseMeter() {
  meterEl.classList.add('active');
  window.clearTimeout(audioActivityTimer);
  audioActivityTimer = window.setTimeout(() => {
    meterEl.classList.remove('active');
  }, 220);
}

async function startPlayback() {
  toggleButton.disabled = true;
  stateEl.textContent = 'Negotiating low-latency path...';
  noteEl.textContent = 'Preparing the direct path from your PC to this receiver.';

  try {
    await loadSession();

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

    connection.ontrack = async (event) => {
      const [stream] = event.streams;
      audioEl.srcObject = stream;
      await audioEl.play().catch(() => undefined);
      stateEl.textContent = 'Playing';
      noteEl.textContent = 'You are hearing the live WebRTC path.';
      pulseMeter();
    };

    connection.onconnectionstatechange = () => {
      switch (connection.connectionState) {
        case 'connecting':
          stateEl.textContent = 'Connecting...';
          break;
        case 'connected':
          stateEl.textContent = 'Connected';
          noteEl.textContent = 'Transport connected. Audio should be near-instant now.';
          pulseMeter();
          break;
        case 'failed':
          stateEl.textContent = 'Connection failed';
          noteEl.textContent = 'The direct audio path failed to hold.';
          break;
        case 'disconnected':
          stateEl.textContent = 'Disconnected';
          noteEl.textContent = 'The stream disconnected.';
          break;
        default:
          break;
      }
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
    stateEl.textContent = 'Connecting...';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start low-latency stream';
    peerConnection?.close();
    peerConnection = undefined;
    audioEl.srcObject = null;
    playing = false;
    setButtonState(false);
    stateEl.textContent = `Error: ${message}`;
    noteEl.textContent = 'The direct path did not come up cleanly.';
  } finally {
    toggleButton.disabled = false;
  }
}

function stopPlayback() {
  playing = false;
  peerConnection?.close();
  peerConnection = undefined;
  audioEl.srcObject = null;
  setButtonState(false);
  stateEl.textContent = 'Stopped';
  noteEl.textContent = 'Tap play to reconnect to the direct low-latency audio path.';
  meterEl.classList.remove('active');
}

toggleButton.addEventListener('click', async () => {
  if (playing) {
    stopPlayback();
    return;
  }

  await startPlayback();
});

loadSession().catch(() => {
  sessionEl.textContent = 'Session unavailable';
});
setButtonState(false);


