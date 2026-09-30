import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ClientSceneResponseBody<T> {
  code: number;
  msg: string;
  data: T;
}

export interface ClientSceneConfig {
  namespace: string;
  scene: string;
  options: Record<string, ClientSceneOption>;
  created_at?: number;
  updated_at?: number;
}

export interface ClientSceneOption {
  id: string;
  type: string;
  /** Option header i18n. */
  contents: Record<string, string>;
  /** Prompt word i18n. */
  prompts?: Record<string, string>;
  /** Options shown when there is no filter. */
  items?: ClientSceneItem[];
  /** Which option.type to filter by. */
  refer?: string;
  /** Mapping of itemId of other options to filtered options. */
  cascades?: Record<string, ClientSceneItem[]>;
  /** prompt template i18n. */
  templates?: Record<string, string>;
}

export interface ClientSceneItem {
  id: string;
  type: string;
  /** Option header i18n. */
  contents: Record<string, string>;
  /** Option description i18n. */
  descs?: Record<string, string>;
  /** option tag i18n. */
  labels: Record<string, string>;
  /** Trigger event after the conversation is completed. */
  on_finish?: string | null;
  /** Lucide canonical icon name (kebab-case). */
  img?: string | null;
  /** Compatible with reserved fields; the current homepage and Automations icons are not consumed. */
  imgs?: {
    cn?: string;
    en?: string;
  };
  share_urls?: Record<string, string>;
  defaults?: Record<string, string[]>;
}

export type ClientScenesResponse = ClientSceneResponseBody<ClientSceneConfig[]>;

export interface IClientScenesService {
  list(): Promise<ClientScenesResponse>;
}

export const IClientScenesService = createServiceDescriptor<IClientScenesService>(
  ServiceChannels.ClientScenes,
);
