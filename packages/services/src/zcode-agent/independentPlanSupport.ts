import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

const checks = new WeakMap<object, Promise<void>>();

/** A Host update does not mean the remote CLI updated; old CLIs strip the Plan field, so the execution side must be confirmed before sending. */
export function ensureIndependentPlanSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.independentPlanState !== true) throw new Error("proto.independentPlanUnsupported");
    })
    .catch((cause: unknown) => {
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}
