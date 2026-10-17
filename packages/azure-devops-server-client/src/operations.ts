import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AzureServerError } from "./errors.ts";
import type { OperationContext } from "./transport.ts";
import { discovery } from "./operations/discovery.ts";
import { workItems } from "./operations/workItems.ts";
import { boards } from "./operations/boards.ts";
import { pullRequests } from "./operations/pullRequests.ts";

const registry = { ...discovery, ...workItems, ...boards, ...pullRequests };
export type OperationName = keyof typeof registry;
export type OperationInput<K extends OperationName> = (typeof registry)[K]["input"]["Type"];
export type OperationOutput<K extends OperationName> = (typeof registry)[K]["output"]["Type"];
export const operationCatalog = Object.entries(registry).map(([name, operation]) => ({
  name,
  description: operation.description,
  inputSchema: {
    ...Schema.toJsonSchemaDocument(operation.input).schema,
    type: "object",
    additionalProperties: false,
  },
  outputSchema: Schema.toJsonSchemaDocument(operation.output).schema,
  readOnly: operation.readOnly,
  idempotent: operation.idempotent ?? operation.readOnly,
  destructive: operation.destructive ?? false,
  reconcile: operation.reconcile ?? null,
}));
export const isOperationName = (value: string): value is OperationName =>
  Object.hasOwn(registry, value);
export const operationIsRead = (name: OperationName) => registry[name].readOnly;
export const executeOperation = <K extends OperationName>(
  name: K,
  input: OperationInput<K>,
  context: OperationContext,
): Effect.Effect<OperationOutput<K>, AzureServerError> =>
  registry[name].run(input, context) as Effect.Effect<OperationOutput<K>, AzureServerError>;
export const executeUnknownOperation = (
  name: string,
  input: unknown,
  context: OperationContext,
): Effect.Effect<unknown, AzureServerError> =>
  isOperationName(name)
    ? registry[name].run(input, context)
    : Effect.fail(new AzureServerError({ operation: "operation", category: "unsupported" }));

export const validateOperationInput = (name: OperationName, input: unknown) =>
  registry[name].validate(input);
