import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cove", {
  commitSelection: (rect: { x: number; y: number; width: number; height: number; dpr: number }) =>
    ipcRenderer.send("cove:selection-commit", rect),
  cancelSelection: () => ipcRenderer.send("cove:selection-cancel"),
});
