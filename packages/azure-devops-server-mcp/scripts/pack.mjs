import { build } from "esbuild";
import { operationCatalog, CLIENT_VERSION } from "@jonathanm10/azure-devops-server-client";
import { MCP_VERSION } from "../src/server.ts";
import { mkdtemp, mkdir, readFile, writeFile, cp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
const out = resolve(args[outIndex + 1]);
const source = args[sourceIndex + 1];
const actualSource = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (actualSource !== source) throw new Error("Source commit must be the checkout HEAD");
const sourceTreeDirty =
  execFileSync(
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
await mkdir(out, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), "azure-server-pack-"));
try {
  for (const name of ["client", "mcp"]) {
    const sourceDir = join(root, `packages/azure-devops-server-${name}`);
    const target = join(staging, name);
    await mkdir(join(target, "dist"), { recursive: true });
    const original = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8"));
    if (original.version !== (name === "client" ? CLIENT_VERSION : MCP_VERSION))
      throw new Error("Package and runtime versions disagree");
    const metadata = {
      name: original.name,
      version: original.version,
      clientVersion: CLIENT_VERSION,
      source,
      sourceTreeDirty,
    };
    await writeFile(join(target, "provenance.json"), JSON.stringify(metadata, null, 2) + "\n");
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
      outdir: join(target, "dist"),
      ...(name === "client" ? { external: ["effect", "effect/*"] } : {}),
      legalComments: "eof",
    });
    if (name === "client")
      execFileSync(
        join(root, "node_modules/.bin/tsc-rs"),
        [
          "-p",
          join(sourceDir, "tsconfig.build.json"),
          "--rootDir",
          join(sourceDir, "src"),
          "--noEmit",
          "false",
          "--declaration",
          "--emitDeclarationOnly",
          "--outDir",
          join(target, "dist/types"),
        ],
        { cwd: root, stdio: "inherit" },
      );
    if (name === "client") {
      manifest.dependencies = { effect: "4.0.5" };
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
      await chmod(join(target, "dist/main.js"), 0o755);
      await writeFile(
        join(target, "THIRD_PARTY_NOTICES.txt"),
        "Effect 4.0.5\n" + (await readFile(join(sourceDir, "node_modules/effect/LICENSE"), "utf8")),
      );
    }
    await writeFile(
      join(target, "operation-catalog.json"),
      JSON.stringify(operationCatalog, null, 2) + "\n",
    );
    await writeFile(
      join(target, "TOOLS.md"),
      "# Azure DevOps Server operations\n\nGenerated from the executable operation registry.\n\n| Operation | Access | Description |\n| --- | --- | --- |\n" +
        operationCatalog
          .map(
            (operation) =>
              `| ${operation.name} | ${operation.readOnly ? "read" : "write"} | ${operation.description.replaceAll("|", "\\|")} |`,
          )
          .join("\n") +
        "\n",
    );
    await cp(join(sourceDir, "README.md"), join(target, "README.md"));
    await cp(join(root, "LICENSE"), join(target, "LICENSE"));
    await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", out], {
      cwd: target,
      stdio: "pipe",
    });
  }
  process.stdout.write(
    JSON.stringify({
      source,
      client: join(out, "jonathanm10-azure-devops-server-client-0.1.0.tgz"),
      mcp: join(out, "jonathanm10-azure-devops-server-mcp-0.1.0.tgz"),
    }) + "\n",
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
