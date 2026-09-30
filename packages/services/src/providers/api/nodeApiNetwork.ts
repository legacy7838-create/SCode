import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface HostApiNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
}

export interface HostApiNetworkTransport {
  fetch: typeof fetch;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

type HostProxyRoute =
  | { kind: "direct"; noProxyMatched?: boolean }
  | { kind: "proxy"; proxyUrl: string }
  | { kind: "invalid"; reason: string };

function mergeHostApiCaCertificates(
  customCa: string,
  defaultCa: readonly string[] = rootCertificates,
): string[] {
  // Node's tls.ca replaces rather than appends the default root certificate. Passing only the enterprise agent CA will cause the
  // The public network certificate re-signed by the middleman loses the chain of trust, so the Node default root certificate must be retained at the same time.
  return [...defaultCa, customCa];
}

function normalizeProxyUrl(value: string): string | undefined {
  const candidate = /^\w[\w+.-]*:\/\//.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function matchesNoProxy(url: URL, value: string | undefined): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (value ?? "").split(/[\s,]+/).some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;

    const ruleWithoutScheme = rule.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
    const [ruleHost = "", rulePort] = ruleWithoutScheme.split(":");
    const normalizedHost = ruleHost.replace(/^\*\.?/, "").replace(/^\./, "");
    if (!normalizedHost) return false;
    const hostMatches = host === normalizedHost || host.endsWith(`.${normalizedHost}`);
    return hostMatches && (!rulePort || rulePort === port);
  });
}

export function resolveHostProxyForUrl(
  requestUrl: string | URL,
  options: HostApiNetworkOptions,
): HostProxyRoute {
  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return { kind: "direct" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "direct" };
  }
  if (matchesNoProxy(url, options.noProxy)) {
    return { kind: "direct", noProxyMatched: true };
  }
  const configuredProxy = options.httpProxy?.trim();
  if (!configuredProxy) {
    return { kind: "direct" };
  }
  const proxyUrl = normalizeProxyUrl(configuredProxy);
  return proxyUrl
    ? { kind: "proxy", proxyUrl }
    : { kind: "invalid", reason: "Configured Host proxy URL is invalid" };
}

interface HostApiNetworkTransportDependencies {
  createDispatcher?: typeof createDispatcher;
  fetchWithDispatcher?: (
    input: string,
    init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
  ) => Promise<Response>;
}

export function createHostApiNetworkTransport(
  resolveOptions: () => Promise<HostApiNetworkOptions>,
  dependencies: HostApiNetworkTransportDependencies = {},
): HostApiNetworkTransport {
  // Host is an independent Node process, and Electron Session.setProxy will not affect its globalThis.fetch;
  // Inject the dispatcher according to the request at the NodeApiClient exit to avoid global rerouting of telemetry and other naked fetch.
  let optionsPromise: Promise<HostApiNetworkOptions> | undefined;
  const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
  let disposed = false;
  let generation = 0;
  let pendingDispatcherCreations = 0;
  let resolveDispatcherCreations: (() => void) | undefined;
  let dispatcherCreationsDone: Promise<void> | undefined;
  const lateDisposePromises: Promise<void>[] = [];
  let disposePromise: Promise<void> | undefined;
  let disposeMode: "close" | "destroy" | undefined;
  const dispatcherFactory = dependencies.createDispatcher ?? createDispatcher;
  const fetchWithDispatcher =
    dependencies.fetchWithDispatcher ??
    ((input, init) => undiciFetch(input, init as never) as unknown as Promise<Response>);

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (disposed) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestGeneration = generation;
    if (!optionsPromise) {
      // Set read failure to only affect the current request; clear the rejected promise to avoid a transient IPC/startup race condition
      // Lock the Host API permanently while still preventing failed requests from falling back to direct connection.
      optionsPromise = resolveOptions().catch((error: unknown) => {
        optionsPromise = undefined;
        throw error;
      });
    }
    const options = await optionsPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestUrl = input instanceof Request ? input.url : String(input);
    const route = resolveHostProxyForUrl(requestUrl, options);
    if (route.kind === "invalid") {
      throw new Error(route.reason);
    }
    if (route.kind === "direct" && !options.caCertPath) {
      return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
    }

    const dispatcherKey = `${route.kind}:${route.kind === "proxy" ? route.proxyUrl : "direct"}:${options.caCertPath ?? ""}`;
    let dispatcherPromise = dispatcherPromises.get(dispatcherKey);
    if (!dispatcherPromise) {
      if (disposed) {
        throw new Error("Host API network transport has been disposed");
      }
      const dispatcherGeneration = generation;
      pendingDispatcherCreations += 1;
      dispatcherPromise = dispatcherFactory(route, options.caCertPath);
      dispatcherPromises.set(dispatcherKey, dispatcherPromise);
      void dispatcherPromise
        .then((dispatcher) => {
          if (
            (disposed || generation !== dispatcherGeneration) &&
            dispatcherPromises.get(dispatcherKey) === dispatcherPromise
          ) {
            dispatcherPromises.delete(dispatcherKey);
            const cleanupPromise = Promise.resolve(
              disposeMode === "close" ? dispatcher.close() : dispatcher.destroy(),
            ).catch(() => {});
            lateDisposePromises.push(cleanupPromise);
          }
        })
        .catch(() => {});
      const markDispatcherCreationDone = () => {
        pendingDispatcherCreations -= 1;
        if (pendingDispatcherCreations === 0) {
          resolveDispatcherCreations?.();
          resolveDispatcherCreations = undefined;
        }
      };
      void dispatcherPromise.then(markDispatcherCreationDone, markDispatcherCreationDone);
      dispatcherPromise.catch(() => {
        // Temporary IO failures such as settings/CA only affect the current request; clean up the rejected dispatcher to avoid a race condition at one start
        // Lock the same route permanently, while still keeping failed requests fail-closed and not falling back to direct connection.
        if (dispatcherPromises.get(dispatcherKey) === dispatcherPromise) {
          dispatcherPromises.delete(dispatcherKey);
        }
      });
    }
    const dispatcher = await dispatcherPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    return fetchWithDispatcher(
      input as unknown as string,
      {
        ...init,
        dispatcher,
      } as Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
    );
  };

  const startDispose = (mode: "close" | "destroy"): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    generation += 1;
    disposeMode = mode;
    // The dispatcher cannot only be cached by closures and has no Host owner: the connection pool and the connection pool after the window/remote Host are rebuilt
    // keep-alive sockets may still survive. When releasing, take a snapshot of the current solo Promise to ensure that the dispatcher is initialized
    // It will also be closed after completion; exit synchronously with destroy and wait for exit with close.
    const pendingDispatchers = [...dispatcherPromises.values()];
    dispatcherPromises.clear();
    if (pendingDispatcherCreations > 0) {
      dispatcherCreationsDone = new Promise<void>((resolve) => {
        resolveDispatcherCreations = resolve;
      });
    }
    disposePromise = (async () => {
      await Promise.allSettled(
        pendingDispatchers.map(async (dispatcherPromise) => {
          const dispatcher = await dispatcherPromise;
          if (mode === "close") {
            await dispatcher.close();
          } else {
            await dispatcher.destroy();
          }
        }),
      );
      await dispatcherCreationsDone;
      await Promise.all(lateDisposePromises);
    })();
    return disposePromise;
  };

  return {
    fetch,
    dispose() {
      void startDispose("destroy");
    },
    disposeAndWait() {
      return startDispose("close");
    },
  };
}

async function createDispatcher(
  route: Exclude<HostProxyRoute, { kind: "invalid" }>,
  caCertPath: string | undefined,
): Promise<Dispatcher> {
  const customCa = caCertPath ? await readFile(caCertPath, "utf8") : undefined;
  const ca = customCa ? mergeHostApiCaCertificates(customCa) : undefined;
  if (route.kind === "proxy") {
    return new ProxyAgent({
      uri: route.proxyUrl,
      proxyTls: ca ? { ca } : undefined,
      requestTls: ca ? { ca } : undefined,
    });
  }
  return new Agent({ connect: ca ? { ca } : undefined });
}
