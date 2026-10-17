import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeAzureServerClient, type AzureSession } from "./client.ts";

const viewer = "11111111-1111-1111-1111-111111111111";
const clone = "https://git.example.test/tfs/Collection/Project/_git/Repo";
const fixture = () => {
  let commands = 0;
  let requests = 0;
  const make = makeAzureServerClient({
    profiles: Effect.succeed([{ apiCollectionUrl: "https://git.example.test/tfs/Collection" }]),
    process: {
      run: (input) =>
        Effect.sync(() => {
          commands++;
          return {
            exitCode: 0,
            stdout:
              input.args[0] === "remote"
                ? clone
                : input.args[0] === "credential" && input.args[1] === "fill"
                  ? "username=synthetic\npassword=synthetic-private-sentinel\n\n"
                  : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    },
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests++;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ authorizedUser: { id: viewer } }),
          );
        }),
      ),
    ),
  );
  return { make, commands: () => commands, requests: () => requests };
};
it.effect("revokes escaped session capabilities and preserves callback Effect context", () =>
  Effect.gen(function* () {
    const f = fixture();
    const Marker = Context.Reference("azure-test-marker", { defaultValue: () => "" });
    let escaped: AzureSession | undefined;
    const client = yield* f.make;
    const answer = yield* client
      .withSession({ cwd: "/synthetic" }, (session) =>
        Effect.gen(function* () {
          escaped = session;
          return { marker: yield* Marker, viewer: yield* session.execute("viewer.get", {}) };
        }),
      )
      .pipe(Effect.provideService(Marker, "caller-context"));
    expect(answer).toEqual({ marker: "caller-context", viewer: { id: viewer } });
    const requests = f.requests();
    if (escaped === undefined) throw new Error("Missing session");
    const closed = yield* escaped.execute("viewer.get", {}).pipe(Effect.flip);
    expect(closed.category).toBe("closed");
    expect(f.requests()).toBe(requests);
  }),
);
it.effect("rejects semantic writes and invalid inputs before Git or HTTP", () =>
  Effect.gen(function* () {
    const f = fixture();
    const client = yield* f.make;
    const result = yield* client
      .execute({ cwd: "/synthetic" }, "workItems.create", {
        project: "Project",
        type: "Task",
        title: "Forbidden",
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
    expect(result?.category).toBe("denied");
    expect(f.commands()).toBe(0);
    expect(f.requests()).toBe(0);
    const invalid = yield* client
      .execute({ cwd: "/synthetic" }, "projects.get", { project: "../escape" })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
    expect(invalid?.category).toBe("configuration");
    expect(f.commands()).toBe(0);
  }),
);
it.effect("acquires a fresh verified session for each completed operation", () =>
  Effect.gen(function* () {
    const f = fixture();
    const client = yield* f.make;
    yield* client.execute({ cwd: "/synthetic" }, "viewer.get", {});
    yield* client.execute({ cwd: "/synthetic" }, "viewer.get", {});
    expect(f.requests()).toBe(2);
  }),
);

it.effect(
  "reports an invalid cursor without suggesting T3 settings or dispatching its resource request",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const client = yield* f.make;
      const error = yield* client
        .execute({ cwd: "/synthetic" }, "pullRequests.list", {
          project: "Project",
          repository: "Repo",
          cursor: "invalid",
        })
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
      expect(error?.category).toBe("configuration");
      expect(error?.message).toContain("cursor");
      expect(error?.message).toContain("same process");
      expect(error?.message).not.toContain("Source Control settings");
      expect(f.requests()).toBe(1);
    }),
);
