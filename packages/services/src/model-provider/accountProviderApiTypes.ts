import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";

export type AccountApiProviderId = typeof BIGMODEL_PROVIDER_ID | typeof ZAI_PROVIDER_ID;

export interface RemoteEnvelope<T> {
  code?: number;
  data?: T;
}

export interface RemoteProjectInfo {
  projectId?: string;
  projectName?: string;
  projectType?: number | string | null;
}

export interface RemoteOrganizationInfo {
  organizationId?: string;
  organizationName?: string;
  projects?: RemoteProjectInfo[];
}

export interface RemoteCustomerInfo {
  organizations?: RemoteOrganizationInfo[];
}

export interface RemoteApiKeySummary {
  apiKey?: string;
  keyType?: number | null;
  name?: string;
}

export interface RemoteApiKeySecret {
  secretKey?: string;
}

export const DEFAULT_ORG_NAME = "Default institution";
export const DEFAULT_PROJECT_NAME = "Default project";
export const ZCODE_API_KEY_NAME = "zcode-api-key";
