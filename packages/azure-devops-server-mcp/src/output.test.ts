// @effect-diagnostics nodeBuiltinImport:off -- The fixture drives the real stdio server through Node streams.
import { expect, it, vi } from "vite-plus/test";
import * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  executeUnknownOperation,
  withOperationDefaults,
} from "../../azure-devops-server-client/src/operations.ts";
import { WriteReceipt } from "../../azure-devops-server-client/src/receipts.ts";
import { resolveAzureDevOpsServerAddress } from "../../azure-devops-server-client/src/addresses.ts";
import type { OperationContext, Request } from "../../azure-devops-server-client/src/transport.ts";
import { serveAzureMcp, toolsForAccess } from "./server.ts";

const host = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@jonathanm10/azure-devops-server-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jonathanm10/azure-devops-server-client")>();
  const Effect = await import("effect/Effect");
  return { ...actual, makeNodeAzureServerClient: () => Effect.succeed({ execute: host.execute }) };
});

const profile = {
  id: "synthetic",
  apiCollectionUrl: "https://git.example.test/Collection",
  credentialContext: "/synthetic",
  defaultProject: "Project",
  defaultTeam: "Team",
};
const parseFrame = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
    result: Schema.optionalKey(
      Schema.Struct({
        isError: Schema.optionalKey(Schema.Boolean),
        content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
        structuredContent: Schema.optionalKey(Schema.JsonObject),
      }),
    ),
    error: Schema.optionalKey(Schema.JsonObject),
  }),
);
const parseObject = Schema.decodeUnknownSync(Schema.JsonObject);
const parseReceipt = Schema.decodeUnknownSync(WriteReceipt);
const escapedFields = Array.from({ length: 5 }, (_, index) => ({
  field: `Custom.Text${index}`,
  value: '"\\\n'.repeat(21845),
}));
const escapedValues = Object.fromEntries(escapedFields.map(({ field, value }) => [field, value]));

async function call(
  input: Schema.JsonObject,
  returnedFields?: Schema.JsonObject,
  id: string | number = 1,
  operation = "workItems.create",
  protocol: "raw" | "sdk" = "raw",
) {
  const address = resolveAzureDevOpsServerAddress(`${profile.apiCollectionUrl}/Project/_git/Repo`, [
    profile,
  ]);
  if (address === null) throw new Error("Invalid fixture address");
  const requests: { route: string; options: Parameters<Request>[1] }[] = [];
  const fields = Array.from({ length: 9 }, (_, index) => ({
    field: `Custom.Text${index}`,
    value: "x".repeat(65536),
  }));
  const item = {
    id: 17,
    rev: 1,
    fields: returnedFields ?? Object.fromEntries(fields.map(({ field, value }) => [field, value])),
  };
  const context: OperationContext = {
    address,
    access: "read-write",
    credentialFingerprint: "synthetic",
    viewer: "11111111-1111-1111-1111-111111111111",
    request: (route, options) => {
      requests.push({ route, options });
      return Effect.succeed({
        continuation: null,
        body: route.endsWith("/fields")
          ? {
              value: fields.map(({ field }) => ({
                name: field,
                referenceName: field,
                readOnly: false,
              })),
            }
          : options?.query?.fields === "System.Id,System.Rev"
            ? {
                id: item.id,
                rev: item.rev,
                fields: { "System.Id": item.id, "System.Rev": item.rev },
              }
            : item,
      });
    },
  };
  host.execute.mockImplementation((name: string, value: Schema.JsonObject) =>
    executeUnknownOperation(name, withOperationDefaults(name, value, profile), context),
  );
  const source = new NodeStream.PassThrough();
  const transports = protocol === "sdk" ? InMemoryTransport.createLinkedPair() : undefined;
  if (transports !== undefined) {
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The SDK Transport contract has callback properties and no EventTarget API.
    transports[1].onmessage = (message) => {
      source.write(JSON.stringify(message) + "\n");
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The SDK Transport contract has callback properties and no EventTarget API.
    transports[1].onclose = () => {
      source.end();
    };
  }
  let wire = "";
  const sink = new NodeStream.Writable({
    write(chunk, _encoding, callback) {
      wire += String(chunk);
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(1024 * 1024);
      if (transports === undefined) {
        callback();
        source.end();
      } else {
        void transports[1]
          .send(JSONRPCMessageSchema.parse(JSON.parse(String(chunk))))
          .then(() => callback(), callback);
      }
    },
  });
  const serving = serveAzureMcp({ profile, access: "read-write", input: source, output: sink });
  const params = {
    name: `azure_${operation.replaceAll(".", "_")}`,
    arguments:
      operation === "workItems.create"
        ? { type: "Task", title: "Created", fields, ...input }
        : input,
  };
  const request =
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params,
    }) + "\n";
  expect(Buffer.byteLength(request)).toBeLessThanOrEqual(1024 * 1024);
  if (transports === undefined) {
    source.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    source.write(request);
    await serving;
  } else {
    const client = new Client({ name: "bounded-write-fixture", version: "1" });
    try {
      await client.connect(transports[0]);
      await client.listTools();
      await client.callTool(params);
    } finally {
      await client.close();
      source.end();
      await serving;
    }
  }
  const frame = parseFrame(JSON.parse(wire.trimEnd().split("\n").at(-1) ?? "{}"));
  const outcome =
    frame.result?.structuredContent ??
    parseObject(JSON.parse(frame.result?.content[0]?.text ?? "{}"));
  return { frame, outcome, item, requests, wire };
}

it("returns a schema-valid completed write through the official MCP SDK", async () => {
  const f = await call({}, undefined, 1, "workItems.create", "sdk");
  expect(f.requests.filter((request) => request.options?.method === "POST")).toHaveLength(1);
  expect(f.frame.result?.isError).toBe(false);
  expect(f.frame.result?.structuredContent).toMatchObject({
    kind: "completed",
    receipt: {
      resource: { id: 17, revision: 1 },
      readBack: { tool: "azure_workItems_get", arguments: { project: "Project", id: 17 } },
    },
  });
});

it("keeps ordinary complete successes in both supported representations", async () => {
  const f = await call({}, { "System.Title": "Small" });
  expect(f.frame.result?.isError).toBe(false);
  expect(f.frame.result?.structuredContent).toEqual({ kind: "ok", value: f.item });
  expect(JSON.parse(f.frame.result?.content[0]?.text ?? "null")).toEqual(
    f.frame.result?.structuredContent,
  );
});

it("returns a completed receipt when the full structured response exceeds the frame budget", async () => {
  const f = await call({});
  expect(f.requests.filter((request) => request.options?.method === "POST")).toHaveLength(1);
  expect(f.frame.result?.isError).toBe(false);
  expect(f.frame.result?.structuredContent).toMatchObject({
    kind: "completed",
    receipt: { resource: { id: 17, revision: 1 } },
  });
});

it("preserves a completed write receipt when JSON string escaping makes even text-only output too large", async () => {
  const f = await call({ fields: escapedFields }, escapedValues);
  expect(f.requests.filter((request) => request.options?.method === "POST")).toHaveLength(1);
  expect(f.requests.find((request) => request.options?.method === "POST")?.options?.body).toEqual([
    { op: "add", path: "/fields/System.Title", value: "Created" },
    ...escapedFields.map(({ field, value }) => ({ op: "add", path: `/fields/${field}`, value })),
  ]);
  expect(f.frame.result?.isError).toBe(false);
  expect(f.outcome).toMatchObject({
    kind: "completed",
    receipt: {
      resource: {
        kind: "workItem",
        id: 17,
        revision: 1,
        url: "https://git.example.test/Collection/Project/_apis/wit/workitems/17",
      },
      readBack: { tool: "azure_workItems_get", arguments: { project: "Project", id: 17 } },
    },
  });
  expect(f.outcome.message).toContain("Do not repeat");
  const receipt = parseReceipt(f.outcome.receipt);
  const reread = await call(receipt.readBack.arguments, f.item.fields, 2, "workItems.get");
  expect(reread.outcome).toEqual({
    kind: "ok",
    value: { id: 17, rev: 1, fields: { "System.Id": 17, "System.Rev": 1 } },
  });
  expect(reread.requests).toHaveLength(1);
  expect(reread.requests[0]?.options?.query).toEqual({ fields: "System.Id,System.Rev" });
  const listing = toolsForAccess("read-write").find(
    (tool) => tool.name === "azure_workItems_create",
  );
  expect(JSON.stringify(listing?.outputSchema)).toContain('"completed"');
});

it("includes the escaped maximum-length id in the complete response budget", async () => {
  const f = await call({}, { "Custom.Edge": "x".repeat(523600) }, "\u0001".repeat(256));
  expect(f.frame.result?.isError).toBe(false);
  expect(f.frame.result?.structuredContent).toMatchObject({
    kind: "completed",
    receipt: { resource: { id: 17, revision: 1 } },
  });
});

it("uses an explicit project override in the completed receipt", async () => {
  const f = await call({ project: "Other project", fields: escapedFields }, escapedValues);
  expect(f.outcome).toMatchObject({
    kind: "completed",
    receipt: {
      resource: {
        id: 17,
        revision: 1,
        url: "https://git.example.test/Collection/Other%20project/_apis/wit/workitems/17",
      },
      readBack: { tool: "azure_workItems_get", arguments: { project: "Other project", id: 17 } },
    },
  });
});

it("keeps oversized reads distinct from completed writes", async () => {
  const f = await call({ id: 17 }, { "Custom.Large": "x".repeat(1100000) }, 1, "workItems.get");
  expect(f.frame.result?.isError).toBe(true);
  expect(f.outcome).toMatchObject({ kind: "failed", code: "output-limit" });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.options?.method).toBeUndefined();
});

it("bounds the complete frame including an escaped request id", async () => {
  const f = await call({ fields: [] }, {}, "\\".repeat(400000));
  expect(f.frame.error).toBeDefined();
  expect(f.requests).toHaveLength(0);
});
