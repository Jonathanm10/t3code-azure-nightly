/* oxlint-disable t3code/no-global-process-runtime -- This standalone package has no T3 runtime dependency; this module is the Node host boundary. */
// @effect-diagnostics nodeBuiltinImport:off -- This standalone adapter owns bounded Git subprocesses without a host runtime.
// @effect-diagnostics globalTimers:off -- Subprocess deadlines terminate only the process group created by this adapter.
// @effect-diagnostics globalTimersInEffect:off -- Process-group escalation must outlive interruption of the owning Effect callback.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeBuffer from "node:buffer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { makeAzureServerClient, type GitProcessInput, type GitProcessOutput } from "./client.ts";
import { AzureServerProfile } from "./profile.ts";
import { AzureServerError } from "./errors.ts";
import { withOperationDefaults } from "./operations.ts";

const runGit = (input: GitProcessInput) =>
  Effect.callback<GitProcessOutput, AzureServerError>((resume) => {
    const limit = input.maxOutputBytes ?? 128 * 1024;
    const child = NodeChildProcess.spawn("git", [...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let stopped = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (exited || stopped) return;
      stopped = true;
      try {
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        if (exited) return;
        try {
          if (process.platform !== "win32" && child.pid !== undefined)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 500);
    };
    const timer = setTimeout(stop, input.timeoutMs ?? 30000);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes <= limit) stdout.push(chunk);
      else stop();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= limit) stderr.push(chunk);
      else stop();
    });
    child.stdin.on("error", () => {});
    child.once("error", () =>
      resume(Effect.fail(new AzureServerError({ operation: "git", category: "authentication" }))),
    );
    child.once("close", (code) => {
      exited = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (stopped)
        return resume(
          Effect.fail(new AzureServerError({ operation: "git", category: "authentication" })),
        );
      const out = Buffer.concat(stdout);
      resume(
        Effect.succeed({
          exitCode: code ?? -1,
          stdout: out.toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutTruncated: outBytes > limit,
          stderrTruncated: errBytes > limit,
          stdoutInvalidUtf8: !NodeBuffer.isUtf8(out),
        }),
      );
    });
    child.stdin.end(input.stdin ?? "");
    return Effect.promise(async () => {
      stop();
      await closed;
    });
  });

const decodeProfile = Schema.decodeUnknownEffect(AzureServerProfile);

export const makeNodeAzureServerClient = (
  rawProfile: AzureServerProfile,
  access: "read" | "read-write" = "read-write",
) =>
  Effect.gen(function* () {
    const profile = yield* decodeProfile(rawProfile, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () => new AzureServerError({ operation: "profile", category: "configuration" }),
      ),
    );
    if (!NodePath.isAbsolute(profile.credentialContext))
      return yield* new AzureServerError({ operation: "checkout", category: "configuration" });
    const cwd = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(profile.credentialContext),
      catch: () => new AzureServerError({ operation: "checkout", category: "configuration" }),
    });
    const client = yield* makeAzureServerClient(
      { profiles: Effect.succeed([profile]), process: { run: runGit } },
      access,
    ).pipe(Effect.provide(FetchHttpClient.layer));
    const input = {
      cwd,
      ...(profile.remoteUrl === undefined ? {} : { remoteUrl: profile.remoteUrl }),
    };
    return {
      execute: (name: string, value: unknown) =>
        client.execute(input, name, withOperationDefaults(name, value, profile)),
      withSession: <A, E, R>(use: Parameters<typeof client.withSession<A, E, R>>[1]) =>
        client.withSession(input, use),
    };
  });
