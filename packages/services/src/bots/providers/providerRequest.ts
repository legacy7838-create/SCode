const BOT_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export interface BotProviderJsonResponse<T> {
  ok: boolean;
  status: number;
  payload: T | undefined;
  responseLogId?: string;
}

export interface BotProviderResponse {
  ok: boolean;
  status: number;
}

async function runBotProviderRequest<T>(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const onAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    onAbort();
  } else {
    externalSignal?.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Bot provider request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    // Reason for fix: Receiving the response header does not mean that the request is completed. Must be under the same AbortSignal and deadline
    // Consume the response body, otherwise the server-side stagnation after headers will still permanently block the Bot actor queue.
    return await consume(response);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Third-party Bot APIs do not necessarily terminate hung requests on their own. Every callback ACK
 * and outbound message must be bounded, otherwise a single request holds the actor's serial queue
 * and no later permission, Q&A or plan approval can proceed.
 */
export async function fetchBotProvider(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = BOT_PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<BotProviderResponse> {
  return runBotProviderRequest(input, init, timeoutMs, async (response) => {
    // Bugfix: fetch() will be completed when the response header arrives, and returning Response directly will cancel the deadline in advance.
    // Telegram callers only need status, so a lightweight result is returned after receiving the response body under a controlled signal.
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status };
  });
}

export async function fetchBotProviderJson<T>(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = BOT_PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<BotProviderJsonResponse<T>> {
  return runBotProviderRequest(input, init, timeoutMs, async (response) => {
    const text = await response.text();
    let payload: T | undefined;
    if (text) {
      try {
        payload = JSON.parse(text) as T;
      } catch (error) {
        if (response.ok) {
          throw error;
        }
      }
    }
    const responseLogId = response.headers.get("x-tt-logid") ?? undefined;
    return { ok: response.ok, status: response.status, payload, responseLogId };
  });
}
