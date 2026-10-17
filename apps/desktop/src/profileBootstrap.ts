// @effect-diagnostics nodeBuiltinImport:off - This entry must finish synchronously before main.cjs and native safeStorage initialization.
import * as NodeOS from "node:os";
import { app } from "electron";
import { initializeDesktopForkProfile } from "./app/DesktopForkProfile.ts";

initializeDesktopForkProfile({
  executablePath: process.execPath,
  homeDirectory: NodeOS.homedir(),
  isDevelopment: !app.isPackaged,
  electronVersion: process.versions.electron,
  appVersion: app.getVersion(),
  pid: process.pid,
  env: process.env,
  app,
});
