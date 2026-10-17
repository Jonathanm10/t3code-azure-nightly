import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { copyHistory } from "./history-handoff/HistoryCopy.ts";

const args = process.argv.slice(2);
const sourceState = args[1];
const targetHome = args[3];
const operationDirectory = args[5];
if (
  args.length !== 6 ||
  args[0] !== "--source-state" ||
  args[2] !== "--target-home" ||
  args[4] !== "--operation-directory" ||
  sourceState === undefined ||
  targetHome === undefined ||
  operationDirectory === undefined
) {
  process.stderr.write(
    "Usage: copy-history --source-state ABSOLUTE_PATH --target-home UNUSED_ABSOLUTE_PATH --operation-directory PRIVATE_ABSOLUTE_PATH\n",
  );
  process.exitCode = 2;
} else {
  NodeRuntime.runMain(
    copyHistory({ sourceState, targetHome, operationDirectory }).pipe(
      Effect.tap((result) =>
        Console.log(
          result.kind === "refused"
            ? `History copy refused: ${result.reason}`
            : `${result.kind}: ${result.receipt.targetHome}\nReceipt: ${result.receipt.operationDirectory}/operation.json`,
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.kind === "refused") process.exitCode = 1;
        }),
      ),
    ),
  );
}
