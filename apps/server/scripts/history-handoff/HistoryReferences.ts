import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "../../../../packages/client-runtime/src/markdownImages.ts";
import {
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { ChatAttachment } from "@t3tools/contracts";
import { attachmentRelativePath } from "../../src/attachmentStore.ts";
import { HistoryAssetRefused } from "./HistoryAssets.ts";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";

const sharedRequire = NodeModule.createRequire(
  new URL("../../../../packages/shared/package.json", import.meta.url),
);
const unifiedModule: unknown = sharedRequire("unified");
const remarkModule: unknown = sharedRequire("remark-parse");
const rehypeModule: unknown = sharedRequire("remark-rehype");
function callMethod(target: unknown, key: string, args: readonly unknown[]) {
  if (!Predicate.isObject(target) && typeof target !== "function")
    throw new Error("Unavailable Markdown parser");
  const method: unknown = Reflect.get(target, key);
  if (typeof method !== "function") throw new Error("Unavailable Markdown parser");
  const result: unknown = Reflect.apply(method, target, args);
  return result;
}
const processor = callMethod(unifiedModule, "unified", []);
if (!Predicate.isObject(remarkModule) || typeof remarkModule.default !== "function")
  throw new Error("Unavailable Markdown parser");
const parser = callMethod(callMethod(processor, "use", [remarkModule.default]), "use", [
  CHAT_MARKDOWN_REMARK_PLUGINS,
]);
if (!Predicate.isObject(rehypeModule) || typeof rehypeModule.default !== "function")
  throw new Error("Unavailable Markdown HTML parser");
const renderer = callMethod(
  callMethod(callMethod(parser, "copy", []), "use", [
    rehypeModule.default,
    { allowDangerousHtml: true },
  ]),
  "use",
  [CHAT_MARKDOWN_REHYPE_PLUGINS],
);
const positionSchema = Schema.Struct({
  start: Schema.Struct({ offset: Schema.Number }),
  end: Schema.Struct({ offset: Schema.Number }),
});
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const decodeAttachment = Schema.decodeUnknownSync(ChatAttachment);

type MarkdownState = (code: number | null) => unknown;
type MarkdownEffects = {
  enter(type: "data"): void;
  exit(type: "data"): void;
  consume(code: number): void;
  check(construct: unknown, ok: MarkdownState, nok: MarkdownState): MarkdownState;
};

const emailPrefix = {
  partial: true,
  tokenize(effects: MarkdownEffects, ok: MarkdownState, nok: MarkdownState) {
    let present = false;
    return scan;
    function scan(code: number | null): unknown {
      if (
        code !== null &&
        (code === 43 ||
          code === 45 ||
          code === 46 ||
          code === 95 ||
          (code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122))
      ) {
        if (!present) effects.enter("data");
        present = true;
        effects.consume(code);
        return scan;
      }
      if (present) effects.exit("data");
      return present && code === 64 ? ok(code) : nok(code);
    }
  },
};

function guardImpossibleEmailStarts(this: { data(): { micromarkExtensions: unknown[] } }) {
  function clone(construct: unknown): unknown {
    if (Array.isArray(construct)) return construct.map(clone);
    if (!Predicate.isObject(construct) || construct.name !== "emailAutolink") return construct;
    const { tokenize, previous } = construct;
    if (typeof tokenize !== "function" || typeof previous !== "function")
      throw new Error("Unavailable Markdown email tokenizer");
    const originalTokenize = tokenize;
    return {
      ...construct,
      tokenize(
        this: { previous: number | null },
        effects: MarkdownEffects,
        ok: MarkdownState,
        nok: MarkdownState,
      ) {
        if (!previous.call(this, this.previous)) return nok;
        const delegate: MarkdownState = (code) => {
          const start: unknown = originalTokenize.call(this, effects, ok, nok);
          if (typeof start !== "function") throw new Error("Unavailable Markdown email state");
          return start(code);
        };
        return effects.check(emailPrefix, delegate, nok);
      },
    };
  }
  const data = this.data();
  data.micromarkExtensions = data.micromarkExtensions.map((extension) =>
    !Predicate.isObject(extension) || !Predicate.isObject(extension.text)
      ? extension
      : {
          ...extension,
          text: Object.fromEntries(
            Object.entries(extension.text).map(([code, constructs]) => [code, clone(constructs)]),
          ),
        },
  );
}

function visibleFields(value: Schema.Json) {
  if (!isJsonObject(value)) return undefined;
  if (typeof value.role === "string" && typeof value.text === "string")
    return ["text", "attachments"];
  switch (value.type) {
    case "user_message":
    case "assistant_message":
      return ["text", "attachments"];
    case "reasoning":
      return ["text"];
    case "proposed_plan":
      return ["markdown"];
    case "dynamic_tool":
      return ["output", "viewedImagePath"];
    case "subagent":
      return ["prompt", "progress", "result"];
    default:
      return undefined;
  }
}

type Context = "image" | "anchor" | "viewed-image" | "screenshot";
type Span = { readonly start: number; readonly end: number; readonly authored: string };
type Target =
  | { readonly kind: "span"; readonly span: Span }
  | { readonly kind: "citation-path"; readonly span: Span }
  | { readonly kind: "field" }
  | { readonly kind: "unsupported" };
type Meaning = {
  readonly path: string;
  readonly fragment: string;
  readonly line?: number;
  readonly column?: number;
};
type Reference = {
  readonly context: Context;
  readonly value: string;
  readonly meaning: Meaning;
  readonly target: Target;
};
type Edit = { readonly span: Span; readonly replacement: string; readonly identity: string };

function fileMeaning(context: Context, value: string): Meaning | null {
  if (context === "screenshot" && !/^file:/i.test(value))
    return isAbsolutePath(value) ? { path: value, fragment: "" } : null;
  const source = normalizeMarkdownLinkDestination(value);
  if (context === "anchor") {
    const uri = parseFileUrlHref(source);
    const rewritten = uri ? `${uri.path}${uri.hash}` : source;
    const href = isWindowsAbsolutePath(rewritten) ? rewritten.replaceAll("\\", "/") : rewritten;
    const position = parseMarkdownFileLink(href);
    return position && isAbsolutePath(position.path)
      ? { ...position, fragment: markdownImageSourceFragment(source) }
      : null;
  }
  const image = classifyMarkdownImageSource(source);
  if (image._tag !== "WorkspaceFile") return null;
  const position =
    context === "viewed-image" ? splitFilePathPosition(image.path) : { path: image.path };
  return { ...position, fragment: markdownImageSourceFragment(source) };
}

function reference(context: Context, value: string, target: Target): Reference | null {
  const meaning = fileMeaning(context, value);
  return meaning === null ? null : { context, value, meaning, target };
}

function refused(reference: string, reason = "unsupported-renderable-reference"): never {
  throw new HistoryAssetRefused({ reason, reference });
}

function positionKey(value: unknown): string | undefined {
  if (!Schema.is(positionSchema)(value)) return undefined;
  return `${value.start.offset}:${value.end.offset}`;
}

function markdownPlan(markdown: string) {
  if (
    !markdown.includes("[") &&
    !markdown.includes("<") &&
    !markdown.includes(":codex-file-citation")
  )
    return {
      references: new Array<Reference>(),
      structure: (_relocate: (path: string) => string | undefined) => markdown,
    };
  const destinations = new WeakMap<object, Span>();
  const citationPaths = new WeakMap<object, Array<Span | undefined>>();
  function tokenSpan(token: unknown): Span {
    const position = Schema.decodeUnknownSync(positionSchema)(token);
    return {
      start: position.start.offset,
      end: position.end.offset,
      authored: markdown.slice(position.start.offset, position.end.offset),
    };
  }
  function captureDestinations(this: { data(): { fromMarkdownExtensions?: unknown[] } }) {
    const data = this.data();
    function capture(this: { stack: object[]; buffer(): void }, token: unknown) {
      const node = this.stack.at(-1);
      if (node) destinations.set(node, tokenSpan(token));
      this.buffer();
    }
    (data.fromMarkdownExtensions ??= []).push({
      enter: {
        resourceDestinationString: capture,
        definitionDestinationString: capture,
        directiveTextAttributeName(
          this: { stack: object[]; sliceSerialize(token: unknown): string },
          token: unknown,
        ) {
          const node = this.stack.at(-2);
          if (!node || this.sliceSerialize(token) !== "path") return;
          const paths = citationPaths.get(node) ?? [];
          paths.push(undefined);
          citationPaths.set(node, paths);
        },
        directiveTextAttributeValue(
          this: { stack: object[]; data: { directiveAttributes?: Array<[string, string]> } },
          token: unknown,
        ) {
          const node = this.stack.at(-2);
          const paths = node ? citationPaths.get(node) : undefined;
          if (paths && this.data.directiveAttributes?.at(-1)?.[0] === "path")
            paths[paths.length - 1] = tokenSpan(token);
        },
      },
    });
  }
  const current = callMethod(callMethod(renderer, "copy", []), "use", [guardImpossibleEmailStarts]);
  callMethod(current, "use", [captureDestinations]);
  const ast = callMethod(current, "parse", [markdown]);
  const definitions = new Map<string, object>();
  const sources = new Map<string, { context: Context; target: Target }>();
  const walk = (value: unknown, visit: (node: Record<string, unknown>) => void) => {
    if (!Predicate.isObject(value)) return;
    visit(value);
    if (Array.isArray(value.children)) for (const child of value.children) walk(child, visit);
  };
  walk(ast, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node);
  });
  walk(ast, (node) => {
    const citation = node.type === "textDirective" && node.name === "codex-file-citation";
    if (
      !citation &&
      !["link", "image", "linkReference", "imageReference"].includes(String(node.type))
    )
      return;
    const key = positionKey(node.position);
    if (key === undefined) return;
    const owner = typeof node.identifier === "string" ? definitions.get(node.identifier) : node;
    const paths = citationPaths.get(node);
    const span = citation
      ? paths?.length === 1
        ? paths[0]
        : undefined
      : owner
        ? destinations.get(owner)
        : undefined;
    sources.set(key, {
      context: node.type === "image" || node.type === "imageReference" ? "image" : "anchor",
      target: span ? { kind: citation ? "citation-path" : "span", span } : { kind: "unsupported" },
    });
  });
  const tree = callMethod(current, "runSync", [ast, { value: markdown }]);
  const references: Reference[] = [];
  const byNode = new WeakMap<object, Reference>();
  walk(tree, (node) => {
    if (node.type !== "element" || !Predicate.isObject(node.properties)) return;
    const isImage = node.tagName === "img";
    const local = isImage ? node.properties.dataLocalSrc : undefined;
    const value =
      typeof local === "string"
        ? normalizeMarkdownLinkDestination(local).replaceAll("\\", "/")
        : node.properties[isImage ? "src" : "href"];
    if (typeof value !== "string") return;
    const context = isImage ? "image" : "anchor";
    const key = positionKey(node.position);
    const source = key === undefined ? undefined : sources.get(key);
    const ref = reference(
      context,
      value,
      source?.context === context ? source.target : { kind: "unsupported" },
    );
    if (ref) {
      references.push(ref);
      byNode.set(node, ref);
    }
  });
  function structure(value: unknown, relocate: (path: string) => string | undefined): unknown {
    if (Array.isArray(value)) return value.map((child) => structure(child, relocate));
    if (!Predicate.isObject(value)) return value;
    const ref = byNode.get(value);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "position")
        .map(([key, child]) => {
          if (key === "properties" && ref && Predicate.isObject(child)) {
            return [
              key,
              Object.fromEntries(
                Object.entries(child).map(([name, property]) => [
                  name,
                  (ref.context === "image" ? ["src", "dataLocalSrc"] : ["href"]).includes(name)
                    ? {
                        context: ref.context,
                        ...ref.meaning,
                        path: relocate(ref.meaning.path) ?? ref.meaning.path,
                      }
                    : structure(property, relocate),
                ]),
              ),
            ];
          }
          return [key, structure(child, relocate)];
        }),
    );
  }
  return {
    references,
    structure: (relocate: (path: string) => string | undefined) => structure(tree, relocate),
  };
}

export function markdownAssetReferences(markdown: string) {
  return markdownPlan(markdown).references.map((ref) =>
    "span" in ref.target
      ? {
          kind: "path" as const,
          value: ref.value,
          start: ref.target.span.start,
          end: ref.target.span.end,
        }
      : { kind: "unsupported" as const, value: ref.value },
  );
}

function replacement(ref: Reference, destination: string) {
  if (ref.target.kind === "unsupported") refused(ref.meaning.path);
  if (ref.target.kind === "citation-path")
    return destination.replace(/[&"'<>}=`\s]/g, (character) => `&#${character.charCodeAt(0)};`);
  if (ref.context === "screenshot" && !/^file:/i.test(ref.value)) return destination;
  const authored = ref.target.kind === "span" ? ref.target.span.authored : ref.value;
  const normalized = normalizeMarkdownLinkDestination(ref.value);
  const suffixIndex = normalized.search(/[?#]/);
  const path = suffixIndex < 0 ? normalized : normalized.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : normalized.slice(suffixIndex);
  const position =
    ref.context === "anchor" || ref.context === "viewed-image"
      ? (/:\d+(?::\d+)?$/.exec(path)?.[0] ?? "")
      : "";
  if (!normalizeMarkdownLinkDestination(authored).endsWith(position + suffix))
    refused(ref.meaning.path, "unsupported-reference-suffix");
  const uri = NodeURL.pathToFileURL(destination);
  const encoded = (/^file:/i.test(ref.value) ? uri.href : uri.pathname)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
  const to = encoded + position + suffix;
  const meaning = fileMeaning(ref.context, to);
  if (JSON.stringify(meaning) !== JSON.stringify({ ...ref.meaning, path: destination }))
    refused(ref.meaning.path, "incompatible-reference-meaning");
  return to;
}

function applyEdits(text: string, edits: readonly Edit[]) {
  const ordered: Edit[] = [];
  const boundary = (offset: number) =>
    !(
      offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(text[offset] ?? "")
    );
  for (const edit of edits.toSorted(
    (a, b) => a.span.start - b.span.start || a.span.end - b.span.end,
  )) {
    const { start, end, authored } = edit.span;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= end ||
      end > text.length ||
      !boundary(start) ||
      !boundary(end) ||
      text.slice(start, end) !== authored
    )
      refused(authored, "invalid-reference-span");
    const previous = ordered.at(-1);
    if (previous && start < previous.span.end) {
      if (
        start === previous.span.start &&
        end === previous.span.end &&
        edit.replacement === previous.replacement &&
        edit.identity === previous.identity
      )
        continue;
      refused(authored, "conflicting-reference-spans");
    }
    ordered.push(edit);
  }
  let result = text;
  for (const edit of ordered.toReversed())
    result = result.slice(0, edit.span.start) + edit.replacement + result.slice(edit.span.end);
  return {
    text: result,
    changes: ordered.map((edit) => ({
      from: edit.span.authored,
      to: edit.replacement,
      offset: edit.span.start,
    })),
  };
}

export function rewriteMarkdownAssets(
  text: string,
  relocate: (path: string) => string | undefined,
) {
  const plan = markdownPlan(text);
  const edits: Edit[] = [];
  const moved = new Map<string, string>();
  for (const ref of plan.references) {
    const destination = relocate(ref.meaning.path);
    if (destination === undefined) continue;
    if (moved.has(ref.meaning.path) && moved.get(ref.meaning.path) !== destination)
      refused(ref.meaning.path, "conflicting-reference-destination");
    moved.set(ref.meaning.path, destination);
    const to = replacement(ref, destination);
    if (!("span" in ref.target)) refused(ref.meaning.path);
    edits.push({
      span: ref.target.span,
      replacement: to,
      identity: JSON.stringify({ from: ref.meaning, to: destination }),
    });
  }
  const result = applyEdits(text, edits);
  if (
    edits.length &&
    JSON.stringify(plan.structure((path) => moved.get(path))) !==
      JSON.stringify(markdownPlan(result.text).structure(() => undefined))
  )
    refused(text, "changed-rendered-history");
  return result;
}

function directReference(key: string, value: string) {
  return key === "screenshotPath" || key === "viewedImagePath"
    ? reference(key === "screenshotPath" ? "screenshot" : "viewed-image", value, { kind: "field" })
    : null;
}

export function historyReferences(value: unknown, structuredTools = false) {
  const paths = new Set<string>();
  const attachments = new Set<string>();
  const unsupportedAttachments = new Set<string>();
  const visit = (node: Schema.Json, key: string) => {
    if (typeof node === "string") {
      if (key === "screenshotPath" || key === "viewedImagePath") {
        const ref = directReference(key, node);
        if (ref) paths.add(ref.meaning.path);
        return;
      }
      if (structuredTools && /^[\s]*[[{]/.test(node)) {
        let embedded: Schema.Json | undefined;
        try {
          embedded = decodeJson(JSON.parse(node));
        } catch {}
        if (embedded !== undefined) {
          visit(embedded, "");
          return;
        }
      }
      for (const ref of markdownPlan(node).references) paths.add(ref.meaning.path);
    } else if (Array.isArray(node)) {
      for (const child of node) visit(child, key);
    } else if (isJsonObject(node)) {
      if (key === "attachments" && typeof node.type === "string" && typeof node.id === "string") {
        const relative = attachmentRelativePath(decodeAttachment(node));
        if (relative !== null) attachments.add(relative);
        else unsupportedAttachments.add(node.id);
        return;
      }
      for (const [name, child] of Object.entries(node)) visit(child, name);
    }
  };
  const content = decodeJson(value);
  const fields = visibleFields(content);
  if (fields !== undefined && isJsonObject(content)) {
    for (const field of fields) if (content[field] !== undefined) visit(content[field], field);
  } else visit(content, "");
  return {
    paths: [...paths],
    attachments: [...attachments],
    unsupportedAttachments: [...unsupportedAttachments],
  };
}

export function relocateHistoryValue(
  value: unknown,
  relocate: (path: string) => string | undefined,
  structuredTools = false,
) {
  const changes: Array<{ from: string; to: string }> = [];
  const direct = (value: string, key: string) => {
    const ref = directReference(key, value);
    if (ref === null) return value;
    const destination = relocate(ref.meaning.path);
    if (destination === undefined) return value;
    const to = replacement(ref, destination);
    changes.push({ from: value, to });
    return to;
  };
  const text = (value: string, key: string): string => {
    if (["screenshotPath", "viewedImagePath"].includes(key)) return direct(value, key);
    if (structuredTools && /^[\s]*[[{]/.test(value)) {
      let embedded: Schema.Json | undefined;
      try {
        embedded = decodeJson(JSON.parse(value));
      } catch {}
      if (embedded !== undefined) {
        const edits: Edit[] = [];
        const tokens = [
          ...value.matchAll(
            /"(?:\\.|[^"\\])*"|[{}[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
          ),
        ];
        let cursor = 0;
        const take = () => {
          const token = tokens[cursor++];
          if (token === undefined) refused(value, "invalid-structured-reference");
          return token;
        };
        type StringToken = { readonly token: (typeof tokens)[number]; readonly field: string };
        const visitToken = (field: string): StringToken[] => {
          const token = take();
          let strings: StringToken[] = [];
          if (token[0] === "{") {
            const members = new Map<string, StringToken[]>();
            while (tokens[cursor]?.[0] !== "}") {
              const name: unknown = JSON.parse(take()[0]);
              if (typeof name !== "string" || take()[0] !== ":")
                refused(value, "invalid-structured-reference");
              members.set(name, visitToken(name));
              if (tokens[cursor]?.[0] === ",") take();
            }
            take();
            strings = [...members.values()].flat();
          } else if (token[0] === "[") {
            while (tokens[cursor]?.[0] !== "]") {
              strings.push(...visitToken(field));
              if (tokens[cursor]?.[0] === ",") take();
            }
            take();
          } else if (token[0].startsWith('"')) {
            strings.push({ token, field });
          }
          return field === "attachments" ? [] : strings;
        };
        for (const { token, field } of visitToken("").toSorted(
          (a, b) => a.token.index - b.token.index,
        )) {
          const decoded: unknown = JSON.parse(token[0]);
          if (typeof decoded !== "string") refused(value, "invalid-structured-reference");
          const replaced = text(decoded, field);
          if (replaced !== decoded)
            edits.push({
              span: { start: token.index, end: token.index + token[0].length, authored: token[0] },
              replacement: JSON.stringify(replaced),
              identity: decoded,
            });
        }
        return applyEdits(value, edits).text;
      }
    }
    const result = rewriteMarkdownAssets(value, relocate);
    changes.push(...result.changes);
    return result.text;
  };
  const visit = (node: Schema.Json, key: string): Schema.Json => {
    if (typeof node === "string") return text(node, key);
    if (key === "attachments") return node;
    if (Array.isArray(node)) return node.map((child) => visit(child, key));
    if (isJsonObject(node))
      return Object.fromEntries(
        Object.entries(node).map(([name, child]) => [name, visit(child, name)]),
      );
    return node;
  };
  const content = decodeJson(value);
  const fields = visibleFields(content);
  if (fields !== undefined && isJsonObject(content)) {
    const result = Object.fromEntries(Object.entries(content));
    for (const field of fields)
      if (content[field] !== undefined) result[field] = visit(content[field], field);
    return { value: result, changes };
  }
  return { value: visit(content, ""), changes };
}
