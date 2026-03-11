export type AudioCodec = "pcm16";

export interface StreamSession {
  sessionId: string;
  hostName: string;
  codec: AudioCodec;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frameDurationMs: number;
}

export interface HostHelloMessage extends StreamSession {
  type: "hello";
}

export interface HostStatusMessage {
  type: "status";
  streaming: boolean;
  connectedClients: number;
}

export type ControlMessage = HostHelloMessage | HostStatusMessage;

export interface AudioFrame {
  sequence: number;
  timestampUs: bigint;
  payload: Buffer;
}

export const DEFAULT_SESSION: StreamSession = {
  sessionId: "local-dev-session",
  hostName: "WifiAudioProjector Host",
  codec: "pcm16",
  sampleRate: 48_000,
  channels: 2,
  bitsPerSample: 16,
  frameDurationMs: 10
};

export function encodeAudioFrame(frame: AudioFrame): Buffer {
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(frame.timestampUs, 0);
  header.writeUInt32LE(frame.sequence, 8);
  header.writeUInt32LE(frame.payload.length, 12);
  return Buffer.concat([header, frame.payload]);
}
