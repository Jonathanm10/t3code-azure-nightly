import * as Electron from "electron";
import * as Schema from "effect/Schema";
import { getDesktopSchemes } from "../electron/ElectronProtocol.ts";

export class DesktopOriginMigrationError extends Schema.TaggedError<DesktopOriginMigrationError>()(
  "DesktopOriginMigrationError",
  {},
) {
  override get message() {
    return "Could not preserve Azure desktop preferences and drafts. Restart to retry.";
  }
}

export const ORIGIN_MIGRATION_PATH = "/__t3_azure_origin_migration_v1";
export const ORIGIN_MIGRATION_MARKER = "__t3_azure_origin_migration_v1";
const APP_STORAGE_PREFIXES = [
  "t3code:",
  "t3code.",
  "t3.",
  "t3:",
  "database-storage-notice-dismissed:",
];
const APP_STORAGE_KEYS = [
  "chat_thread_sidebar_width",
  "codething:renderer-state:v1",
  "codething:renderer-state:v2",
  "codething:renderer-state:v3",
  "codething:renderer-state:v4",
];

const StorageEntries = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const decodeEntries = Schema.decodeUnknownSync(StorageEntries);

function readAppStorage({
  keys,
  prefixes,
}: {
  keys: readonly string[];
  prefixes: readonly string[];
}) {
  const entries: [string, string][] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key === null || (!keys.includes(key) && !prefixes.some((prefix) => key.startsWith(prefix))))
      continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  return entries;
}

function copyMissingStorage(entries: readonly (readonly [string, string])[]) {
  for (const [key, value] of entries) {
    const existing = localStorage.getItem(key);
    if (existing === null) localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== (existing ?? value)) {
      throw new Error("Storage migration readback failed.");
    }
  }
}

export async function migrateDesktopOriginStorage(isDevelopment: boolean, signal: AbortSignal) {
  const [canonical, legacy] = getDesktopSchemes(isDevelopment);
  const urls = new Set(
    [canonical, legacy].map((scheme) => `${scheme}://app${ORIGIN_MIGRATION_PATH}`),
  );
  const protocol = Electron.session.defaultSession.protocol;
  const registered: string[] = [];
  let window: Electron.BrowserWindow | undefined;
  let completionAttempted = false;
  const cleanup = () => {
    if (window && !window.isDestroyed()) window.destroy();
    for (const scheme of registered.splice(0)) protocol.unhandle(scheme);
  };
  const onQuit = () => cleanup();
  const keepStartupAlive = () => {};
  signal.throwIfAborted();
  signal.addEventListener("abort", cleanup, { once: true });
  Electron.app.once("before-quit", onQuit);
  // Electron otherwise quits when the migration closes the only window before startup completes.
  Electron.app.on("window-all-closed", keepStartupAlive);
  try {
    for (const scheme of [canonical, legacy]) {
      protocol.handle(
        scheme,
        (request) =>
          new Response(
            request.method === "GET" && urls.has(request.url)
              ? "<!doctype html><meta charset=utf-8><title>Storage migration</title>"
              : null,
            {
              status: request.method === "GET" && urls.has(request.url) ? 200 : 404,
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy":
                  "default-src 'none'; form-action 'none'; frame-ancestors 'none'",
              },
            },
          ),
      );
      registered.push(scheme);
    }
    window = new Electron.BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        session: Electron.session.defaultSession,
      },
    });
    signal.throwIfAborted();
    const migrationWindow = window;
    const contents = migrationWindow.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const prevent = (event: Electron.Event) => event.preventDefault();
    contents.on("will-navigate", prevent);
    contents.on("will-redirect", prevent);
    contents.on("will-attach-webview", prevent);
    const load = async (url: string) => {
      signal.throwIfAborted();
      await migrationWindow.loadURL(url);
      signal.throwIfAborted();
      if (contents.getURL() !== url) throw new Error("Unexpected migration document.");
    };
    const execute = async (script: string): Promise<unknown> => {
      signal.throwIfAborted();
      const result: unknown = await contents.executeJavaScript(script);
      signal.throwIfAborted();
      return result;
    };
    const canonicalUrl = `${canonical}://app${ORIGIN_MIGRATION_PATH}`;
    await load(canonicalUrl);
    if (
      (await execute(
        `localStorage.getItem(${JSON.stringify(ORIGIN_MIGRATION_MARKER)}) === "complete"`,
      )) === true
    )
      return;
    await load(`${legacy}://app${ORIGIN_MIGRATION_PATH}`);
    const entries = decodeEntries(
      await execute(
        `(${readAppStorage.toString()})(${JSON.stringify({ keys: APP_STORAGE_KEYS, prefixes: APP_STORAGE_PREFIXES })})`,
      ),
    );
    await load(canonicalUrl);
    await execute(`(${copyMissingStorage.toString()})(${JSON.stringify(entries)})`);
    Electron.session.defaultSession.flushStorageData();
    completionAttempted = true;
    await execute(`localStorage.setItem(${JSON.stringify(ORIGIN_MIGRATION_MARKER)}, "complete")`);
    Electron.session.defaultSession.flushStorageData();
  } catch (error) {
    if (completionAttempted && window && !window.isDestroyed()) {
      await window.webContents
        .executeJavaScript(`localStorage.removeItem(${JSON.stringify(ORIGIN_MIGRATION_MARKER)})`)
        .catch(() => undefined);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cleanup);
    Electron.app.removeListener("before-quit", onQuit);
    try {
      cleanup();
    } finally {
      Electron.app.removeListener("window-all-closed", keepStartupAlive);
    }
  }
}
