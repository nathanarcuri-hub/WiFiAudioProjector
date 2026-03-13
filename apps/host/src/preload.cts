const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

interface CaptureDevice {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  isCapturing: boolean;
}

interface CaptureState {
  mode: "follow-default" | "specific-device" | "all-active";
  selectedDeviceId: string | null;
  devices: CaptureDevice[];
  helperConnected: boolean;
}

interface CaptureSelectionCommand {
  mode: "follow-default" | "specific-device" | "all-active";
  deviceId?: string | null;
}

interface HostConsoleData {
  receiverUrl: string;
  vlcUrl: string;
  addresses: string[];
  format: string;
}

contextBridge.exposeInMainWorld("wifiAudioProjector", {
  version: "1.0.1",
  host: {
    getStatus: (): Promise<HostConsoleData> => ipcRenderer.invoke("host:get-ui-data")
  },
  capture: {
    getState: (): Promise<CaptureState> => ipcRenderer.invoke("capture:get-state"),
    updateSelection: (selection: CaptureSelectionCommand): Promise<CaptureState> => ipcRenderer.invoke("capture:update-selection", selection),
    onStateChanged: (listener: (state: CaptureState) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: CaptureState) => {
        listener(state);
      };

      ipcRenderer.on("capture:state", wrapped);
      void ipcRenderer.invoke("capture:get-state").then((state: CaptureState) => {
        listener(state);
      });

      return () => {
        ipcRenderer.removeListener("capture:state", wrapped);
      };
    }
  }
});

