import type { ProviderProvisioningEnvelope, ProviderProvisioningResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Remote Environment target called only by the Window Host; not added to IServiceAccessor. */
export interface IProviderProvisioningTargetService {
  apply(envelope: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult>;
}

export const IProviderProvisioningTargetService =
  createServiceDescriptor<IProviderProvisioningTargetService>(
    ServiceChannels.ProviderProvisioningTarget,
  );
