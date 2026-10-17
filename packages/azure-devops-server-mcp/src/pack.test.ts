// @effect-diagnostics nodeBuiltinImport:off -- The packer fixture runs in an isolated Node VM with mocked build and filesystem operations.
import { it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

it("tracks the installed Effect version in both packed artifacts", () => {
  NodeChildProcess.execFileSync(process.execPath, [
    "--experimental-vm-modules",
    "--test",
    NodeURL.fileURLToPath(new URL("../scripts/test-pack.mjs", import.meta.url)),
  ]);
});
