import { contextBridge, ipcRenderer } from "electron";

type FrameListener = (payload: Uint8Array) => void;

const frameListeners = new Set<FrameListener>();

ipcRenderer.on("low-latency-frame", (_event, payload: Uint8Array | ArrayBuffer | number[]) => {
  let bytes: Uint8Array;

  if (payload instanceof Uint8Array) {
    bytes = payload;
  } else if (payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload);
  } else {
    bytes = Uint8Array.from(payload);
  }

  for (const listener of frameListeners) {
    listener(new Uint8Array(bytes));
  }
});

contextBridge.exposeInMainWorld("lowLatencySource", {
  onFrame(listener: FrameListener) {
    frameListeners.add(listener);
    return () => {
      frameListeners.delete(listener);
    };
  }
});
