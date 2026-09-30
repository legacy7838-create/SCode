// Each RPC service proxy corresponds to an attachment; hello/clientHello is only done once, all
// The conversation/sessions-index transport shares this Promise to avoid repeated handshakes for concurrent first subscriptions.
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  hostSupportsWorkflowRunDeltas,
  type ClientHello,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

const handshakes = new WeakMap<object, Promise<HelloMessage>>();
export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    // The declaration of `workflowRunDeltas` is **one-way**: only the Host declares it in hello first, and the client can declare it back.
    // The capabilities of clientHello are `.strict()`. Sending a key that it does not recognize to the old Host will cause the entire
    // ClientHello parsing failed and the connection could not be grasped - this is not a downgrade, but the entire session panel cannot be opened.
    const capabilities: NonNullable<ClientHello["capabilities"]> = {
      workspaceHookReviewUi: true,
      ...(hostSupportsWorkflowRunDeltas(hello.capabilities) ? { workflowRunDeltas: true } : {}),
    };
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      // handshake and commandFactory have each generated a set of page clientId, facade
      // Unable to verify command envelope belongs to bound client. Unified reuse of persistent V4 clientId.
      clientId: getV4ClientId(),
      clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
      appVersion: "unknown",
      capabilities,
    });
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
