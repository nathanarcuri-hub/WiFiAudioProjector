# WifiAudioProjector

Live audio bridge from a PC to an iPhone over local WiFi.

## Vision

The host machine captures live system audio, publishes it on the LAN, and iPhone clients discover and play that stream through whatever output is currently connected to the phone, including AirPods and other Bluetooth headphones.

## For Now Scope

- Windows host capture via WASAPI loopback
- Electron desktop host UI
- Local Node streaming server
- Bonjour discovery on the LAN
- Browser receiver page for rapid LAN testing
- iPhone client built with SwiftUI and `AVAudioEngine`
- PCM 16-bit stereo at 48 kHz for the first end-to-end path

## Monorepo Layout

- `apps/host`: Electron + Node host app
- `packages/protocol`: shared stream protocol definitions
- `native/windows-capture-helper`: C# helper for Windows system audio capture
- `ios`: iPhone app sources and `XcodeGen` project spec
- `docs`: architecture and protocol notes

## First Manual Test

1. Install dependencies when ready.
2. Start the host app.
3. Open the receiver URL shown in the host window on your iPhone.
4. Tap `Start Audio` in Safari.
5. Confirm you hear the temporary test tone before we replace it with WASAPI loopback.

## Real Host Run Path

- `npm run start:host` builds the shared protocol package and the Electron host, then launches the host app.
- The host starts a localhost helper transport, runs the C# Windows capture helper through `dotnet`, and forwards real WASAPI loopback audio to LAN clients.
- For the first live test, open the receiver URL shown in the host window on your iPhone and tap `Start Audio` in Safari.

## Default Ports

- Helper bridge TCP: `39393`
- Host web server: `39394`

Receiver URL format:

`http://<your-pc-lan-ip>:39394/receiver`
