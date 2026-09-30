import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Credential management service
 *
 * Provides key-value style credential reads and writes.
 * The implementation side (host process) owns the encrypted storage details;
 * the consumer side (renderer) only calls through RPC and never knows where the storage lives.
 */
export interface ICredentialService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
);
