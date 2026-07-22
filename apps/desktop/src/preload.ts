import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openpond", {
  getConnection: () => ipcRenderer.invoke("openpond:connection"),
  browser: {
    open: (payload: unknown) => ipcRenderer.invoke("openpond:browser:open", payload),
    newTab: (payload: unknown) => ipcRenderer.invoke("openpond:browser:newTab", payload),
    selectTab: (payload: unknown) => ipcRenderer.invoke("openpond:browser:selectTab", payload),
    closeTab: (payload: unknown) => ipcRenderer.invoke("openpond:browser:closeTab", payload),
    navigate: (payload: unknown) => ipcRenderer.invoke("openpond:browser:navigate", payload),
    back: (payload: unknown) => ipcRenderer.invoke("openpond:browser:back", payload),
    forward: (payload: unknown) => ipcRenderer.invoke("openpond:browser:forward", payload),
    reload: (payload: unknown) => ipcRenderer.invoke("openpond:browser:reload", payload),
    stop: (payload: unknown) => ipcRenderer.invoke("openpond:browser:stop", payload),
    close: (payload: unknown) => ipcRenderer.invoke("openpond:browser:close", payload),
    clearData: (payload: unknown) => ipcRenderer.invoke("openpond:browser:clearData", payload),
    openExternal: (payload: unknown) => ipcRenderer.invoke("openpond:browser:openExternal", payload),
    setBounds: (payload: unknown) => ipcRenderer.invoke("openpond:browser:setBounds", payload),
    getState: (payload: unknown) => ipcRenderer.invoke("openpond:browser:getState", payload),
    diagnostics: () => ipcRenderer.invoke("openpond:browser:diagnostics"),
    snapshot: (payload: unknown) => ipcRenderer.invoke("openpond:browser:snapshot", payload),
    moveCursor: (payload: unknown) => ipcRenderer.invoke("openpond:browser:moveCursor", payload),
    click: (payload: unknown) => ipcRenderer.invoke("openpond:browser:click", payload),
    typeText: (payload: unknown) => ipcRenderer.invoke("openpond:browser:typeText", payload),
    key: (payload: unknown) => ipcRenderer.invoke("openpond:browser:key", payload),
    scroll: (payload: unknown) => ipcRenderer.invoke("openpond:browser:scroll", payload),
    onState: (callback: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on("openpond:browser:state", listener);
      return () => ipcRenderer.removeListener("openpond:browser:state", listener);
    },
    onRevealRequest: (callback: (request: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: unknown) => callback(request);
      ipcRenderer.on("openpond:browser:reveal", listener);
      return () => ipcRenderer.removeListener("openpond:browser:reveal", listener);
    },
  },
  files: {
    reveal: (payload: unknown) => ipcRenderer.invoke("openpond:file:reveal", payload),
  },
  retryStartup: () => ipcRenderer.invoke("openpond:startup:retry"),
  openLogsFolder: () => ipcRenderer.invoke("openpond:logs:open"),
  readRecentLogs: (lineLimit?: number) => ipcRenderer.invoke("openpond:logs:readRecent", { lineLimit }),
  copyRecentLogs: (lineLimit?: number) => ipcRenderer.invoke("openpond:logs:copyRecent", { lineLimit }),
  exportDiagnostics: () => ipcRenderer.invoke("openpond:diagnostics:export"),
  selectFolder: () => ipcRenderer.invoke("openpond:folder:select"),
  requestMicrophoneAccess: () => ipcRenderer.invoke("openpond:microphone:request"),
  logRendererError: (payload: unknown) => ipcRenderer.invoke("openpond:renderer:error", payload),
  minimizeWindow: () => ipcRenderer.invoke("openpond:window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("openpond:window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("openpond:window:close"),
});
