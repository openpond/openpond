import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { appDisplayName } from "./desktop-environment.js";

export type DesktopRecoveryActions = {
  retry: () => void;
  restart: () => void;
  openLogs: () => void;
};

export function recoveryMenuItems(actions: DesktopRecoveryActions): MenuItemConstructorOptions[] {
  return [
    { label: "Retry App", accelerator: "CommandOrControl+Shift+R", click: () => { actions.retry(); } },
    { label: "Restart App", click: () => { actions.restart(); } },
    { label: "Open Logs", click: () => { actions.openLogs(); } },
    { role: "toggleDevTools" },
  ];
}

export function configureApplicationMenu(actions: DesktopRecoveryActions): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: appDisplayName(),
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          ...recoveryMenuItems(actions),
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
      },
    ])
  );
}


export function installDesktopRecoveryShortcuts(window: BrowserWindow, actions: DesktopRecoveryActions): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "r") {
      event.preventDefault();
      actions.retry();
    } else if (process.platform !== "darwin" && input.key === "Alt") {
      event.preventDefault();
      Menu.buildFromTemplate(recoveryMenuItems(actions)).popup({ window });
    }
  });
}
