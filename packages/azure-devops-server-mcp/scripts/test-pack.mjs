import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeVM from "node:vm";
import * as NodeTest from "node:test";

NodeTest.test(
  "packs the installed Effect version into the client dependency and matching MCP notice",
  async () => {
    const url = new URL("./pack.mjs", import.meta.url);
    const source = await NodeFSP.readFile(url, "utf8");
    const files = new Map();
    const reads = [];
    const commit = "a".repeat(40);
    const context = NodeVM.createContext({
      process: {
        argv: ["node", url.pathname, "--out", "/synthetic/out", "--source", commit],
        stdout: { write() {} },
      },
    });
    const mocks = {
      esbuild: { build: async () => {} },
      "@jonathanm10/azure-devops-server-client": { operationCatalog: [], CLIENT_VERSION: "0.1.0" },
      "../src/server.ts": { MCP_VERSION: "0.1.0" },
      "node:fs/promises": {
        mkdtemp: async () => "/synthetic/staging",
        mkdir: async () => {},
        cp: async () => {},
        chmod: async () => {},
        rm: async () => {},
        readFile: async (path) => {
          reads.push(path);
          if (path.endsWith("effect/package.json"))
            return JSON.stringify({ name: "effect", version: "4.1.0", license: "MIT" });
          if (path.endsWith("effect/LICENSE")) return "Synthetic installed Effect 4.1.0 license";
          if (path.endsWith("/package.json"))
            return JSON.stringify({
              name: path.includes("server-client")
                ? "@jonathanm10/azure-devops-server-client"
                : "@jonathanm10/azure-devops-server-mcp",
              version: "0.1.0",
              dependencies: { effect: "catalog:" },
            });
          throw new Error(`Unexpected read ${path}`);
        },
        writeFile: async (path, contents) => {
          files.set(path, contents);
        },
      },
      "node:child_process": {
        execFileSync: (command, args) =>
          command === "git" && args[0] === "rev-parse" ? commit : "",
      },
    };
    const module = new NodeVM.SourceTextModule(source, {
      context,
      initializeImportMeta(meta) {
        meta.url = url.href;
      },
    });
    await module.link(async (specifier) => {
      const exports = mocks[specifier] ?? (await import(specifier));
      return new NodeVM.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        },
        { context },
      );
    });
    await module.evaluate();
    const manifest = JSON.parse(files.get("/synthetic/staging/client/package.json"));
    NodeAssert.equal(manifest.dependencies.effect, "4.1.0");
    NodeAssert.equal(
      files.get("/synthetic/staging/mcp/THIRD_PARTY_NOTICES.txt"),
      "Effect 4.1.0\nSynthetic installed Effect 4.1.0 license",
    );
    NodeAssert.equal(reads.filter((path) => path.endsWith("effect/package.json")).length, 1);
  },
);
