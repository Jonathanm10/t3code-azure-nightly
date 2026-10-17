import { build } from "esbuild";
import { operationCatalog, CLIENT_VERSION } from "@jonathanm10/azure-devops-server-client";
import { MCP_VERSION } from "../src/server.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const sourceIndex = args.indexOf("--source");
if (
  outIndex < 0 ||
  !args[outIndex + 1] ||
  sourceIndex < 0 ||
  !/^[a-f0-9]{40}$/u.test(args[sourceIndex + 1] ?? "")
)
  throw new Error(
    "Usage: node packages/azure-devops-server-mcp/scripts/pack.mjs --out <directory> --source <40-hex-source-commit>",
  );
const out = NodePath.resolve(args[outIndex + 1]);
const source = args[sourceIndex + 1];
const actualSource = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (actualSource !== source) throw new Error("Source commit must be the checkout HEAD");
const sourceTreeDirty =
  NodeChildProcess.execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "packages/azure-devops-server-client",
      "packages/azure-devops-server-mcp",
    ],
    { cwd: root, encoding: "utf8" },
  ).trim().length > 0;
const effectDirectory = NodePath.join(root, "packages/azure-devops-server-mcp/node_modules/effect");
const effect = JSON.parse(
  await NodeFSP.readFile(NodePath.join(effectDirectory, "package.json"), "utf8"),
);
const effectLicense = await NodeFSP.readFile(NodePath.join(effectDirectory, "LICENSE"), "utf8");
await NodeFSP.mkdir(out, { recursive: true });
const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-server-pack-"));
try {
  for (const name of ["client", "mcp"]) {
    const sourceDir = NodePath.join(root, `packages/azure-devops-server-${name}`);
    const target = NodePath.join(staging, name);
    await NodeFSP.mkdir(NodePath.join(target, "dist"), { recursive: true });
    const original = JSON.parse(
      await NodeFSP.readFile(NodePath.join(sourceDir, "package.json"), "utf8"),
    );
    if (original.version !== (name === "client" ? CLIENT_VERSION : MCP_VERSION))
      throw new Error("Package and runtime versions disagree");
    const metadata = {
      name: original.name,
      version: original.version,
      clientVersion: CLIENT_VERSION,
      source,
      sourceTreeDirty,
    };
    await NodeFSP.writeFile(
      NodePath.join(target, "provenance.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    const manifest = {
      name: original.name,
      version: original.version,
      type: "module",
      license: "MIT",
      files: [
        "dist",
        "README.md",
        "LICENSE",
        "provenance.json",
        "THIRD_PARTY_NOTICES.txt",
        "TOOLS.md",
        "operation-catalog.json",
      ],
      engines: { node: ">=24" },
      exports: { ".": { types: "./dist/types/index.d.ts", import: "./dist/index.js" } },
    };
    const entries =
      name === "client"
        ? { index: "src/index.ts", addresses: "src/addresses.ts", profile: "src/profile.ts" }
        : { index: "src/index.ts", main: "src/main.ts" };
    await build({
      absWorkingDir: sourceDir,
      entryPoints: entries,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      outdir: NodePath.join(target, "dist"),
      ...(name === "client" ? { external: ["effect", "effect/*"] } : {}),
      legalComments: "eof",
    });
    if (name === "client")
      NodeChildProcess.execFileSync(
        NodePath.join(root, "node_modules/.bin/tsc-rs"),
        [
          "-p",
          NodePath.join(sourceDir, "tsconfig.build.json"),
          "--rootDir",
          NodePath.join(sourceDir, "src"),
          "--noEmit",
          "false",
          "--declaration",
          "--emitDeclarationOnly",
          "--outDir",
          NodePath.join(target, "dist/types"),
        ],
        { cwd: root, stdio: "inherit" },
      );
    if (name === "client") {
      manifest.dependencies = { effect: effect.version };
      manifest.exports["./addresses"] = {
        types: "./dist/types/addresses.d.ts",
        import: "./dist/addresses.js",
      };
      manifest.exports["./profile"] = {
        types: "./dist/types/profile.d.ts",
        import: "./dist/profile.js",
      };
    } else {
      manifest.bin = { "azure-devops-server-mcp": "./dist/main.js" };
      delete manifest.exports["."].types;
      await NodeFSP.chmod(NodePath.join(target, "dist/main.js"), 0o755);
      await NodeFSP.writeFile(
        NodePath.join(target, "THIRD_PARTY_NOTICES.txt"),
        `Effect ${effect.version}\n${effectLicense}`,
      );
    }
    await NodeFSP.writeFile(
      NodePath.join(target, "operation-catalog.json"),
      JSON.stringify(operationCatalog, null, 2) + "\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(target, "TOOLS.md"),
      "# Azure DevOps Server operations\n\nGenerated from the executable operation registry.\n\n| Operation | Access | Description |\n| --- | --- | --- |\n" +
        operationCatalog
          .map(
            (operation) =>
              `| ${operation.name} | ${operation.readOnly ? "read" : "write"} | ${operation.description.replaceAll("|", "\\|")} |`,
          )
          .join("\n") +
        "\n",
    );
    await NodeFSP.cp(NodePath.join(sourceDir, "README.md"), NodePath.join(target, "README.md"));
    await NodeFSP.cp(NodePath.join(root, "LICENSE"), NodePath.join(target, "LICENSE"));
    await NodeFSP.writeFile(
      NodePath.join(target, "package.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    NodeChildProcess.execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", out], {
      cwd: target,
      stdio: "pipe",
    });
  }
  process.stdout.write(
    JSON.stringify({
      source,
      client: NodePath.join(out, "jonathanm10-azure-devops-server-client-0.1.0.tgz"),
      mcp: NodePath.join(out, "jonathanm10-azure-devops-server-mcp-0.1.0.tgz"),
    }) + "\n",
  );
} finally {
  await NodeFSP.rm(staging, { recursive: true, force: true });
}
