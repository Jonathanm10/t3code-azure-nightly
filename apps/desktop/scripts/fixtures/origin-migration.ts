import * as NodeAssert from "node:assert/strict";
import * as NodeOS from "node:os";
import { app, BrowserWindow, protocol, session } from "electron";
import {
  ORIGIN_MIGRATION_MARKER,
  ORIGIN_MIGRATION_PATH,
  migrateDesktopOriginStorage,
} from "../../src/app/DesktopOriginMigration.ts";
import { getDesktopSchemes } from "../../src/electron/ElectronProtocol.ts";

const [profile, stage, flavor] = process.argv.slice(2);
NodeAssert.ok(profile && stage);
const development = flavor === "development";
const [canonical, legacy] = getDesktopSchemes(development);
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.disableHardwareAcceleration();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Electron fixture has no Effect runtime.
if (NodeOS.platform() === "darwin") app.setActivationPolicy("prohibited");
protocol.registerSchemesAsPrivileged(
  [canonical, legacy].map((scheme) => ({ scheme, privileges: { standard: true, secure: true } })),
);
const keepFixtureAlive = () => {};

const draft = JSON.stringify({
  text: "Bonjour à Zürich 🦊 漢字 é \\u0000 </script>",
  attachments: [
    { name: "écran-日本.png", type: "image/png", dataUrl: "data:image/png;base64,AAEC/w==" },
  ],
});
const appStorage = {
  "t3code:composer-drafts:v1": draft,
  "t3code:prompt-stash:v2": draft,
  "t3code:theme": "dark",
  "t3code:themes:v1": "{opaque custom theme}",
  "t3code:client-settings:v1": "{opaque settings}",
  "t3code:ui-state:v1": "{opaque workspace state}",
  "t3code:terminal-state:v1": "{opaque terminal state}",
  "t3code.fileExplorerOpen": "true",
  "t3code.renderMarkdown": "false",
  "t3code.renderBrowserFile": "true",
  "t3code.renderTable": "false",
  "t3code.diffFileTreeOpen": "true",
  "t3code.pullRequestFileTreeOpen": "true",
  "t3.pullRequests.preferences": "{opaque pull request settings}",
  "t3.backgroundActivity.clientId": "synthetic-client",
  "t3:chatgpt-sharing-welcome:v1": "[]",
  chat_thread_sidebar_width: "420",
  "database-storage-notice-dismissed:fixture-environment": "true",
  "codething:renderer-state:v1": '{"legacyVersion":1}',
  "codething:renderer-state:v2": '{"legacyVersion":2}',
  "codething:renderer-state:v3": '{"legacyVersion":3}',
  "codething:renderer-state:v4": '{"legacyVersion":4}',
};
const source = {
  ...appStorage,
  __clerk_client_jwt: "synthetic-do-not-copy",
  foreign: "synthetic-do-not-copy",
  chat_thread_sidebar_width_extra: "synthetic-do-not-copy",
  "codething:renderer-state:v5": "synthetic-do-not-copy",
  "codething:renderer-state:v1:credential": "synthetic-do-not-copy",
  "database-storage-notice-dismissed": "synthetic-do-not-copy",
  [ORIGIN_MIGRATION_MARKER]: "complete",
};
const destination = { "t3code:theme": "light", "destination-only": "preserved" };
const expected = {
  ...appStorage,
  ...destination,
  [ORIGIN_MIGRATION_MARKER]: "complete",
};

async function storage(scheme: string, write?: Record<string, string>, clear = false) {
  app.on("window-all-closed", keepFixtureAlive);
  const url = `${scheme}://app${ORIGIN_MIGRATION_PATH}`;
  session.defaultSession.protocol.handle(
    scheme,
    () => new Response("<!doctype html><title>Fixture</title>"),
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL(url);
    if (clear) await window.webContents.executeJavaScript("localStorage.clear()");
    if (write)
      await window.webContents.executeJavaScript(
        `Object.entries(${JSON.stringify(write)}).forEach(([key, value]) => localStorage.setItem(key, value))`,
      );
    return await window.webContents.executeJavaScript(
      "Object.fromEntries(Object.entries(localStorage))",
    );
  } finally {
    window.destroy();
    session.defaultSession.protocol.unhandle(scheme);
    app.removeListener("window-all-closed", keepFixtureAlive);
  }
}

async function migrate(label: string, signal = new AbortController().signal) {
  NodeAssert.equal(app.listeners("window-all-closed").includes(keepFixtureAlive), false);
  NodeAssert.equal(BrowserWindow.getAllWindows().length, 0);
  const listeners = app.rawListeners("window-all-closed");
  const quitListeners = app.rawListeners("before-quit");
  let quitRequested = false;
  const observeQuit = () => {
    quitRequested = true;
    process.stderr.write(`native before-quit during migration: ${label}\n`);
  };
  app.once("before-quit", observeQuit);
  try {
    await migrateDesktopOriginStorage(development, signal);
  } finally {
    app.removeListener("before-quit", observeQuit);
    NodeAssert.equal(quitRequested, false, `migration requested app quit: ${label}`);
    NodeAssert.deepEqual(app.rawListeners("window-all-closed"), listeners);
    NodeAssert.deepEqual(app.rawListeners("before-quit"), quitListeners);
    await clean();
    process.stdout.write(`native startup continued after migration: ${label}\n`);
  }
}

async function clean() {
  NodeAssert.equal(BrowserWindow.getAllWindows().length, 0);
  for (const scheme of [canonical, legacy])
    NodeAssert.equal(await session.defaultSession.protocol.isProtocolHandled(scheme), false);
}

async function exercise() {
  await storage(legacy, {}, true);
  await storage(canonical, {}, true);
  await migrate("empty source");
  NodeAssert.deepEqual(await storage(canonical), { [ORIGIN_MIGRATION_MARKER]: "complete" });
  NodeAssert.deepEqual(await storage(legacy), {});
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await NodeAssert.rejects(migrate("pre-aborted", alreadyAborted.signal), { name: "AbortError" });
  await storage(legacy, source, true);
  await storage(canonical, destination, true);
  const originalFlush = session.defaultSession.flushStorageData.bind(session.defaultSession);
  session.defaultSession.flushStorageData = () => {
    throw new Error("synthetic interruption before marker");
  };
  try {
    await NodeAssert.rejects(migrate("interrupted flush"), /synthetic interruption before marker/);
  } finally {
    session.defaultSession.flushStorageData = originalFlush;
  }
  await clean();
  NodeAssert.equal((await storage(canonical))[ORIGIN_MIGRATION_MARKER], undefined);
  NodeAssert.deepEqual(await storage(legacy), source);

  const controller = new AbortController();
  app.once("browser-window-created", () => controller.abort());
  await NodeAssert.rejects(migrate("constructor abort", controller.signal), { name: "AbortError" });
  await clean();
  NodeAssert.equal((await storage(canonical))[ORIGIN_MIGRATION_MARKER], undefined);

  await storage(canonical, destination, true);
  await storage(legacy, { ...source, "t3code:large-draft": "x".repeat(1_000_000) }, true);
  session.defaultSession.protocol.handle(canonical, () => new Response("<!doctype html>"));
  app.on("window-all-closed", keepFixtureAlive);
  const quotaWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await quotaWindow.loadURL(`${canonical}://app${ORIGIN_MIGRATION_PATH}`);
    const quota = await quotaWindow.webContents.executeJavaScript(`(() => {
      let index = 0;
      try { while (index < 1000) localStorage.setItem("fixture-quota-" + index++, "x".repeat(65536)); }
      catch (error) { return error.name; }
      return "no quota reached";
    })()`);
    NodeAssert.equal(quota, "QuotaExceededError");
  } finally {
    quotaWindow.destroy();
    session.defaultSession.protocol.unhandle(canonical);
    app.removeListener("window-all-closed", keepFixtureAlive);
  }
  await NodeAssert.rejects(migrate("quota failure"), /Script failed to execute/);
  await clean();
  NodeAssert.equal((await storage(canonical))[ORIGIN_MIGRATION_MARKER], undefined);
  NodeAssert.equal((await storage(legacy))["t3code:large-draft"].length, 1_000_000);

  await storage(legacy, source, true);
  await storage(canonical, destination, true);
  const inspected: Promise<void>[] = [];
  const observe = (_event: unknown, window: BrowserWindow) => {
    NodeAssert.equal(window.isVisible(), false);
    const contents = window.webContents;
    const preferences = contents.getLastWebPreferences();
    NodeAssert.equal(preferences.sandbox, true);
    NodeAssert.equal(preferences.contextIsolation, true);
    NodeAssert.equal(preferences.nodeIntegration, false);
    NodeAssert.ok(!preferences.preload);
    contents.on("did-finish-load", () => {
      inspected.push(
        (async () => {
          NodeAssert.ok(
            [canonical, legacy].some(
              (scheme) => contents.getURL() === `${scheme}://app${ORIGIN_MIGRATION_PATH}`,
            ),
          );
          NodeAssert.equal(
            await contents.executeJavaScript("typeof window.desktopBridge"),
            "undefined",
          );
          NodeAssert.equal(await contents.executeJavaScript("document.scripts.length"), 0);
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          };
          let prevented = false;
          contents.emit("will-navigate", event, "https://example.invalid/");
          NodeAssert.equal(prevented, true);
        })(),
      );
    });
  };
  app.on("browser-window-created", observe);
  try {
    await migrate("populated source");
    await Promise.all(inspected);
  } finally {
    app.removeListener("browser-window-created", observe);
  }
  await clean();
  NodeAssert.equal(inspected.length, 3);
  NodeAssert.deepEqual(await storage(canonical), expected);
  NodeAssert.deepEqual(await storage(legacy), source);
  await storage(legacy, { "t3code:later-source": "do not recopy after completion" });
  await migrate("already migrated");
  NodeAssert.deepEqual(await storage(canonical), expected);
  originalFlush();
  await clean();
}

async function main() {
  try {
    await app.whenReady();
    NodeAssert.equal(process.versions.electron, "44.4.5");
    if (stage === "exercise") await exercise();
    else {
      NodeAssert.deepEqual(await storage(canonical), expected);
      NodeAssert.deepEqual(await storage(legacy), {
        ...source,
        "t3code:later-source": "do not recopy after completion",
      });
      await migrate("restart");
      NodeAssert.deepEqual(await storage(canonical), expected);
      await clean();
    }
    process.stdout.write(
      `origin migration ${flavor} ${stage}: passed (Electron ${process.versions.electron})\n`,
    );
    const frontend = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await frontend.loadURL("data:text/html,<title>Frontend startup</title>");
    NodeAssert.equal(
      await frontend.webContents.executeJavaScript("document.title"),
      "Frontend startup",
    );
    process.stdout.write("frontend loaded after migration returned\n");
    app.once("before-quit", () =>
      process.stdout.write("normal frontend close requested app quit\n"),
    );
    frontend.destroy();
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    app.exit(1);
  }
}
void main();
