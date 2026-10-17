import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const collectText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes: number;
}) => {
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  return input.stream.pipe(
    Stream.takeWhile((chunk) => {
      bytes += chunk.byteLength;
      if (bytes > input.maxBytes) return false;
      chunks.push(chunk);
      return true;
    }),
    Stream.runDrain,
    Effect.map(() => ({
      text: Buffer.concat(chunks).toString("utf8"),
      truncated: bytes > input.maxBytes,
    })),
  );
};
