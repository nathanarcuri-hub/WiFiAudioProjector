import wrtc, {
  type MediaStreamTrack,
  type RTCPeerConnection,
  type RTCRtpSender,
  type RTCSessionDescription
} from "@roamhq/wrtc";
import type { StreamSession } from "@wifi-audio-projector/protocol";

type WebRtcDescription = {
  type: string;
  sdp: string;
};

type SenderProfile = {
  id: string;
  maxBitrate: number;
};

type ManagedPeer = {
  connection: RTCPeerConnection;
  streamTrack: MediaStreamTrack;
  reconnectTimer?: NodeJS.Timeout;
};

const senderProfiles: Record<string, SenderProfile> = {
  balanced: {
    id: "balanced",
    maxBitrate: 256_000
  },
  aggressive: {
    id: "aggressive",
    maxBitrate: 256_000
  }
};

function getSenderProfile(profileId?: string): SenderProfile {
  return senderProfiles[profileId ?? ""] ?? senderProfiles.balanced;
}

function mergeFmtp(existing: string, updates: Record<string, string>): string {
  const values = new Map<string, string>();

  for (const part of existing.split(";")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim();
    if (!key) {
      continue;
    }

    values.set(key, (rawValue ?? "").trim());
  }

  for (const [key, value] of Object.entries(updates)) {
    values.set(key, value);
  }

  return [...values.entries()].map(([key, value]) => `${key}=${value}`).join(";");
}

function tuneOpusSdp(sdp: string | null | undefined, maxBitrate: number): string {
  if (!sdp) {
    return "";
  }

  const payloadMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!payloadMatch) {
    return sdp;
  }

  const payloadType = payloadMatch[1];
  const fmtpPattern = new RegExp(`a=fmtp:${payloadType} ([^\\r\\n]*)`);
  const fmtpUpdates = {
    stereo: "1",
    "sprop-stereo": "1",
    minptime: "10",
    maxaveragebitrate: String(maxBitrate),
    maxplaybackrate: "48000",
    useinbandfec: "1",
    usedtx: "0"
  };

  if (fmtpPattern.test(sdp)) {
    sdp = sdp.replace(fmtpPattern, (_match, existing) => `a=fmtp:${payloadType} ${mergeFmtp(existing, fmtpUpdates)}`);
  } else {
    sdp = sdp.replace(new RegExp(`a=rtpmap:${payloadType} opus/48000/2`), `$&\r\na=fmtp:${payloadType} ${mergeFmtp("", fmtpUpdates)}`);
  }

  return sdp;
}

function waitForIceGatheringComplete(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handleChange = () => {
      if (connection.iceGatheringState === "complete") {
        connection.removeEventListener("icegatheringstatechange", handleChange);
        resolve();
      }
    };

    connection.addEventListener("icegatheringstatechange", handleChange);
  });
}

function createSampleView(payload: Buffer): Int16Array {
  if (payload.byteOffset % Int16Array.BYTES_PER_ELEMENT === 0) {
    return new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength / Int16Array.BYTES_PER_ELEMENT);
  }

  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  return new Int16Array(copy.buffer);
}

export class NodeAudioSender {
  private readonly audioSource = new wrtc.nonstandard.RTCAudioSource();
  private readonly peers = new Set<ManagedPeer>();

  constructor(
    private readonly session: Pick<StreamSession, "sampleRate" | "channels" | "bitsPerSample" | "frameDurationMs">
  ) {}

  pushFrame(payload: Buffer): void {
    if (this.peers.size === 0) {
      return;
    }

    const bytesPerSample = this.session.bitsPerSample / 8;
    const bytesPerFrame = Math.max(1, this.session.channels * bytesPerSample);
    if (payload.byteLength === 0 || payload.byteLength % bytesPerFrame !== 0) {
      return;
    }

    const numberOfFrames = payload.byteLength / bytesPerFrame;
    if (numberOfFrames <= 0) {
      return;
    }

    this.audioSource.onData({
      samples: createSampleView(payload),
      sampleRate: this.session.sampleRate,
      bitsPerSample: this.session.bitsPerSample,
      channelCount: this.session.channels,
      numberOfFrames
    });
  }

  async createAnswer(offer: WebRtcDescription, profileId?: string): Promise<WebRtcDescription> {
    const profile = getSenderProfile(profileId);
    const connection = new wrtc.RTCPeerConnection({
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });
    const streamTrack = this.audioSource.createTrack();
    const mediaStream = new wrtc.MediaStream([streamTrack]);
    const peer: ManagedPeer = { connection, streamTrack };
    this.peers.add(peer);

    try {
      const sender = connection.addTrack(streamTrack, mediaStream);
      this.applySenderParameters(sender, profile);
      this.bindPeerLifecycle(peer);

      const descriptionType = this.toSdpType(offer.type);
      await connection.setRemoteDescription(new wrtc.RTCSessionDescription({
        type: descriptionType,
        sdp: offer.sdp
      }));
      const answer = await connection.createAnswer();
      answer.sdp = tuneOpusSdp(answer.sdp, profile.maxBitrate);
      await connection.setLocalDescription(answer);
      await waitForIceGatheringComplete(connection);

      const localDescription = connection.localDescription as RTCSessionDescription | null;
      if (!localDescription?.sdp || !localDescription.type) {
        throw new Error("Node audio sender failed to produce a WebRTC answer.");
      }

      return {
        type: localDescription.type,
        sdp: localDescription.sdp
      };
    } catch (error) {
      this.disposePeer(peer);
      throw error;
    }
  }

  close(): void {
    for (const peer of [...this.peers]) {
      this.disposePeer(peer);
    }
  }

  private bindPeerLifecycle(peer: ManagedPeer): void {
    const { connection } = peer;
    const scheduleReconnectTimeout = () => {
      if (peer.reconnectTimer) {
        clearTimeout(peer.reconnectTimer);
      }

      peer.reconnectTimer = setTimeout(() => {
        if (connection.connectionState === "disconnected" || connection.iceConnectionState === "disconnected") {
          this.disposePeer(peer);
        }
      }, 5_000);
    };

    const clearReconnectTimeout = () => {
      if (!peer.reconnectTimer) {
        return;
      }

      clearTimeout(peer.reconnectTimer);
      peer.reconnectTimer = undefined;
    };

    connection.addEventListener("connectionstatechange", () => {
      switch (connection.connectionState) {
        case "connected":
          clearReconnectTimeout();
          break;
        case "disconnected":
          scheduleReconnectTimeout();
          break;
        case "failed":
        case "closed":
          this.disposePeer(peer);
          break;
      }
    });

    connection.addEventListener("iceconnectionstatechange", () => {
      switch (connection.iceConnectionState) {
        case "connected":
        case "completed":
          clearReconnectTimeout();
          break;
        case "disconnected":
          scheduleReconnectTimeout();
          break;
        case "failed":
        case "closed":
          this.disposePeer(peer);
          break;
      }
    });
  }

  private applySenderParameters(sender: RTCRtpSender, profile: SenderProfile): void {
    const getParameters = sender.getParameters?.bind(sender);
    const setParameters = sender.setParameters?.bind(sender);
    if (!getParameters || !setParameters) {
      return;
    }

    void Promise.resolve()
      .then(async () => {
        const parameters = getParameters();
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
        parameters.encodings[0].maxBitrate = profile.maxBitrate;
        await setParameters(parameters);
      })
      .catch(() => undefined);
  }

  private disposePeer(peer: ManagedPeer): void {
    if (!this.peers.has(peer)) {
      return;
    }

    this.peers.delete(peer);
    if (peer.reconnectTimer) {
      clearTimeout(peer.reconnectTimer);
      peer.reconnectTimer = undefined;
    }

    try {
      peer.connection.close();
    } catch {
      // Ignore shutdown races.
    }
  }

  private toSdpType(type: string): "offer" | "answer" | "pranswer" | "rollback" {
    switch (type) {
      case "offer":
      case "answer":
      case "pranswer":
      case "rollback":
        return type;
      default:
        throw new Error(`Unsupported WebRTC description type '${type}'.`);
    }
  }
}
