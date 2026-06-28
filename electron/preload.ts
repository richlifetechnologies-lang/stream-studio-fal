import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("isElectron", true);

contextBridge.exposeInMainWorld("electronAPI", {
  // Update available notification
  onUpdateAvailable: (
    callback: (info: { version: string }) => void
  ) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },

  // Download progress (0–100)
  onDownloadProgress: (
    callback: (info: { percent: number; transferred: number; total: number }) => void
  ) => {
    ipcRenderer.on("download-progress", (_event, info) => callback(info));
  },

  // Update fully downloaded — ready to install
  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.on("update-downloaded", () => callback());
  },

  // Trigger the download
  downloadUpdate: () => {
    ipcRenderer.send("download-update");
  },

  // Quit and install the downloaded update
  quitAndInstall: () => {
    ipcRenderer.send("quit-and-install");
  },
});
