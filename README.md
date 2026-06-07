# WifiAudioProjector (WAP)

Live audio bridge from a PC to another device over local WiFi.

<img src="wap_icon.png" width="180">

<img src="wap.png" width="700">

## Vision

WifiAudioProjector lets a host PC capture live system audio and project it over the local WiFi network. A phone, tablet, laptop, or other device on the same WiFi can connect using the QR code shown in the app and play the stream through whatever audio output that device is using, including Bluetooth headphones.

The goal is simple: use another device as a wireless audio receiver for your PC.

## How to use it

1. Run `WifiAudioProjector.exe`.
2. The app will open and display a receiver URL and QR code.
3. Make sure your receiver device is connected to the same WiFi network as the host PC.
4. Scan the QR code with the receiver device.
5. Open the receiver page in the device browser.
6. Tap `Start Audio` on the receiver device.
7. Audio from the host PC should begin playing on the receiver device.

> NOTE: Opening the receiver on the same machine that is hosting the stream can create an infinite feedback loop.

## Closing the app

WifiAudioProjector minimizes to the system tray when the main window is closed.

To fully exit the app:

1. Right click the tray icon.
2. Select `Quit`.

## Known issues

1. Playback may stutter if the host computer is under heavy load.
2. Audio quality is not perfect because some quality was sacrificed for lower latency.
3. Receiver playback is browser based, even though the host app is a standalone portable `.exe`.

## Notes

WifiAudioProjector is designed for local network use. The host PC and receiver device must be on the same WiFi network.

This app is not designed to be exposed to the public internet. Port forwarding the app outside your network is your choice, but it is not the intended or supported setup.

---

## Support

If you like this project, you can support me here:

[Buy me a coffee](https://buymeacoffee.com/nathanarcuri)
