import type * as Effect from "effect/Effect";
import type { AzureServerError } from "./errors.ts";
import type { AzureDevOpsServerAddress } from "./addresses.ts";

export type Request = (
  route: string,
  options?: {
    readonly query?: Readonly<Record<string, string>>;
    readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly body?: unknown;
    readonly contentType?: string;
    readonly version?: string;
    readonly maxBytes?: number;
    readonly mutation?: boolean;
  },
) => Effect.Effect<
  { readonly body: unknown; readonly continuation: string | null },
  AzureServerError
>;
export type OperationContext = {
  readonly request: Request;
  readonly viewer: string;
  readonly credentialFingerprint: string;
  readonly address: AzureDevOpsServerAddress;
  readonly access: "read" | "read-write";
};
