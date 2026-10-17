// @effect-diagnostics nodeBuiltinImport:off -- This fixture uses real Git, TLS and stdio subprocesses.
import { it, expect } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeHttps from "node:https";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as NodeFS from "node:fs";
import {
  operationCatalog,
  completedWriteReceipt,
  isOperationName,
  WriteReceipt,
} from "@jonathanm10/azure-devops-server-client";

const viewer = "11111111-1111-1111-1111-111111111111";
const commit = "a".repeat(40);
const JsonPatch = Schema.Array(
  Schema.Struct({ op: Schema.String, path: Schema.String, value: Schema.optionalKey(Schema.Json) }),
);
const parsePatch = Schema.decodeUnknownSync(JsonPatch);
const parseObject = Schema.decodeUnknownSync(Schema.JsonObject);
const RpcResponse = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  result: Schema.optionalKey(Schema.JsonObject),
  error: Schema.optionalKey(Schema.JsonObject),
});
const parseResponse = Schema.decodeUnknownSync(RpcResponse);
const Outcome = Schema.Struct({
  kind: Schema.String,
  value: Schema.optionalKey(Schema.Json),
  code: Schema.optionalKey(Schema.String),
  reconcile: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const parseOutcome = Schema.decodeUnknownSync(Outcome);
const parseReceipt = Schema.decodeUnknownSync(WriteReceipt);
const parseContent = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })));
const parseTools = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      annotations: Schema.Struct({ readOnlyHint: Schema.Boolean }),
    }),
  ),
);

async function fixture(access = "read-write") {
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-mcp-synthetic-"));
  const key = NodePath.join(temp, "key.pem"),
    cert = NodePath.join(temp, "cert.pem");
  NodeChildProcess.execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const requests: {
    method: string;
    url: string;
    body: Schema.Json | undefined;
    authorization: string | undefined;
    extra: string | undefined;
  }[] = [];
  const item: {
    id: number;
    rev: number;
    fields: Record<string, Schema.Json>;
    relations: { rel: string; url: string }[];
  } = {
    id: 42,
    rev: 1,
    fields: { "System.WorkItemType": "Task", "System.State": "New", "System.Title": "Synthetic" },
    relations: [],
  };
  const pr = {
    pullRequestId: 7,
    title: "Synthetic PR",
    description: "Body",
    status: "active",
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    creationDate: "2026-01-01T00:00:00Z",
    repository: { id: "repo", name: "Repo", project: { name: "Project" } },
    lastMergeSourceCommit: { commitId: commit },
    reviewers: [{ id: viewer, vote: 0 }],
  };
  const comments: { id: number; workItemId: number; text: string }[] = [];
  const thread = {
    id: 1,
    status: "active",
    comments: [
      { id: 1, content: "Thread", publishedDate: "2026-01-01T00:00:00Z", author: { id: viewer } },
    ],
  };
  const board = {
    id: "board",
    name: "Tasks",
    fields: {
      columnField: { referenceName: "WEF_team_Kanban.Column" },
      rowField: { referenceName: "WEF_team_Kanban.Lane" },
      doneField: { referenceName: "WEF_team_Kanban.Done" },
    },
    columns: [{ id: "doing", name: "Doing", isSplit: true, stateMappings: { Task: "Active" } }],
    rows: [
      { id: "fast", name: "Fast" },
      { id: "00000000-0000-0000-0000-000000000000", name: null },
    ],
  };
  let held: { started: () => void; closed: () => void } | undefined;
  let failStatus: number | undefined;
  let drop = false;
  const server = NodeHttps.createServer(
    { key: await NodeFSP.readFile(key), cert: await NodeFSP.readFile(cert) },
    async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body: Schema.Json | undefined = raw ? JSON.parse(raw) : undefined;
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        body,
        authorization: req.headers.authorization,
        extra: typeof req.headers["x-auth"] === "string" ? req.headers["x-auth"] : undefined,
      });
      const url = new URL(req.url ?? "", "https://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path.endsWith("/_apis/connectionData")) return send({ authorizedUser: { id: viewer } });
      if (held !== undefined && path.endsWith("/projects")) {
        const request = held;
        held = undefined;
        res.once("close", request.closed);
        request.started();
        return;
      }
      if (failStatus !== undefined) {
        const status = failStatus;
        failStatus = undefined;
        return send({}, status);
      }
      let output: unknown;
      if (path.endsWith("/wit/fields"))
        output = {
          value: [
            { name: "Title", referenceName: "System.Title", readOnly: false },
            { name: "Description", referenceName: "System.Description", readOnly: false },
          ],
        };
      else if (path.endsWith("/states")) output = { value: [{ name: "New" }, { name: "Active" }] };
      else if (path.endsWith("/_apis/identities"))
        output = { value: [{ id: viewer, displayName: "Synthetic Person" }] };
      else if (path.endsWith("/wit/workitems/42/comments")) {
        if (method === "POST") {
          const input = parseObject(body);
          comments.push({ id: comments.length + 1, workItemId: 42, text: String(input.text) });
          output = comments.at(-1);
        } else output = { comments };
      } else if (path.endsWith("/wit/workitems/42/updates"))
        output = {
          value: [
            {
              id: 1,
              rev: item.rev,
              fields: { "System.Title": { newValue: item.fields["System.Title"] } },
            },
          ],
        };
      else if (path.endsWith("/wit/workitems/42")) {
        if (method === "PATCH") {
          const patch = parsePatch(body);
          if (patch[0]?.value !== item.rev) return send({}, 412);
          for (const edit of patch.slice(1)) {
            if (edit.path.startsWith("/fields/"))
              item.fields[edit.path.slice(8)] = edit.value ?? null;
            else if (edit.path === "/relations/-") {
              const relation = parseObject(edit.value);
              item.relations.push({ rel: String(relation.rel), url: String(relation.url) });
            } else if (edit.op === "remove")
              item.relations.splice(Number(edit.path.split("/").at(-1)), 1);
          }
          item.rev++;
        }
        output = item;
      } else if (path.includes("/wit/workitems/$"))
        output = { id: 43, rev: 1, fields: { "System.Title": "Created" } };
      else if (path.endsWith("/wit/workitems")) output = { value: [item] };
      else if (path.endsWith("/wit/wiql")) output = { workItems: [{ id: 42 }] };
      else if (path.endsWith("/boards/Tasks/columns")) output = { value: board.columns };
      else if (path.endsWith("/boards/Tasks/rows")) output = { value: board.rows };
      else if (path.endsWith("/boards/Tasks")) output = board;
      else if (path.endsWith("/boards")) output = { value: [board] };
      else if (path.endsWith("/backlogs")) output = { value: [{ id: "tasks", name: "Tasks" }] };
      else if (path.includes("/backlogs/tasks/workItems"))
        output = { workItems: [{ rel: null, source: null, target: { id: 42 } }] };
      else if (path.endsWith("/workitems") && path.includes("teamsettings"))
        output = { workItemRelations: [{ rel: null, source: null, target: { id: 42 } }] };
      else if (path.endsWith("/teamsettings/iterations"))
        output = { value: [{ id: viewer, name: "Sprint", path: "Project\\Sprint" }] };
      else if (path.includes("/teamsettings/iterations/"))
        output = { id: viewer, name: "Sprint", path: "Project\\Sprint" };
      else if (path.endsWith("/pullRequests/7/threads/1/comments/1")) {
        thread.comments[0]!.content = String(parseObject(body).content);
        output = thread.comments[0];
      } else if (path.endsWith("/pullRequests/7/threads/1/comments"))
        output = { id: 2, content: String(parseObject(body).content) };
      else if (path.endsWith("/pullRequests/7/threads/1")) {
        thread.status = String(parseObject(body).status);
        output = thread;
      } else if (path.endsWith("/pullRequests/7/threads"))
        output = method === "POST" ? thread : { value: [thread] };
      else if (path.includes("/pullRequests/7/reviewers/")) {
        if (method === "DELETE") {
          res.writeHead(204);
          return res.end();
        }
        output = { id: viewer, vote: parseObject(body).vote ?? 0 };
      } else if (path.endsWith("/pullRequests/7/reviewers")) output = { value: pr.reviewers };
      else if (path.endsWith("/iterations/1/changes"))
        output = {
          changeEntries: [{ changeType: "edit", item: { path: "/file.txt" } }],
          nextSkip: null,
        };
      else if (path.endsWith("/pullRequests/7/iterations"))
        output = {
          value: [
            { id: 1, sourceRefCommit: { commitId: commit }, commonRefCommit: { commitId: commit } },
          ],
        };
      else if (path.endsWith("/pullRequests/7")) {
        if (method === "PATCH") {
          const input = parseObject(body);
          if (typeof input.title === "string") pr.title = input.title;
          if (typeof input.status === "string") pr.status = input.status;
        }
        output = pr;
      } else if (path.endsWith("/pullRequests")) output = method === "POST" ? pr : { value: [pr] };
      else if (path.endsWith("/items"))
        output = { content: "synthetic content", contentMetadata: { isBinary: false } };
      else if (path.endsWith("/refs"))
        output = { value: [{ name: "refs/heads/main", objectId: commit }] };
      else if (path.endsWith("/git/repositories/Repo"))
        output = { ...pr.repository, defaultBranch: "refs/heads/main" };
      else if (path.endsWith("/git/repositories")) output = { value: [pr.repository] };
      else if (path.endsWith("/teams")) output = { value: [{ id: "team", name: "Team" }] };
      else if (path.endsWith("/workitemtypes")) output = { value: [{ name: "Task" }] };
      else if (path.includes("/classificationnodes/"))
        output = { id: 1, name: "Project", children: [] };
      else if (path.endsWith("/projects/Project")) output = { id: "project", name: "Project" };
      else if (path.endsWith("/projects")) output = { value: [{ id: "project", name: "Project" }] };
      else return send({ route: "unhandled" }, 404);
      if (drop && method !== "GET") {
        drop = false;
        return res.destroy();
      }
      send(output);
    },
  );
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No address");
  const collection = `https://127.0.0.1:${address.port}/tfs/Collection`;
  const clone = `${collection}/Project/_git/Repo`;
  const helper = NodePath.join(temp, "helper.cjs");
  const log = NodePath.join(temp, "helper.log");
  await NodeFSP.writeFile(
    helper,
    `const fs=require('node:fs');const op=process.argv[2];const input=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},op+'\\n');if(op==='get'&&fs.existsSync(${JSON.stringify(NodePath.join(temp, "hold-helper"))})){fs.writeFileSync(${JSON.stringify(NodePath.join(temp, "helper.pid"))},String(process.pid));setInterval(()=>{},1000);}else if(op==='get')process.stdout.write('username=synthetic\\npassword=synthetic-private-sentinel\\noauth_refresh_token=synthetic-refresh-sentinel\\n\\n');`,
  );
  const config = NodePath.join(temp, "gitconfig");
  await NodeFSP.writeFile(
    config,
    `[credential]\nhelper = "!node ${helper}"\nuseHttpPath = true\n[http "${collection}"]\nextraHeader = X-Auth: synthetic-secondary-sentinel\n`,
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    NODE_EXTRA_CA_CERTS: cert,
  };
  NodeChildProcess.execFileSync("git", ["init", "--quiet", temp], { env });
  NodeChildProcess.execFileSync("git", ["-C", temp, "remote", "add", "origin", clone], { env });
  const profile = NodePath.join(temp, "profile.json");
  await NodeFSP.writeFile(
    profile,
    JSON.stringify({ id: "synthetic", apiCollectionUrl: collection, credentialContext: temp }),
  );
  const executable =
    process.env.AZURE_MCP_TEST_EXECUTABLE ?? NodePath.resolve(import.meta.dirname, "main.ts");
  const launch = {
    command: process.execPath,
    args: [executable, "--profile", profile, "--access", access],
    env,
    cwd: temp,
  };
  const child = NodeChildProcess.spawn(
    process.execPath,
    [executable, "--profile", profile, "--access", access],
    { env, cwd: temp, stdio: ["pipe", "pipe", "pipe"] },
  );
  let transcript = "";
  let output = "";
  let stderr = "";
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (value: typeof RpcResponse.Type) => void; reject: (error: Error) => void }
  >();
  child.stdout.on("data", (chunk) => {
    transcript += String(chunk);
    output += String(chunk);
    let newline: number;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const response = parseResponse(JSON.parse(line));
      if (typeof response.id === "number") {
        pending.get(response.id)?.resolve(response);
        pending.delete(response.id);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("exit", () => {
    for (const request of pending.values()) request.reject(new Error(`MCP exited: ${stderr}`));
  });
  const rpc = (method: string, params: Schema.JsonObject = {}) =>
    new Promise<typeof RpcResponse.Type>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    launch,
    collection,
    holdHttp: () => {
      let started: () => void = () => {},
        closed: () => void = () => {};
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const closedPromise = new Promise<void>((resolve) => {
        closed = resolve;
      });
      held = { started, closed };
      return { started: startedPromise, closed: closedPromise };
    },
    holdHelper: async () => {
      await NodeFSP.writeFile(NodePath.join(temp, "hold-helper"), "synthetic");
      return new Promise<number>((resolve) => {
        const watcher = NodeFS.watch(temp, async (_, file) => {
          if (file !== "helper.pid") return;
          const pid = Number(await NodeFSP.readFile(NodePath.join(temp, "helper.pid"), "utf8"));
          watcher.close();
          resolve(pid);
        });
      });
    },
    transcript: () => transcript,
    requests,
    item,
    pr,
    log,
    stderr: () => stderr,
    rpc,
    fail: (status: number) => {
      failStatus = status;
    },
    drop: () => {
      drop = true;
    },
    call: async (name: string, args: Schema.JsonObject) => {
      const response = await rpc("tools/call", {
        name: `azure_${name.replaceAll(".", "_")}`,
        arguments: args,
      });
      if (response.error) throw new Error(JSON.stringify(response.error));
      const structured = response.result?.structuredContent;
      if (structured !== undefined) return parseOutcome(structured);
      const content = parseContent(response.result?.content);
      return parseOutcome(JSON.parse(content[0]?.text ?? "{}"));
    },
    close: async () => {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(temp, { recursive: true, force: true });
      expect(child.exitCode).toBe(0);
    },
  };
}
it("performs every registered write over real TLS and private-stdin Git, with revision and source-commit protection", async () => {
  const f = await fixture();
  const written = new Set<string>();
  const repository = { project: "Project", repository: "Repo" };
  const pr = { ...repository, pullRequestId: 7 };
  const revision = () => ({ project: "Project", id: 42, expectedRevision: f.item.rev });
  const write = async (name: string, input: Schema.JsonObject) => {
    const before = f.requests.length;
    const result = await f.call(name, input);
    expect(result, JSON.stringify({ name, result })).toMatchObject({ kind: "ok" });
    if (!isOperationName(name)) throw new Error("Unknown fixture operation");
    const receipt = parseReceipt(completedWriteReceipt(name, input, result.value, f.collection));
    expect(receipt.resource.url).toContain(f.collection);
    expect(
      operationCatalog.some(
        (operation) =>
          operation.readOnly &&
          `azure_${operation.name.replaceAll(".", "_")}` === receipt.readBack.tool,
      ),
    ).toBe(true);
    switch (receipt.resource.kind) {
      case "workItem":
        expect(receipt.resource).toMatchObject({
          id: name === "workItems.create" ? 43 : 42,
          revision: name === "workItems.create" ? 1 : f.item.rev,
        });
        break;
      case "workItemComment":
        expect(receipt.resource).toMatchObject({ id: 1, workItemId: 42 });
        break;
      case "pullRequest":
        expect(receipt.resource).toMatchObject({ id: 7, sourceCommit: commit });
        break;
      case "pullRequestThread":
        expect(receipt.resource).toMatchObject({ id: 1, pullRequestId: 7 });
        break;
      case "pullRequestComment":
        expect(receipt.resource).toMatchObject({
          id: name === "pullRequests.reply" ? 2 : 1,
          threadId: 1,
          pullRequestId: 7,
        });
        break;
      case "pullRequestReviewer":
        expect(receipt.resource).toMatchObject({ id: viewer, pullRequestId: 7 });
        break;
    }
    expect(
      f.requests.slice(before).some((request) => request.method !== "GET"),
      name,
    ).toBe(true);
    written.add(name);
    return result;
  };
  try {
    await write("workItems.create", { project: "Project", type: "Task", title: "Created" });
    await write("workItems.edit", {
      ...revision(),
      edits: [{ field: "System.Title", value: "Changed" }],
    });
    expect(f.item.fields["System.Title"]).toBe("Changed");
    await write("workItems.assign", { ...revision(), identityId: viewer });
    expect(f.item.fields["System.AssignedTo"]).toEqual({ id: viewer });
    await write("workItems.transition", { ...revision(), state: "Active" });
    expect(f.item.fields["System.State"]).toBe("Active");
    await write("workItems.comment", { ...revision(), text: "Synthetic note" });
    expect(f.requests.at(-1)?.url).toContain("api-version=6.0-preview.3");
    await write("workItems.link", {
      ...revision(),
      targetId: 43,
      relation: "System.LinkTypes.Related",
    });
    expect(f.item.relations).toHaveLength(1);
    await write("workItems.unlink", { ...revision(), index: 0 });
    expect(f.item.relations).toHaveLength(0);
    await write("boards.moveCard", {
      ...revision(),
      team: "Team",
      board: "Tasks",
      column: "doing",
      lane: "fast",
      done: true,
    });
    expect(f.item.fields).toMatchObject({
      "System.State": "Active",
      "WEF_team_Kanban.Column": "Doing",
      "WEF_team_Kanban.Lane": "Fast",
      "WEF_team_Kanban.Done": true,
    });
    expect(f.requests.at(-1)?.method).toBe("GET");
    await write("boards.moveCard", {
      ...revision(),
      team: "Team",
      board: "Tasks",
      column: "doing",
      lane: "00000000-0000-0000-0000-000000000000",
    });
    expect(f.item.fields["WEF_team_Kanban.Lane"]).toBe("");
    await write("iterations.assign", { ...revision(), team: "Team", iteration: viewer });
    expect(f.item.fields["System.IterationPath"]).toBe("Project\\Sprint");
    await write("pullRequests.create", {
      ...repository,
      title: "Synthetic PR",
      description: "Body",
      sourceRef: "refs/heads/feature",
      targetRef: "refs/heads/main",
      isDraft: true,
    });
    await write("pullRequests.edit", {
      ...pr,
      title: "Edited",
      description: "Updated",
      isDraft: false,
    });
    expect(f.pr.title).toBe("Edited");
    await write("pullRequests.comment", { ...pr, text: "Comment" });
    await write("pullRequests.reply", { ...pr, threadId: 1, text: "Reply" });
    await write("pullRequests.editComment", {
      ...pr,
      threadId: 1,
      commentId: 1,
      text: "Edited comment",
    });
    await write("pullRequests.threadState", { ...pr, threadId: 1, state: "fixed" });
    await write("pullRequests.vote", { ...pr, vote: 10 });
    expect(f.requests.at(-1)?.url).toContain(`/reviewers/${viewer}`);
    await write("pullRequests.addReviewer", { ...pr, identityId: viewer, required: true });
    await write("pullRequests.removeReviewer", { ...pr, identityId: viewer });
    await write("pullRequests.lifecycle", { ...pr, status: "abandoned" });
    expect(f.pr.status).toBe("abandoned");
    const beforeConflict = f.requests.length;
    expect(
      await f.call("pullRequests.complete", {
        ...pr,
        expectedSourceCommit: "b".repeat(40),
        strategy: "squash",
        deleteSourceBranch: false,
      }),
    ).toMatchObject({ kind: "conflict" });
    expect(f.requests.slice(beforeConflict).every((request) => request.method === "GET")).toBe(
      true,
    );
    await write("pullRequests.complete", {
      ...pr,
      expectedSourceCommit: commit,
      strategy: "squash",
      deleteSourceBranch: false,
    });
    expect(f.requests.at(-1)?.body).toMatchObject({
      lastMergeSourceCommit: { commitId: commit },
      completionOptions: {
        mergeStrategy: "squash",
        deleteSourceBranch: false,
        bypassPolicy: false,
      },
    });
    expect([...written].sort()).toEqual(
      operationCatalog
        .filter((operation) => !operation.readOnly)
        .map((operation) => operation.name)
        .sort(),
    );
    expect(
      await f.call("workItems.edit", {
        project: "Project",
        id: 42,
        expectedRevision: 1,
        edits: [{ field: "System.Title", value: "Stale" }],
      }),
    ).toMatchObject({ kind: "conflict" });
    expect(f.item.fields["System.Title"]).toBe("Changed");
    f.fail(403);
    expect(
      await f.call("pullRequests.edit", {
        ...pr,
        title: "Denied",
        description: "",
        isDraft: false,
      }),
    ).toMatchObject({ kind: "denied" });
    f.fail(404);
    expect(await f.call("pullRequests.threads", pr)).toMatchObject({ kind: "unsupported" });
    f.drop();
    const before = f.requests.length;
    expect(await f.call("pullRequests.comment", { ...pr, text: "Uncertain" })).toMatchObject({
      kind: "indeterminate",
      reconcile: "pullRequests.threads",
    });
    expect(f.requests.slice(before).filter((request) => request.method === "POST")).toHaveLength(1);
    expect(
      f.requests.every(
        (request) =>
          request.authorization ===
            "Basic " + Buffer.from("synthetic:synthetic-private-sentinel").toString("base64") &&
          request.extra === "synthetic-secondary-sentinel",
      ),
    ).toBe(true);
    expect(f.stderr()).not.toContain("sentinel");
    expect(f.transcript()).not.toContain("sentinel");
    expect(f.transcript()).not.toContain(
      Buffer.from("synthetic:synthetic-private-sentinel").toString("base64"),
    );
  } finally {
    await f.close();
  }
}, 60000);

it("enumerates and executes every read family and refuses hidden writes before authentication in read mode", async () => {
  const f = await fixture("read");
  const project = { project: "Project" };
  const team = { ...project, team: "Team" };
  const repo = { ...project, repository: "Repo" };
  const pr = { ...repo, pullRequestId: 7 };
  const inputs: Record<string, Schema.JsonObject> = {
    "viewer.get": {},
    "projects.list": {},
    "projects.get": project,
    "teams.list": project,
    "identities.search": { query: "Synthetic" },
    "workItemTypes.list": project,
    "fields.list": project,
    "states.list": { ...project, type: "Task" },
    "areas.get": project,
    "iterations.tree": project,
    "workItems.get": { ...project, id: 42 },
    "workItems.batch": { ...project, ids: [42] },
    "workItems.query": {
      ...project,
      query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project",
    },
    "workItems.search": { ...project, text: "Synthetic" },
    "workItems.history": { ...project, id: 42 },
    "workItems.relations": { ...project, id: 42 },
    "workItems.comments": { ...project, id: 42 },
    "boards.list": team,
    "boards.get": { ...team, board: "Tasks" },
    "boards.columns": { ...team, board: "Tasks" },
    "boards.lanes": { ...team, board: "Tasks" },
    "backlogs.list": team,
    "backlogs.items": { ...team, backlog: "tasks" },
    "boards.cards": { ...team, board: "Tasks" },
    "iterations.list": { ...team, current: true },
    "iterations.items": { ...team, iteration: viewer },
    "repositories.list": project,
    "repositories.get": repo,
    "repositories.defaultBranch": repo,
    "branches.list": repo,
    "pullRequests.list": repo,
    "pullRequests.get": pr,
    "pullRequests.iterations": pr,
    "pullRequests.changes": { ...pr, iterationId: 1 },
    "repositories.file": { ...repo, path: "file.txt", commit },
    "pullRequests.threads": pr,
    "pullRequests.reviewers": pr,
  };
  try {
    const listing = await f.rpc("tools/list");
    const tools = parseTools(listing.result?.tools);
    expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(tools).toHaveLength(operationCatalog.filter((operation) => operation.readOnly).length);
    const refused = await f.call("workItems.create", {
      ...project,
      type: "Task",
      title: "Forbidden",
    });
    expect(refused.kind).toBe("denied");
    expect(f.requests).toHaveLength(0);
    await expect(NodeFSP.stat(f.log)).rejects.toThrow();
    for (const [name, input] of Object.entries(inputs)) {
      const result = await f.call(name, input);
      expect(result, name).toMatchObject({ kind: "ok" });
      if (name === "boards.lanes")
        expect(result).toMatchObject({
          value: {
            items: [
              { id: "fast", name: "Fast" },
              { id: "00000000-0000-0000-0000-000000000000", name: null },
            ],
          },
        });
    }
    expect(Object.keys(inputs).sort()).toEqual(
      operationCatalog
        .filter((operation) => operation.readOnly)
        .map((operation) => operation.name)
        .sort(),
    );
    const wiql = f.requests.filter((request) => request.url.includes("/wit/wiql"));
    expect(wiql).toHaveLength(2);
    expect(wiql.every((request) => request.method === "POST")).toBe(true);
    expect(f.requests.filter((request) => request.url.includes("/connectionData"))).toHaveLength(
      Object.keys(inputs).length,
    );
    expect(
      f.requests
        .filter((request) => request.url.includes("/connectionData"))
        .every((request) => !request.url.includes("api-version")),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 60000);
it("interoperates with the standard MCP SDK and cancels an active HTTPS request", async () => {
  const f = await fixture("read");
  const client = new Client({ name: "standard-sdk", version: "1" });
  const transport = new StdioClientTransport({ ...f.launch, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await client.connect(transport);
    const pid = transport.pid;
    const listing = await client.listTools();
    expect(listing.tools).toHaveLength(
      operationCatalog.filter((operation) => operation.readOnly).length,
    );
    const result = await client.callTool({ name: "azure_projects_list", arguments: { limit: 1 } });
    expect(result.isError).toBe(false);
    const held = f.holdHttp();
    const abort = new AbortController();
    const pending = client.callTool({ name: "azure_projects_list", arguments: {} }, undefined, {
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await held.started;
    abort.abort();
    await rejected;
    await held.closed;
    await client.close();
    expect(pid).not.toBeNull();
    if (pid !== null) expect(() => process.kill(pid, 0)).toThrow();
    expect(stderr).not.toContain("sentinel");
  } finally {
    await client.close();
    await f.close();
  }
}, 30000);

it("EOF cancels an owned Git helper process group and waits for it to exit", async () => {
  const f = await fixture("read");
  const client = new Client({ name: "eof-sdk", version: "1" });
  const transport = new StdioClientTransport({ ...f.launch, stderr: "pipe" });
  try {
    await client.connect(transport);
    const started = f.holdHelper();
    const pending = client.callTool({ name: "azure_projects_list", arguments: {} });
    const rejected = expect(pending).rejects.toThrow();
    const helperPid = await started;
    await client.close();
    await rejected;
    expect(() => process.kill(helperPid, 0)).toThrow();
  } finally {
    await client.close();
    await f.close();
  }
}, 30000);
