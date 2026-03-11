import { Bonjour } from "bonjour-service";
import type { StreamSession } from "@wifi-audio-projector/protocol";

export class MdnsAdvertiser {
  private readonly bonjour = new Bonjour();
  private service?: ReturnType<Bonjour["publish"]>;

  start(port: number, session: StreamSession): void {
    this.service = this.bonjour.publish({
      name: session.hostName,
      type: 'wifiaudio',
      protocol: 'tcp',
      port,
      txt: {
        codec: session.codec,
        rate: String(session.sampleRate),
        channels: String(session.channels),
        bits: String(session.bitsPerSample)
      }
    });
  }

  stop(): void {
    this.service?.stop?.();
    this.bonjour.destroy?.();
  }
}
