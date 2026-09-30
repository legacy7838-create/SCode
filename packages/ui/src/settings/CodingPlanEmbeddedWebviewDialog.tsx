/* oxlint-disable eslint(max-lines) -- the Coding Plan webview container centrally maintains
 * credential injection, purchase-complete reporting, third-party payment navigation, and error
 * fallbacks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { RENDERER_ZCODE_ENDPOINT_URLS } from "@/lib/rendererZCodeEndpoint.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { normalizeThemePreference, resolveTheme } from "@/useTheme.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import {
  buildCodingPlanEmbeddedWebviewUrl,
  buildCodingPlanEmbeddedReportContext,
  createCodingPlanAuthInjectionScript,
  createCodingPlanCredentialClearScript,
  createCodingPlanLangInjectionScript,
  createCodingPlanScrollbarHideScript,
  getCodingPlanCredentialKeys,
  isTrustedCodingPlanEmbeddedWebviewUrl,
  resolveCodingPlanEmbeddedOrigin,
  resolveCodingPlanWebsiteProvider,
  type CodingPlanEmbeddedCredentials,
  type CodingPlanEmbeddedTheme,
  type CodingPlanPurchaseAudience,
  CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY,
} from "@/settings/model-provider-section/codingPlanEmbeddedWebview.js";
import {
  CodingPlanWebviewChannels,
  type CodingPlanPurchaseCompletePayload,
  ZCODE_VERSION,
} from "@zcode/shared";

interface CodingPlanEmbeddedWebviewDialogProps {
  credentialService: {
    load(key: string): Promise<string | null>;
  };
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onOpenResult?: (opened: boolean) => void;
  providerId: CodingPlanProviderId;
  funnelContext?: CodingPlanFunnelContext | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
  /**
   * Callback invoked after a successful purchase on the official site.
   *
   * The official page sends a zcode:coding-plan-purchase-complete channel message through the
   * preload-injected window.zcodeBridge.notifyPurchaseComplete({ provider }); this component
   * recognizes that channel in the webview's ipc-message event and fires this callback (via
   * onPurchaseCompleteRef to avoid a stale closure). The layer above (CodingPlanUpgradeDialog) uses
   * this callback to refresh entitlements/providers and close the webview.
   */
  onPurchaseComplete?: () => void;
}

interface CodingPlanWebviewImportMetaEnv {
  VITE_CODING_PLAN_WEBVIEW_ORIGIN?: string;
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
}

interface CodingPlanWebviewNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

function readCodingPlanWebviewImportMetaEnv(): CodingPlanWebviewImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: CodingPlanWebviewImportMetaEnv }).env ??
    {}) as CodingPlanWebviewImportMetaEnv;
}

export function CodingPlanEmbeddedWebviewDialog({
  credentialService,
  onOpenChange,
  open,
  providerId,
  funnelContext,
  audience,
  teamPlanKey,
  onPurchaseComplete,
  onOpenResult,
}: CodingPlanEmbeddedWebviewDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const userId = useZCodeStoreWithDefault((state) => state.user?.id ?? null, null);
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const onOpenResultRef = useRef(onOpenResult);
  onOpenResultRef.current = onOpenResult;
  // Current locale as webview language hint/injection value; Locale is isomorphic to CodingPlanWebviewLocale.
  const webviewLocale = locale;
  const webviewCleanupRef = useRef<(() => void) | null>(null);
  // Whether the webview is dom-ready: executeJavaScript is only called after ready.
  // Otherwise, "WebView must be attached to the DOM and dom-ready emitted" will be thrown.
  const webviewReadyRef = useRef(false);
  const frozenWebviewUrlRef = useRef<string | null>(null);
  const injectAuthRef = useRef<(webview: ElectronWebviewTag | null) => Promise<void>>(
    async () => {},
  );
  // onPurchaseComplete is accessed through ref in ref callback/event listener to avoid stale closure
  // (handleWebviewRef uses useCallback([],) to only bind the event once and does not rely on the latest value of onPurchaseComplete).
  const onPurchaseCompleteRef = useRef<(() => void) | undefined>(onPurchaseComplete);
  useEffect(() => {
    onPurchaseCompleteRef.current = onPurchaseComplete;
  }, [onPurchaseComplete]);
  const [authError, setAuthError] = useState<string | null>(null);
  // loadError: The cryptic state when webview fails to load/collapses.
  // According to the user's decision, when the webview is unavailable, an error will be reported and directed to the official website for purchase, without falling back to the old Dialog.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationState, setNavigationState] = useState<CodingPlanWebviewNavigationState>({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  });
  const provider = resolveCodingPlanWebsiteProvider(providerId);
  const embeddedTheme: CodingPlanEmbeddedTheme =
    normalizeThemePreference(theme) === "zai-dark" || resolveTheme(theme) === "dark"
      ? "zai-dark"
      : "zai-light";
  const computedWebviewUrl = useMemo(() => {
    const env = readCodingPlanWebviewImportMetaEnv();
    const origin = resolveCodingPlanEmbeddedOrigin({
      endpointOrigin: RENDERER_ZCODE_ENDPOINT_URLS.origin,
      e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      overrideOrigin: env.VITE_CODING_PLAN_WEBVIEW_ORIGIN,
    });
    // URL with ?lang= hint allows the official website to have the correct language on the first screen to avoid English flickering before injection.
    // Synchronization belt ?theme= hint, to avoid the default dark of the official website SSR from flickering in the first frame under the light theme of the app.
    return buildCodingPlanEmbeddedWebviewUrl({
      origin,
      provider,
      locale: webviewLocale,
      theme: embeddedTheme,
      audience,
      teamPlanKey,
    });
  }, [audience, embeddedTheme, provider, teamPlanKey, webviewLocale]);
  if (open && frozenWebviewUrlRef.current === null) {
    // theme=system will automatically switch with the OS. If src changes accordingly, the PayPal page being authorized will be reloaded.
    // Once Dialog is opened, only the first frame hint is fixed in the life cycle. During runtime, the theme is still synchronized to the official website through the auth injection script.
    frozenWebviewUrlRef.current = computedWebviewUrl;
  } else if (!open && frozenWebviewUrlRef.current !== null) {
    frozenWebviewUrlRef.current = null;
  }
  const webviewUrl = frozenWebviewUrlRef.current ?? computedWebviewUrl;

  const injectAuth = useCallback(
    async (webview: ElectronWebviewTag | null = webviewRef.current) => {
      if (!webview) {
        return;
      }
      setAuthError(null);
      try {
        const env = readCodingPlanWebviewImportMetaEnv();
        const currentUrl = typeof webview.getURL === "function" ? webview.getURL() : "";
        if (
          !isTrustedCodingPlanEmbeddedWebviewUrl(currentUrl, {
            e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
          })
        ) {
          // dom-ready will be triggered again during subsequent main frame navigation. It does not mean that the initial src is trusted.
          // The current page is still the official website purchase page. After leaving the trusted page, you can only clean the origin and cannot inject App credentials.
          await webview.executeJavaScript(createCodingPlanCredentialClearScript(), true);
          return;
        }
        const keys = getCodingPlanCredentialKeys(provider);
        const [values, deviceMid] = await Promise.all([
          Promise.all(keys.map((key) => credentialService.load(key))),
          Promise.resolve()
            .then(() => platform.getDeviceId())
            .catch(() => null),
        ]);
        const credentials: CodingPlanEmbeddedCredentials =
          provider === "zai"
            ? {
                zaiAccessToken: values[0],
                zcodeJwtToken: values[1],
              }
            : {
                bigmodelAccessToken: values[0],
                // BigModel OAuth callback will also place zcode JWT; the official website uses it in
                // Check the billing/balance domain in zcode-plan to determine the Start Plan status.
                zcodeJwtToken: values[1],
              };
        const reportContext = buildCodingPlanEmbeddedReportContext({
          funnelContext,
          deviceMid,
          userId,
          appVersion: ZCODE_VERSION,
        });
        const script = createCodingPlanAuthInjectionScript({
          provider,
          credentials,
          theme: embeddedTheme,
          locale: webviewLocale,
          reportContext,
        });
        // Webview uses persistent partition, and the old token cannot be used when provider/account is switched.
        // It remains in localStorage for a short time and is read by the first screen logic of the official website. Before injection, clear the sensitive key and then write the current credentials.
        await webview.executeJavaScript(
          `${createCodingPlanCredentialClearScript()};\n${script}`,
          true,
        );
      } catch (error) {
        // WebView and App renderer are different storage partitions, and the official web page cannot read App credentialService directly.
        // When the injection fails, a retryable state must be given, otherwise the page will stay in the unlogged/skeleton state and the user cannot recover.
        setAuthError(error instanceof Error ? error.message : String(error));
        logger.warn("[CodingPlanEmbeddedWebviewDialog] inject purchase credential failed", {
          provider,
          error,
        });
      }
    },
    [credentialService, embeddedTheme, funnelContext, platform, provider, userId, webviewLocale],
  );

  // When the App locale changes during runtime, inject the lang update script into the dom-ready webview.
  // Allow the official website to switch languages without any sense (changes in webviewUrl will cause the entire page to be reloaded. This handles the scenario of "locale changes within the same page").
  // Skip when webview is not dom-ready: the auth injection script after dom-ready will bring the latest locale.
  // There is no need to inject in advance here (executing JavaScript in advance will throw attach/dom-ready errors).
  useEffect(() => {
    if (!open) return;
    if (!webviewReadyRef.current) return;
    const webview = webviewRef.current;
    if (!webview) return;
    const script = createCodingPlanLangInjectionScript(webviewLocale);
    void webview.executeJavaScript(script, true).catch(() => {
      // When the webview has been destroyed, executeJavaScript will reject it and just stay silent.
    });
  }, [open, webviewLocale]);

  useEffect(() => {
    injectAuthRef.current = injectAuth;
  }, [injectAuth]);

  const syncNavigationState = useCallback((webview: ElectronWebviewTag | null) => {
    if (!webview) {
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
      return;
    }
    try {
      setNavigationState((current) => ({
        ...current,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      }));
    } catch (error) {
      // The webview in the third-party payment page navigation churn may not be attached temporarily.
      // The navigation buttons are only auxiliary controls, and synchronization failure should not affect the payment process.
      logger.debug("[CodingPlanEmbeddedWebviewDialog] sync webview navigation state failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleGoBack = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoBack) return;
    webview.goBack();
    syncNavigationState(webview);
  }, [navigationState.canGoBack, syncNavigationState]);

  const handleGoForward = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoForward) return;
    webview.goForward();
    syncNavigationState(webview);
  }, [navigationState.canGoForward, syncNavigationState]);

  const handleReloadWebview = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  const handleWebviewRef = useCallback(
    (element: ElectronWebviewTag | null) => {
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
      webviewRef.current = element;
      if (!element) {
        webviewReadyRef.current = false;
        setNavigationState({
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
        });
        return;
      }
      const handleDomReady = () => {
        // Mark ready to allow injection of executeJavaScript for subsequent locale changes.
        webviewReadyRef.current = true;
        syncNavigationState(element);
        // The official website and third-party payment page will inherit their own native scroll bars, and will be borderless after being connected to the app.
        // The juxtaposition of the webview shells is very abrupt; it only hides the scrollbar and does not disable page scrolling.
        void element
          .executeJavaScript(createCodingPlanScrollbarHideScript(), true)
          .catch((error) => {
            logger.debug("[CodingPlanEmbeddedWebviewDialog] hide webview scrollbar failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        void injectAuthRef.current(element);
        onOpenResultRef.current?.(true);
      };
      const handleDidStartLoading = () => {
        // New navigation starts: reset ready to avoid executing JavaScript on pages that are not ready.
        webviewReadyRef.current = false;
        setAuthError(null);
        setLoadError(null);
        setNavigationState((current) => ({ ...current, isLoading: true }));
      };
      const handleDidStopLoading = () => {
        setNavigationState((current) => ({ ...current, isLoading: false }));
        syncNavigationState(element);
      };
      const handleNavigation = () => {
        syncNavigationState(element);
      };
      // did-fail-load: The main frame failed to load (network interruption, DNS failure, connection refused, etc.).
      // Only report errors to the main frame to avoid sub-resource failures from putting the entire webview into an error state.
      const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
        if (!event.isMainFrame) {
          return;
        }
        const description = event.errorDescription || String(event.errorCode);
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview load failed", {
          provider,
          errorCode: event.errorCode,
          errorDescription: event.errorDescription,
          validatedURL: event.validatedURL,
        });
        setLoadError(description);
        onOpenResultRef.current?.(false);
        setNavigationState((current) => ({ ...current, isLoading: false }));
      };
      // render-process-gone: The rendering process crashes/OOM/is killed, the webview cannot be restored, and it also enters the error state.
      const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview render process gone", {
          provider,
          reason: event.details.reason,
          exitCode: event.details.exitCode,
        });
        setLoadError(event.details.reason);
        onOpenResultRef.current?.(false);
      };
      // ipc-message: The official webpage passes preload's window.zcodeBridge.notifyPurchaseComplete
      // Send back the purchase completion signal (zcode:coding-plan-purchase-complete).
      // Refer to the ipc-message handler mode of useEmbeddedBrowserWheelChain.ts.
      const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
        if (event.channel !== CodingPlanWebviewChannels.PurchaseComplete) {
          return;
        }
        const raw = event.args[0] as CodingPlanPurchaseCompletePayload | undefined;
        if (raw?.provider !== "zai" && raw?.provider !== "bigmodel") {
          // The payload is illegal and ignored to avoid forged or dirty data triggering refresh.
          logger.warn(
            "[CodingPlanEmbeddedWebviewDialog] received invalid purchase complete payload",
            {
              channel: event.channel,
              args: event.args,
            },
          );
          return;
        }
        logger.info(
          "[CodingPlanEmbeddedWebviewDialog] received official site purchase complete signal, trigger refresh",
          {
            provider: raw.provider,
            timestamp: raw.timestamp,
          },
        );
        onPurchaseCompleteRef.current?.();
      };

      element.addEventListener("dom-ready", handleDomReady);
      element.addEventListener("did-start-loading", handleDidStartLoading);
      element.addEventListener("did-stop-loading", handleDidStopLoading);
      element.addEventListener("did-navigate", handleNavigation);
      element.addEventListener("did-navigate-in-page", handleNavigation);
      element.addEventListener("did-fail-load", handleDidFailLoad);
      element.addEventListener("render-process-gone", handleRenderProcessGone);
      element.addEventListener("ipc-message", handleIpcMessage);
      // React effect binding may occur later than the <webview>'s first round of dom-ready.
      // Bind the Electron event immediately when ref is mounted, ensuring that executeJavaScript only occurs after dom-ready.
      webviewCleanupRef.current = () => {
        webviewReadyRef.current = false;
        element.removeEventListener("dom-ready", handleDomReady);
        element.removeEventListener("did-start-loading", handleDidStartLoading);
        element.removeEventListener("did-stop-loading", handleDidStopLoading);
        element.removeEventListener("did-navigate", handleNavigation);
        element.removeEventListener("did-navigate-in-page", handleNavigation);
        element.removeEventListener("did-fail-load", handleDidFailLoad);
        element.removeEventListener("render-process-gone", handleRenderProcessGone);
        element.removeEventListener("ipc-message", handleIpcMessage);
      };
    },
    [syncNavigationState],
  );

  useEffect(() => {
    return () => {
      const webview = webviewRef.current;
      if (webviewReadyRef.current && webview) {
        // When closing the purchase page, the credential key in the persistent partition is automatically cleared to reduce the cross-account residual window.
        void webview.executeJavaScript(createCodingPlanCredentialClearScript(), true).catch(() => {
          // The webview may have been destroyed, and the main process clear-all-data will clean up the partition.
        });
      }
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      setAuthError(null);
      setLoadError(null);
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
    }
  }, [open, webviewUrl]);

  // Open the official website purchase page: when webview is unavailable, guide users to the official website to purchase by themselves.
  const handleOpenWebsite = useCallback(() => {
    platform.openExternal(webviewUrl);
  }, [platform, webviewUrl]);

  if (!open) {
    return null;
  }

  const pageContentWidthClass = "max-w-5xl";

  return (
    <section
      data-testid="coding-plan-upgrade-surface"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background pt-12 text-foreground"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <EmbeddedWebsiteHeader
          title={intl.formatMessage({ id: "settings.modelProvider.codingPlan.webview.title" })}
          loading={navigationState.isLoading}
          canGoBack={navigationState.canGoBack}
          canGoForward={navigationState.canGoForward}
          onBack={handleGoBack}
          onForward={handleGoForward}
          onReload={handleReloadWebview}
          onClose={() => onOpenChange(false)}
        />

        <main
          className={cn(
            "mx-auto flex w-full flex-1 flex-col px-6 pt-2 pb-8 max-sm:px-4 max-sm:pt-2 max-sm:pb-5",
            pageContentWidthClass,
          )}
        >
          {authError ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3 text-ui-base text-foreground-subtle">
              <span>
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.authInjectFailed",
                })}
              </span>
              <Button size="sm" variant="outline" onClick={() => void injectAuth()}>
                <RefreshCwIcon className="size-3.5" />
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.retry",
                })}
              </Button>
            </div>
          ) : null}
          {loadError ? (
            <div
              className="mb-3 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle"
              data-testid="coding-plan-embedded-webview-load-error"
            >
              <span className="font-medium text-foreground">
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.loadFailed",
                })}
              </span>
              <span className="text-ui-sm text-foreground-subtle">{loadError}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={handleOpenWebsite}>
                  <ExternalLinkIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.openWebsite",
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleReloadWebview}>
                  <RefreshCwIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.retry",
                  })}
                </Button>
              </div>
            </div>
          ) : null}
          <webview
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            partition="persist:zcode-coding-plan"
            src={webviewUrl}
            className={cn(
              "min-h-0 flex-1 bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              loadError && "hidden",
            )}
            data-testid="coding-plan-embedded-webview"
          />
        </main>
      </div>
    </section>
  );
}

export { CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY };
