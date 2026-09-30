import { type ApiClient } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import type { RemoteEnvelope } from "./accountProviderApiTypes.js";

function isSuccessfulRemoteCode(code: unknown): boolean {
  if (code === null || code === undefined) {
    return true;
  }
  if (typeof code === "number") {
    return code === 0 || code === 200;
  }
  if (typeof code === "string") {
    return code === "0" || code === "200";
  }
  return false;
}

export class AccountProviderApiClient {
  constructor(readonly apiClient: ApiClient) {}

  async fetchRemoteData<T>(url: string, init: RequestInit): Promise<T | null> {
    const payload = await readApiJson<RemoteEnvelope<T>>(this.apiClient, url, init);
    // BigModel partial business interface returns code=200 instead of code=0 when successful.
    if (!isSuccessfulRemoteCode(payload.code)) {
      return null;
    }

    return payload.data ?? null;
  }
}
