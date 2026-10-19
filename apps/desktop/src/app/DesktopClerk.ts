import { createClerkBridge } from "@clerk/electron";
import type * as Electron from "electron";
import * as NodeURL from "node:url";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  codexAuthDeliveryUrl,
  readCodexAuthDelivery,
  readCodexAuthHandoff,
} from "@t3tools/shared/codexAuthHandoff";
import { receiveCodexAuthCallback, CodexAuthCallbackError } from "./CodexAuthCallback.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { ORIGIN_MIGRATION_PATH } from "./DesktopOriginMigration.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedError<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedError<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      | ElectronApp.ElectronApp
      | ElectronWindow.ElectronWindow
      | DesktopWebLinks.DesktopWebLinks
      | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

export function desktopProviderAuthReturnUrl(value: string | undefined, isDevelopment: boolean) {
  const destination = providerAuthReturnUrl(value);
  if (!destination) return undefined;
  const url = new URL(destination);
  if (
    !ElectronProtocol.getDesktopSchemes(isDevelopment).some(
      (scheme) => url.protocol === `${scheme}:`,
    )
  )
    return undefined;
  if (value && new URL(value).hash.startsWith("#codex-auth=")) {
    if (!readCodexAuthDelivery(value)) return undefined;
    url.hash = new URL(value).hash;
  }
  url.protocol = `${ElectronProtocol.getDesktopScheme(isDevelopment)}:`;
  return url.toString();
}

function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: stateDir }),
    manageSingleInstanceLock: false,
    passkeys: false,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shell = yield* ElectronShell.ElectronShell;

  // Must not yield: the bridge registers a scheme Electron rejects once ready.
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment);
  yield* electronApp.setPath("userData", userDataPath);

  // T3 owns the profile-scoped lock on every platform; Clerk skips it on macOS.
  // Quit is asynchronous, so interrupt before the application runtime is built.
  if (!(yield* electronApp.requestSingleInstanceLock)) {
    yield* electronApp.quit;
    return yield* Effect.interrupt;
  }

  // Retain launch arguments while asynchronous startup builds the application runtime.
  const pendingSecondInstances: Array<readonly string[]> = [];
  let handleSecondInstance = (argv: readonly string[]) => {
    pendingSecondInstances.push(argv);
  };
  yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
    handleSecondInstance(argv);
  });

  yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      const startProviderAuthHandoff = (value: string | undefined) => {
        if (!value) return false;
        const request = readCodexAuthHandoff(value, environment.isDevelopment);
        if (!request) return false;
        void runPromise(
          Effect.gen(function* () {
            yield* electronApp.whenReady;
            yield* Effect.tryPromise({
              try: () =>
                receiveCodexAuthCallback(
                  request.authorizationUrl,
                  (url) => runPromise(shell.openExternal(url)),
                  (callbackUrl) => codexAuthDeliveryUrl(request, callbackUrl),
                ),
              catch: () =>
                new CodexAuthCallbackError({
                  detail:
                    "Could not receive hosted web ChatGPT sign-in. Retry or use the redirect URL in the web app.",
                }),
            });
          }).pipe(
            Effect.catch(() => Effect.logWarning("Could not complete ChatGPT desktop handoff.")),
          ),
        );
        return true;
      };
      const isApplicationWindow = (window: Electron.BrowserWindow) => {
        const url = new URL(window.webContents.getURL() || "about:blank");
        return (
          url.protocol === `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}:` &&
          url.host === ElectronProtocol.DESKTOP_HOST &&
          url.pathname !== ORIGIN_MIGRATION_PATH
        );
      };
      let pendingProviderReturn: string | undefined;
      const deliverProviderReturn = Effect.gen(function* () {
        if (!pendingProviderReturn) return;
        const mainWindow = yield* electronWindow.currentMainOrFirst;
        if (Option.isNone(mainWindow) || !isApplicationWindow(mainWindow.value)) return;
        const destination = pendingProviderReturn;
        pendingProviderReturn = undefined;
        yield* Effect.promise(() => mainWindow.value.loadURL(destination));
        yield* electronWindow.reveal(mainWindow.value);
      }).pipe(Effect.catchCause(() => Effect.logWarning("Could not return to provider setup.")));
      const resumeProviderAuth = (value: string | undefined) => {
        const destination = desktopProviderAuthReturnUrl(value, environment.isDevelopment);
        if (!destination) return false;
        pendingProviderReturn = destination;
        void runPromise(deliverProviderReturn);
        return true;
      };
      const detachPendingWindows = new Set<() => void>();
      yield* electronApp.on(
        "browser-window-created",
        (_event: unknown, window: Electron.BrowserWindow) => {
          const contents = window.webContents;
          const finished = () => {
            void runPromise(deliverProviderReturn);
          };
          const detach = () => {
            contents.removeListener("did-finish-load", finished);
            contents.removeListener("destroyed", detach);
            detachPendingWindows.delete(detach);
          };
          contents.on("did-finish-load", finished);
          contents.once("destroyed", detach);
          detachPendingWindows.add(detach);
        },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const detach of detachPendingWindows) detach();
        }),
      );
      const openAppLink = (value: string | undefined) => {
        if (
          !value ||
          !URL.canParse(value) ||
          !ElectronProtocol.getDesktopSchemes(environment.isDevelopment).some(
            (scheme) => new URL(value).protocol === `${scheme}:`,
          ) ||
          promptLinkAppPath(value) === null
        )
          return false;
        const canonical = new URL(value);
        canonical.protocol = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}:`;
        void runPromise(webLinks.receive(canonical.toString()));
        return true;
      };
      yield* electronApp.setAsDefaultProtocolClient(
        ElectronProtocol.getDesktopSchemes(environment.isDevelopment)[1],
      );
      const args = yield* HostProcess.Arguments;
      args.some(
        (value) =>
          startProviderAuthHandoff(value) || resumeProviderAuth(value) || openAppLink(value),
      );
      const openWebLink = (url: string) => {
        if (!DesktopWebLinks.isWebLink(url)) return false;
        void runPromise(webLinks.receive(url));
        return true;
      };
      yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
        if (
          startProviderAuthHandoff(url) ||
          resumeProviderAuth(url) ||
          openWebLink(url) ||
          openAppLink(url)
        )
          event.preventDefault();
      });
      yield* electronApp.on("open-file", (event: { preventDefault: () => void }, path: string) => {
        if (!DesktopWebLinks.isWebPageFile(path)) return;
        event.preventDefault();
        void runPromise(webLinks.receive(NodeURL.pathToFileURL(path).href));
      });
      handleSecondInstance = (argv) => {
        if (
          argv?.some(
            (value) =>
              startProviderAuthHandoff(value) || resumeProviderAuth(value) || openAppLink(value),
          )
        )
          return;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow) && isApplicationWindow(mainWindow.value))
              yield* electronWindow.reveal(mainWindow.value);
          }),
        );
      };
      for (const argv of pendingSecondInstances.splice(0)) handleSecondInstance(argv);
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
