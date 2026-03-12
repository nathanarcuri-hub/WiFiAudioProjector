# WifiAudioProjector, AKA "WAP"

Live audio bridge from a PC to another device over local WiFi.

## Vision

The host machine captures live system audio, publishes it on the LAN, and receiver device's discover and play that stream through whatever output is currently connected to the receiver device, including Bluetooth headphones.

## How to use it:

1. Run "Start WifiAudioProjector.bat".
2. Initial run will check for the required dependencies, downloading them if needed.
3. Host window will display the receiver URL, which you can open in a web browser on your receiver device or whatever other device. (Opening and running on same machine will create infinite feedback loop.)
4. Tap `Start Audio` from the receiver device.
   
## For Now Scope

- Windows host capture via WASAPI loopback
- Electron desktop host UI
- Local Node streaming server
- Bonjour discovery on the LAN
- Browser receiver page for rapid LAN testing
- Receiver client built with AVAudioEngine
- PCM 16-bit stereo at 48 kHz for the first end-to-end path

## Monorepo Layout

- `apps/host`: Electron + Node host app
- `packages/protocol`: shared stream protocol definitions
- `native/windows-capture-helper`: C# helper for Windows system audio capture
- `docs`: architecture and protocol notes

## Real Host Run Path

- `npm run start:host` builds the shared protocol package and the Electron host, then launches the host app.
- The host starts a localhost helper transport, runs the C# Windows capture helper through `dotnet`, and forwards real WASAPI loopback audio to LAN clients.
- For the first live test, open the receiver URL shown in the host window on your receiver device in a web browser and tap `Start Audio`.

## Default Ports

- Helper bridge TCP: `39393`
- Host web server: `39394`

Receiver URL format:

`http://<your-pc-lan-ip>:39394/receiver`
