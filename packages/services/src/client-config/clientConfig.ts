import {
  ServiceChannels,
  type ClientConfigReadOptions,
  type ClientConfigSnapshot,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Window-level public config reads. Business modules only consume their own fields and do not own a second request cache. */
export interface IClientConfigService {
  getSnapshot(options?: ClientConfigReadOptions): Promise<ClientConfigSnapshot>;
}

export const IClientConfigService = createServiceDescriptor<IClientConfigService>(
  ServiceChannels.ClientConfig,
);
