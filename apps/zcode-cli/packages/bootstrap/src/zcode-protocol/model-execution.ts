import type { ModelRequestAuth } from "@zcode/contracts";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type { SendInputOptions } from "../app/types.js";

/** The execution-material projection shared by both input protocols; a Secret/Ticket never goes into the persistable intent. */
export function createModelExecutionContext(
  input: NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>,
): NonNullable<SendInputOptions["modelExecution"]> {
  const requestAuth = input.requestAuth ? freezeRequestAuth(input.requestAuth) : undefined;
  return {
    ...(input.memoryExtraction ? { memoryExtraction: input.memoryExtraction } : {}),
    selectionScope: "execution",
    ...(requestAuth
      ? {
          requestDependencies: { requestAuth: { source: { resolve: async () => requestAuth } } },
        }
      : {}),
    ...(input.subagents ? { subagents: input.subagents } : {}),
  };
}

function freezeRequestAuth(input: ModelRequestAuth): ModelRequestAuth {
  return Object.freeze({
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.headers ? { headers: Object.freeze({ ...input.headers }) } : {}),
  });
}
