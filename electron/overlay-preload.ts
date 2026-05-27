import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cove", {
  commitSelection: (rect: { x: number; y: number; width: number; height: number; dpr: number }) =>
    ipcRenderer.send("cove:selection-commit", rect),
  cancelSelection: () => ipcRenderer.send("cove:selection-cancel"),
  setIgnoreMouseEvents: (ignore: boolean) =>
    ipcRenderer.send("cove:set-ignore-mouse-events", ignore),
  onScaleFactor: (cb: (sf: number) => void) =>
    ipcRenderer.once("overlay-scale-factor", (_e, sf) => cb(sf as number)),
});
