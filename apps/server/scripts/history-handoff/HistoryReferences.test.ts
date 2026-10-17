// @effect-diagnostics nodeBuiltinImport:off - These tests own disposable synthetic SQLite packages and parser instances.
import * as NodeURL from "node:url";
import {
  markdownAssetReferences,
  historyReferences,
  rewriteMarkdownAssets,
  relocateHistoryValue,
} from "./HistoryReferences.ts";
import { resolveViewedImageAsset } from "../../../../packages/client-runtime/src/work-log/presentation.ts";
import { resolveMediaSource } from "../../../../packages/client-runtime/src/mediaSource.ts";
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { it, expect } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import {
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { classifyMarkdownImageSource } from "../../../../packages/client-runtime/src/markdownImages.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import { historyLayer } from "./HistoryFreeze.ts";
import { now } from "./HistoryFreeze.fixture.ts";
import { fixture, png } from "./HistoryCopy.fixture.ts";
import { copyHistory } from "./HistoryCopy.ts";
import { tableDigest } from "./HistoryCapture.ts";

const sharedRequire = NodeModule.createRequire(
  new URL("../../../../packages/shared/package.json", import.meta.url),
);
function call(target: unknown, key: string, ...args: unknown[]): unknown {
  if (!Predicate.isObject(target) && typeof target !== "function")
    throw new Error("Missing parser");
  const method: unknown = Reflect.get(target, key);
  if (typeof method !== "function") throw new Error("Missing parser method");
  return Reflect.apply(method, target, args);
}
function moduleDefault(name: string) {
  const value: unknown = sharedRequire(name);
  if (!Predicate.isObject(value)) throw new Error("Missing module");
  return value.default;
}
function render(markdown: string) {
  const unified: unknown = sharedRequire("unified");
  let processor = call(unified, "unified");
  processor = call(processor, "use", moduleDefault("remark-parse"));
  processor = call(processor, "use", CHAT_MARKDOWN_REMARK_PLUGINS);
  processor = call(processor, "use", moduleDefault("remark-rehype"), { allowDangerousHtml: true });
  processor = call(processor, "use", CHAT_MARKDOWN_REHYPE_PLUGINS);
  return call(processor, "runSync", call(processor, "parse", markdown));
}
function renderedConsumers(markdown: string) {
  const references: Array<{ tag: string; path: string | null; children: string[] }> = [];
  const visit = (node: unknown) => {
    if (!Predicate.isObject(node)) return;
    const children = Array.isArray(node.children) ? node.children : [];
    if (node.type === "element" && Predicate.isObject(node.properties)) {
      const value =
        node.tagName === "img"
          ? (node.properties.dataLocalSrc ?? node.properties.src)
          : node.properties.href;
      if ((node.tagName === "img" || node.tagName === "a") && typeof value === "string") {
        let path: string | null = null;
        if (node.tagName === "img") {
          const source = classifyMarkdownImageSource(
            typeof node.properties.dataLocalSrc === "string"
              ? normalizeMarkdownLinkDestination(value).replaceAll("\\", "/")
              : value,
          );
          if (source._tag === "WorkspaceFile") path = source.path;
        } else {
          const normalized = normalizeMarkdownLinkDestination(value);
          const uri = parseFileUrlHref(normalized);
          const href = uri ? `${uri.path}${uri.hash}` : normalized;
          const target = resolveMarkdownFileLinkTarget(
            /^[A-Za-z]:[\\/]/.test(href) ? href.replaceAll("\\", "/") : href,
          );
          path = target ? splitFilePathPosition(target).path : null;
        }
        references.push({
          tag: node.tagName,
          path,
          children: children.map((child) =>
            Predicate.isObject(child) ? String(child.tagName ?? child.type) : "unknown",
          ),
        });
      }
    }
    for (const child of children) visit(child);
  };
  visit(render(markdown));
  return references;
}
it.effect.each(["nested-markdown", "encoded-root"])(
  "copies %s with exact display, consumer identity, independent bytes and two rebuilds",
  (scenario) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = NodePath.join(
        f.sourceState,
        "browser-artifacts",
        "only-in-reference-probe.png",
      );
      const destination = NodePath.join(
        f.targetHome,
        "userdata",
        "browser-artifacts",
        "only-in-reference-probe.png",
      );
      const uniqueBytes = Buffer.concat([png, Buffer.from(scenario)]);
      yield* Effect.promise(() => NodeFSP.writeFile(source, uniqueBytes));
      const original =
        scenario === "nested-markdown"
          ? `[![thumb](${source})](${source})`
          : `![img](${source.replaceAll("/", "%2F")})`;
      const expected =
        scenario === "nested-markdown"
          ? `[![thumb](${destination})](${destination})`
          : `![img](${destination})`;
      const id = MessageId.make("reference-regression");
      yield* Effect.gen(function* () {
        yield* (yield* EventSink.EventSinkV2).commitCommand({
          commandId: CommandId.make("reference-regression"),
          threadId: ThreadId.make("parent"),
          commandType: "fixture",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("reference-regression"),
              type: "message.updated",
              threadId: ThreadId.make("parent"),
              occurredAt: now,
              payload: {
                id,
                threadId: ThreadId.make("parent"),
                runId: null,
                nodeId: null,
                role: "assistant",
                createdBy: "agent",
                creationSource: "provider",
                text: original,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
      }).pipe(
        Effect.provide(
          historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
        ),
        Effect.scoped,
      );
      const prefix = tableDigest(f.database, "orchestration_events");
      const result = yield* copyHistory(f);
      yield* assertPublisherExited(f.operationDirectory);
      expect(result.kind, JSON.stringify(result)).toBe("installed");
      if (result.kind !== "installed") return;
      const filename = NodePath.join(f.targetHome, "userdata", "statev2.sqlite");
      yield* Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (let pass = 0; pass < 3; pass++) {
          if (pass > 0) expect((yield* maintenance.rebuild).valid).toBe(true);
          const projection = yield* projections.getThreadProjection(ThreadId.make("parent"));
          const displayed = projection.messages.find((message) => message.id === id)?.text;
          expect(displayed).toBe(expected);
          expect(renderedConsumers(displayed ?? "")).toEqual(
            scenario === "nested-markdown"
              ? [
                  { tag: "a", path: destination, children: ["img"] },
                  { tag: "img", path: destination, children: [] },
                ]
              : [{ tag: "img", path: destination, children: [] }],
          );
        }
      }).pipe(
        Effect.provide(historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })))),
        Effect.scoped,
      );
      const target = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          tableDigest(target, "orchestration_events", {
            through: result.receipt.cut.applicationSequence,
          }),
        ).toEqual(prefix);
      } finally {
        target.close();
      }
      expect(yield* Effect.promise(() => NodeFSP.readFile(destination))).toEqual(uniqueBytes);
      const [before, after] = yield* Effect.promise(() =>
        Promise.all([NodeFSP.stat(source), NodeFSP.stat(destination)]),
      );
      expect([after.dev, after.ino]).not.toEqual([before.dev, before.ino]);
    }),
);

const source = "/tmp/source/browser-artifacts/shot.png";
const destination = "/tmp/longer-target/userdata/browser-artifacts/shot.png";
const relocate = (path: string) => (path === source ? destination : undefined);

it.each([
  { name: "an unmatched bracket", prefix: "[", body: "a ".repeat(2048) },
  { name: "H/W suffixes inside an atext run", prefix: "<", body: "1h_H_w_W".repeat(1024) },
])("preserves owned references after $name and long non-email text", ({ prefix, body }) => {
  const text = `person@example.test http://example.test www.example.test\n\n${prefix}${body}\n\n![image](${source})`;
  expect(historyReferences(text).paths).toEqual([source]);
  expect(rewriteMarkdownAssets(text, relocate)).toEqual({
    text: text.replace(source, destination),
    changes: [{ from: source, to: destination, offset: text.indexOf(source) }],
  });
});

it("retains valid email local parts and nested image and anchor consumers", () => {
  const text = `a+b_c.d-e@example.test [![image](${source})](${source}:12:7)\r\nuser&#64;example.test [file](${source})`;
  const result = rewriteMarkdownAssets(text, relocate);
  expect(result.text).toBe(text.replaceAll(source, destination));
  expect(result.changes).toHaveLength(3);
  expect(renderedConsumers(result.text).map((ref) => ref.path)).toEqual([
    null,
    destination,
    destination,
    null,
    destination,
  ]);
});

it.each(["http://example.test", "https://example.test", "www.example.test"])(
  "retains references exposed by %s consuming a code delimiter",
  (external) => {
    const text = `${external}/\` ![image](${source}) [file](${source}) \``;
    expect(historyReferences(text).paths).toEqual([source]);
    expect(rewriteMarkdownAssets(text, relocate).text).toBe(text.replaceAll(source, destination));
  },
);

it("preserves email parsing through CRLF containers and over-indented list text", () => {
  const text = `> person@example.test\r\n> ![image](${source})\r\n\r\n-      person@example.test [file](${source})`;
  expect(historyReferences(text).paths).toEqual([source]);
  expect(rewriteMarkdownAssets(text, relocate).text).toBe(text.replace(source, destination));
  expect(historyReferences(`![next](${source})`).paths).toEqual([source]);
});

it("preserves the rendered-history refusal for leading-BOM destination offsets", () => {
  const text = `\ufeffperson@example.test [file](${source})`;
  expect(historyReferences(text).paths).toEqual([source]);
  expect(() => rewriteMarkdownAssets(text, relocate)).toThrow("changed-rendered-history");
});

it("preserves UTF-16 text, CRLF, angle destinations and misleading titles with source-ordered evidence", () => {
  const text = `😀 prefix\r\n[![thumb](<${source}> "title ](/tmp/decoy.png)")](${source} 'outer')\r\n![last](${source})`;
  const expected = `😀 prefix\r\n[![thumb](<${destination}> "title ](/tmp/decoy.png)")](${destination} 'outer')\r\n![last](${destination})`;
  const result = rewriteMarkdownAssets(text, relocate);
  expect(result.text).toBe(expected);
  expect(result.changes).toEqual(
    [...text.matchAll(/\/tmp\/source\/browser-artifacts\/shot\.png/g)].map((match) => ({
      from: source,
      to: destination,
      offset: match.index,
    })),
  );
  expect(renderedConsumers(result.text).map((ref) => ref.path)).toEqual([
    destination,
    destination,
    destination,
  ]);
});

it("edits one definition once for compatible repeated image and anchor consumers", () => {
  const text = `![a][same] [b][same] ![c][same]\n\n[same]: <${source}> "keep title"\n[unused]: /tmp/never.png\n[same]: /tmp/ignored.png`;
  const result = rewriteMarkdownAssets(text, relocate);
  expect(result.text).toBe(text.replace(source, destination));
  expect(result.changes).toHaveLength(1);
  expect(historyReferences(text).paths).toEqual([source]);
  expect(renderedConsumers(result.text).map((ref) => ref.path)).toEqual([
    destination,
    destination,
    destination,
  ]);
});

it("refuses one definition whose image and anchor require different file meanings", () => {
  const text = `![image][same] [anchor][same]\n\n[same]: ${source}:12:7`;
  expect(new Set(historyReferences(text).paths)).toEqual(new Set([source, `${source}:12:7`]));
  expect(() => rewriteMarkdownAssets(text, (path) => path.replace("/source/", "/target/"))).toThrow(
    "conflicting-reference-spans",
  );
});

it("keeps parser destination buffers, Windows exits and per-parse definition ownership", () => {
  const windows = String.raw`C:\Users\test\.t3\shot.png`;
  const text = `![win](${windows}) [win](${windows}) ![ref][id]\n\n[id]: ${windows}`;
  for (let pass = 0; pass < 3; pass++) {
    expect(renderedConsumers(text).map((ref) => ref.path)).toEqual([
      windows,
      "C:/Users/test/.t3/shot.png",
      "C:/Users/test/.t3/shot.png",
    ]);
    expect(markdownAssetReferences(text)).toHaveLength(3);
    expect(rewriteMarkdownAssets(text, () => undefined).text).toBe(text);
    expect(historyReferences("![unresolved][id]").paths).toEqual([]);
    expect(rewriteMarkdownAssets(`![ok](${source})`, relocate).text).toBe(`![ok](${destination})`);
  }
});

it.each([
  source.replaceAll("/", "%2F"),
  source.replaceAll("/", "&#47;"),
  source.replace("shot", "sh&#111;t"),
])("resolves decoded parser destination %s", (authored) => {
  expect(historyReferences(`![img](${authored})`).paths).toEqual([source]);
  expect(rewriteMarkdownAssets(`![img](${authored})`, relocate).text).toBe(
    `![img](${destination})`,
  );
});

it("uses token lengths for escaped parentheses and encodes only the destination path", () => {
  const original = "/tmp/source/browser-artifacts/a (b)#?%2F.png";
  const target = "/tmp/target/userdata/browser-artifacts/c (d)#?%2F.png";
  const authored = "/tmp/source/browser-artifacts/a%20\\(b\\)%23%3F%252F.png";
  const text = `![alt](${authored} "retained")`;
  expect(historyReferences(text).paths).toEqual([original]);
  const result = rewriteMarkdownAssets(text, (p) => (p === original ? target : undefined));
  expect(result.text).toBe(
    `![alt](/tmp/target/userdata/browser-artifacts/c%20%28d%29%23%3F%252F.png "retained")`,
  );
  expect(renderedConsumers(result.text)[0]?.path).toBe(target);
});

it.each([":12:7", "#L12C7", "?download=1#L12C7"])(
  "preserves anchor position and suffix %s",
  (suffix) => {
    const text = `[file](${source}${suffix})`;
    expect(historyReferences(text).paths).toEqual([source]);
    const result = rewriteMarkdownAssets(text, relocate);
    expect(result.text).toBe(`[file](${destination}${suffix})`);
    expect(
      splitFilePathPosition(resolveMarkdownFileLinkTarget(`${destination}${suffix}`) ?? ""),
    ).toEqual({ path: destination, line: 12, column: 7 });
  },
);

it("keeps image filenames with numeric tails distinct from anchor positions", () => {
  const text = `![image](${source}:12:7)`;
  expect(historyReferences(text).paths).toEqual([`${source}:12:7`]);
  expect(rewriteMarkdownAssets(text, relocate).text).toBe(text);
  const result = rewriteMarkdownAssets(text, (p) =>
    p === `${source}:12:7` ? `${destination}:12:7` : undefined,
  );
  expect(renderedConsumers(result.text)[0]?.path).toBe(`${destination}:12:7`);
});

it("retains file URI and bare media query/fragment semantics", () => {
  for (const prefix of ["", "file://"]) {
    const text = `![clip](${prefix}${source}?download=1#t=10,20)`;
    const result = rewriteMarkdownAssets(text, relocate);
    expect(result.text).toBe(`![clip](${prefix}${destination}?download=1#t=10,20)`);
    expect(
      resolveMediaSource(`${prefix}${destination}?download=1#t=10,20`, {
        threadId: ThreadId.make("parent"),
        imageEmbed: true,
      }),
    ).toMatchObject({
      access: "environment",
      resource: { path: destination },
      srcFragment: "#t=10,20",
    });
  }
});

it("separates literal screenshot/icon paths from classify-once viewed-image sources", () => {
  for (const filename of [
    "literal%2F.png",
    "literal%20.png",
    "literal#?.png",
    "space (parens).png",
    "broken%E0%A4.png",
  ]) {
    const literal = `/tmp/source/browser-artifacts/${filename}`;
    const target = `/tmp/target/userdata/browser-artifacts/${filename}`;
    const url = NodeURL.pathToFileURL(literal).pathname;
    const targetUrl = NodeURL.pathToFileURL(target)
      .pathname.replaceAll("(", "%28")
      .replaceAll(")", "%29");
    const value = { screenshotPath: literal, viewedImagePath: url };
    expect(historyReferences(value, true).paths).toEqual([literal]);
    const result = relocateHistoryValue(value, (p) => (p === literal ? target : undefined), true);
    expect(result.value).toEqual({ screenshotPath: target, viewedImagePath: targetUrl });
    expect(resolveViewedImageAsset(url, { threadId: ThreadId.make("parent") })).toMatchObject({
      resource: { path: literal },
    });
    expect(resolveViewedImageAsset(targetUrl, { threadId: ThreadId.make("parent") })).toMatchObject(
      { resource: { path: target } },
    );
    expect(renderedConsumers(`![image](${targetUrl})`)[0]?.path).toBe(target);
  }
});

it("keeps JSON token offsets separate from emoji, escapes, inner Markdown and array field contexts", () => {
  const encoded = source.replaceAll("/", "%2F");
  const inner = `😀 [![a](${source})](${source})`;
  const json = `{ "keep": "\\u00e9", "nested" : [{"screenshotPath" : [${JSON.stringify(source)},${JSON.stringify(source)}]}], "text" : ${JSON.stringify(inner)}, "viewedImagePath" : ${JSON.stringify(encoded)} }`;
  const expected = `{ "keep": "\\u00e9", "nested" : [{"screenshotPath" : [${JSON.stringify(destination)},${JSON.stringify(destination)}]}], "text" : ${JSON.stringify(inner.replaceAll(source, destination))}, "viewedImagePath" : ${JSON.stringify(destination)} }`;
  expect(historyReferences({ output: json }, true).paths).toEqual([source]);
  expect(relocateHistoryValue({ output: json }, relocate, true).value).toEqual({
    output: expected,
  });
});

it("refuses unsupported owned autolinks and ambiguous suffix decoding while leaving controls exact", () => {
  const auto = `<file://${source}>`;
  expect(historyReferences(auto).paths).toEqual([source]);
  expect(() => rewriteMarkdownAssets(auto, relocate)).toThrow("unsupported-renderable-reference");
  expect(() => rewriteMarkdownAssets(`[a](${source}%3A12)`, relocate)).toThrow(
    "incompatible-reference-meaning",
  );
  for (const text of [
    `![broken](${source}`,
    `![img](FILE://${source})`,
    `!\\[escaped](${source})`,
    `\`![code](${source})\``,
    `\`\`\`md\n![code](${source})\n\`\`\``,
    `plain ${source}`,
    `![external](https://example.test/image.png)`,
    `[relative](workspace/file.png)`,
  ]) {
    expect(historyReferences(text).paths).toEqual([]);
    expect(rewriteMarkdownAssets(text, relocate)).toEqual({ text, changes: [] });
  }
});

const assertPublisherExited = (operationDirectory: string) =>
  Effect.promise(async () => {
    const value: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(operationDirectory, "publisher.json"), "utf8"),
    );
    if (!Predicate.isObject(value) || typeof value.pid !== "number")
      throw new Error("Missing captured publisher");
    try {
      process.kill(value.pid, 0);
      throw new Error("Publisher still alive");
    } catch (error) {
      expect(error).toMatchObject({ code: "ESRCH" });
    }
    process.stdout.write(`Captured publisher PID ${value.pid} exited.\n`);
  });

it.effect(
  "copies literal screenshot and classify-once viewed-image names without double decoding",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const literal = NodePath.join(f.sourceState, "browser-artifacts", "literal%2F#?.png");
      const viewed = NodePath.join(f.sourceState, "browser-artifacts", "literal%20.png");
      const targetLiteral = NodePath.join(
        f.targetHome,
        "userdata",
        "browser-artifacts",
        "literal%2F#?.png",
      );
      const targetViewed = NodePath.join(
        f.targetHome,
        "userdata",
        "browser-artifacts",
        "literal%20.png",
      );
      const bytes = [
        Buffer.concat([png, Buffer.from("literal")]),
        Buffer.concat([png, Buffer.from("viewed")]),
      ];
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(literal, bytes[0] ?? png),
          NodeFSP.writeFile(viewed, bytes[1] ?? png),
        ]),
      );
      const authoredViewed = NodeURL.pathToFileURL(viewed).pathname;
      const finalViewed = NodeURL.pathToFileURL(targetViewed).pathname;
      yield* Effect.gen(function* () {
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          ThreadId.make("parent"),
        );
        const item = projection.turnItems.find((item) => item.id === "browser-tool");
        if (item?.type !== "dynamic_tool") return yield* Effect.die("Missing tool fixture");
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("literal-and-viewed"),
              type: "turn-item.updated",
              threadId: projection.thread.id,
              occurredAt: now,
              payload: {
                ...item,
                output: { screenshotPath: literal },
                viewedImagePath: authoredViewed,
              },
            },
          ],
        });
      }).pipe(
        Effect.provide(
          historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
        ),
        Effect.scoped,
      );
      const prefix = tableDigest(f.database, "orchestration_events");
      const result = yield* copyHistory(f);
      yield* assertPublisherExited(f.operationDirectory);
      expect(result.kind, JSON.stringify(result)).toBe("installed");
      if (result.kind !== "installed") return;
      const filename = NodePath.join(f.targetHome, "userdata", "statev2.sqlite");
      yield* Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (let pass = 0; pass < 3; pass++) {
          if (pass > 0) expect((yield* maintenance.rebuild).valid).toBe(true);
          const projection = yield* projections.getThreadProjection(ThreadId.make("parent"));
          const item = projection.turnItems.find((item) => item.id === "browser-tool");
          expect(item).toMatchObject({
            output: { screenshotPath: targetLiteral },
            viewedImagePath: finalViewed,
          });
          expect(
            resolveViewedImageAsset(finalViewed, { threadId: ThreadId.make("parent") }),
          ).toMatchObject({ resource: { path: targetViewed } });
        }
      }).pipe(
        Effect.provide(historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })))),
        Effect.scoped,
      );
      const target = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      const journal = new NodeSqlite.DatabaseSync(
        NodePath.join(f.operationDirectory, "capture.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          tableDigest(target, "orchestration_events", {
            through: result.receipt.cut.applicationSequence,
          }),
        ).toEqual(prefix);
        for (const path of [literal, viewed])
          expect(
            journal.prepare("SELECT status,required FROM asset_references WHERE path=?").get(path),
          ).toMatchObject({ status: "copied", required: 1 });
      } finally {
        target.close();
        journal.close();
      }
      for (const [index, targetPath] of [targetLiteral, targetViewed].entries()) {
        expect(yield* Effect.promise(() => NodeFSP.readFile(targetPath))).toEqual(bytes[index]);
        const sourcePath = index === 0 ? literal : viewed;
        const [a, b] = yield* Effect.promise(() =>
          Promise.all([NodeFSP.stat(sourcePath), NodeFSP.stat(targetPath)]),
        );
        expect([a.dev, a.ino]).not.toEqual([b.dev, b.ino]);
      }
    }),
);

it.each(["duplicate member", "attachment metadata"])(
  "preserves JSON %s outside the admitted reference walk",
  (scenario) => {
    const input =
      scenario === "duplicate member"
        ? `{ "screenshotPath": "${source}", "screenshotPath": "/tmp/external.png" }`
        : JSON.stringify({
            attachments: [
              {
                type: "image",
                id: "parent-11111111-1111-4111-8111-111111111111-png",
                name: `![name](${source})`,
                mimeType: "image/png",
                sizeBytes: 1,
              },
            ],
          });
    expect(historyReferences({ output: input }, true).paths).not.toContain(source);
    expect(relocateHistoryValue({ output: input }, relocate, true)).toEqual({
      value: { output: input },
      changes: [],
    });
  },
);
