#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- The executable boundary loads a non-secret local profile.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import { AzureServerProfile, CLIENT_VERSION } from "@jonathanm10/azure-devops-server-client";
import { serveAzureMcp, MCP_VERSION } from "./server.ts";

const decodeProfile = Schema.decodeOption(Schema.fromJsonString(AzureServerProfile));

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`azure-devops-server-mcp ${MCP_VERSION} client ${CLIENT_VERSION}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "azure-devops-server-mcp --profile <name|absolute-json-path> [--access read|read-write]\nProfiles default to ~/.config/azure-devops-server/profiles/<name>.json. No credentials belong in a profile.\n",
    );
    return;
  }
  let selected: string | undefined;
  let access: "read" | "read-write" = "read-write";
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (flag === "--profile" && value !== undefined) selected = value;
    else if (flag === "--access" && (value === "read" || value === "read-write")) access = value;
    else throw new Error("Invalid command line");
  }
  if (selected === undefined) throw new Error("A profile is required");
  const path = NodePath.isAbsolute(selected)
    ? selected
    : /^[a-zA-Z0-9_-]{1,80}$/u.test(selected)
      ? NodePath.join(
          NodeOS.homedir(),
          ".config",
          "azure-devops-server",
          "profiles",
          selected + ".json",
        )
      : undefined;
  if (path === undefined) throw new Error("Invalid profile name");
  const stat = await NodeFSP.stat(path);
  if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid profile file");
  const decoded = decodeProfile(await NodeFSP.readFile(path, "utf8"), {
    onExcessProperty: "error",
  });
  if (decoded._tag === "None") throw new Error("Invalid profile");
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    process.stdin.destroy();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await serveAzureMcp({
      profile: decoded.value,
      access,
      input: process.stdin,
      output: process.stdout,
      signal: abort.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
main().catch(() => {
  process.stderr.write(
    "Azure MCP startup failed. Check --help and the non-secret profile configuration.\n",
  );
  process.exitCode = 1;
});
