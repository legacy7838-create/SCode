/* oxlint-disable eslint(max-lines) */
/**
 * WelcomeScreen — OAuth / API Key sign-in entry point
 *
 * Drives the OAuth flow through the useOAuth hook.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2Icon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import {
  type OAuthProviderMeta,
  BIGMODEL_PROVIDER_ID,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_OAUTH_CANCEL,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
  ZAI_PROVIDER_ID,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Button } from "./components/ui/button.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useOAuth } from "./hooks/useOAuth.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { LoginApiKeyForm } from "./login/LoginApiKeyForm.js";
import { renderOAuthProviderIcon } from "./lib/oauthProviderIcon.js";
import { ThemeHeroVisual } from "./openWorkspacePageThemeHero.js";
import { useZCodeStore } from "./store/StoreProvider.js";

interface WelcomeScreenProps {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

export type LoginCompleteReason = "oauth" | "apiKey" | "skip";

export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      <ThemeHeroVisual className="absolute inset-0" />
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 w-full items-center [app-region:drag]" />
      <section className="relative z-10 w-full flex flex-col gap-10 max-w-sm rounded-2xl border border-popover-border bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10">
        <LoginPanel active onComplete={onComplete} />
      </section>
    </main>
  );
}

interface LoginPanelProps {
  active: boolean;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

interface ActiveLoginEntryAttempt {
  id: number;
  providerId: OAuthProviderMeta["id"];
}

function shouldCompleteProviderLoginAttempt(params: {
  attempt: ActiveLoginEntryAttempt | null;
  successProvider: OAuthProviderMeta["id"] | null;
}): boolean {
  return !params.attempt || params.successProvider === params.attempt.providerId;
}

function shouldCompleteLoginFromExistingUser(params: {
  hasUser: boolean;
  attempt: ActiveLoginEntryAttempt | null;
}): boolean {
  return params.hasUser && !params.attempt;
}

function LoginPanel({ active, onComplete }: LoginPanelProps) {
  const { intl } = useZCodeIntl();
  const {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    loadingProviders,
    pendingProvider,
    refreshProviders,
  } = useOAuth();
  const user = useZCodeStore((s) => s.user);
  const oauthError = useZCodeStore((s) => s.oauthError);
  const setOAuthError = useZCodeStore((s) => s.setOAuthError);
  const oauthSuccessSeq = useZCodeStore((s) => s.oauthSuccessSeq);
  const lastOAuthSuccessProvider = useZCodeStore((s) => s.lastOAuthSuccessProvider);
  const loginEntryRequest = useZCodeStore((s) => s.loginEntryRequest);
  const clearLoginEntryRequest = useZCodeStore((s) => s.clearLoginEntryRequest);
  const markLoginEntryAttemptStatus = useZCodeStore((s) => s.markLoginEntryAttemptStatus);
  const [loginMode, setLoginMode] = useState<"providers" | "apiKey">("providers");
  const wasActiveRef = useRef(active);
  const consumedLoginRequestRef = useRef<number | null>(null);
  const observedOAuthSuccessSeqRef = useRef(oauthSuccessSeq);
  const lastAttemptProviderRef = useRef<OAuthProviderMeta["id"] | null>(null);
  const activeLoginEntryAttemptRef = useRef<ActiveLoginEntryAttempt | null>(null);

  const finishActiveLoginEntryAttempt = useCallback(
    (status: "succeeded" | "cancelled" | "failed") => {
      const attempt = activeLoginEntryAttemptRef.current;
      if (!attempt) {
        return;
      }
      activeLoginEntryAttemptRef.current = null;
      markLoginEntryAttemptStatus(attempt.id, status);
    },
    [markLoginEntryAttemptStatus],
  );

  const startTrackedLogin = useCallback(
    (
      provider: OAuthProviderMeta["id"],
      options?: Parameters<typeof startLogin>[1],
      loginEntryAttemptId?: number,
    ) => {
      const activeAttempt = activeLoginEntryAttemptRef.current;
      if (activeAttempt && activeAttempt.id !== loginEntryAttemptId) {
        // When the user starts another login process on the unified login page, the old purchase intention cannot continue to wait.
        finishActiveLoginEntryAttempt("cancelled");
      }
      // If the store oauthError left over from the previous failure is not cleared, the new process will enter the waiting state.
      // The failure prompt will be on the same screen as the waiting prompt (for example, the login portal will be closed after failure, and then the login will be automatically continued from the settings page).
      setOAuthError(null);
      if (loginEntryAttemptId !== undefined) {
        activeLoginEntryAttemptRef.current = {
          id: loginEntryAttemptId,
          providerId: provider,
        };
        markLoginEntryAttemptStatus(loginEntryAttemptId, "waiting");
      }
      lastAttemptProviderRef.current = provider;
      return startLogin(provider, options);
    },
    [finishActiveLoginEntryAttempt, markLoginEntryAttemptStatus, setOAuthError, startLogin],
  );

  const providerNameMap = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.displayName])),
    [providers],
  );

  const pendingProviderName = pendingProvider
    ? (providerNameMap.get(pendingProvider) ?? pendingProvider)
    : null;
  const visibleProviders = useMemo(() => resolveVisibleLoginProviders(providers), [providers]);

  useEffect(() => {
    if (active) {
      void refreshProviders();
    }
  }, [active, refreshProviders]);

  useEffect(() => {
    if (
      !active ||
      !loginEntryRequest?.providerId ||
      consumedLoginRequestRef.current === loginEntryRequest.id
    ) {
      return;
    }

    consumedLoginRequestRef.current = loginEntryRequest.id;
    clearLoginEntryRequest(loginEntryRequest.id);
    // The login/connection portal of the Model Provider used to bypass the unified login portal and directly initiate OAuth.
    // As a result, users cannot see unified wait, cancellation and error status. Here, the specified provider is automatically started after WelcomeScreen is opened.
    // Reuse the loading process of the login portal, and use request id to prevent repeated initiation in React strict mode.
    void startTrackedLogin(
      loginEntryRequest.providerId,
      {
        purpose: loginEntryRequest.purpose,
      },
      loginEntryRequest.id,
    );
  }, [active, clearLoginEntryRequest, loginEntryRequest, startTrackedLogin]);

  // When the Root layer OAuth callback fails, Zustand oauthError is written, and the unified login portal is responsible for displaying errors.
  useEffect(() => {
    if (oauthError && active) {
      finishActiveLoginEntryAttempt("failed");
      reset(); // Reset the waiting state of useOAuth
      // oauthError is already in the store, and the UI below will read and display it.
    }
  }, [active, finishActiveLoginEntryAttempt, oauthError, reset]);

  useEffect(() => {
    if (active && status === "error") {
      finishActiveLoginEntryAttempt("failed");
    }
  }, [active, finishActiveLoginEntryAttempt, status]);

  // After the OAuth callback is successful, the root layer sets the user and the unified login portal is automatically closed.
  useEffect(() => {
    if (
      active &&
      shouldCompleteLoginFromExistingUser({
        hasUser: Boolean(user),
        attempt: activeLoginEntryAttemptRef.current,
      })
    ) {
      // The global user may come from another Provider and cannot log in the newly initiated purchase.
      // Misjudged as success; Provider-specific attempt is only completed by matching OAuth success.
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [active, finishActiveLoginEntryAttempt, onComplete, reset, setOAuthError, user]);

  useEffect(() => {
    if (!active) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
      return;
    }

    if (oauthSuccessSeq > observedOAuthSuccessSeqRef.current) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
    } else {
      return;
    }

    if (
      status === "waiting" &&
      shouldCompleteProviderLoginAttempt({
        attempt: activeLoginEntryAttemptRef.current,
        successProvider: lastOAuthSuccessProvider,
      })
    ) {
      // provider connection reuses the same login portal visual process,
      // However, App user will not be written after success; here, Root's success signal is used to close the login portal and keep user interaction unchanged.
      finishActiveLoginEntryAttempt("succeeded");
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [
    active,
    finishActiveLoginEntryAttempt,
    lastOAuthSuccessProvider,
    oauthSuccessSeq,
    onComplete,
    reset,
    setOAuthError,
    status,
  ]);

  const resetApiKeyForm = useCallback(() => {
    setLoginMode("providers");
  }, []);

  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      return;
    }

    if (!wasActiveRef.current) {
      return;
    }
    wasActiveRef.current = false;

    if (status === "waiting") {
      void cancel(pendingProvider ?? undefined);
    }
    finishActiveLoginEntryAttempt("cancelled");
    reset();
    setOAuthError(null);
    clearLoginEntryRequest();
    resetApiKeyForm();
  }, [
    active,
    cancel,
    clearLoginEntryRequest,
    finishActiveLoginEntryAttempt,
    pendingProvider,
    reset,
    resetApiKeyForm,
    setOAuthError,
    status,
  ]);

  return (
    <>
      <LoginPanelHeader
        title={intl.formatMessage({ id: "login.title" })}
        description={intl.formatMessage({ id: "login.description" })}
      >
        {null}
      </LoginPanelHeader>

      <div className="space-y-6">
        {/* After Root writes oauthError (polling / callback failure) the effect resets useOAuth back
            to idle; checking only status==="idle" would put the failure block and the provider
            button list on screen together, with tangled state. While the failure stands, the block
            below takes over uniformly (sign in again / cancel), and the provider list returns once
            the error has been cleared.
            */}
        {status === "idle" && !oauthError && loginMode === "providers" && (
          <div className="space-y-4">
            {loadingProviders ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-4 animate-spin" />
                {intl.formatMessage({ id: "login.oauth.loadingProviders" })}
              </div>
            ) : null}

            {!loadingProviders && providers.length === 0 ? (
              <Alert
                variant="warning"
                className="flex items-center justify-center gap-2 text-center"
                data-testid={TID_OAUTH_ERROR}
              >
                <TriangleAlertIcon className="size-4" />
                <AlertDescription className="text-center">
                  {intl.formatMessage({ id: "login.oauth.noProviders" })}
                </AlertDescription>
              </Alert>
            ) : null}

            {!loadingProviders ? (
              <div className="space-y-2">
                {visibleProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="default"
                    className="h-10 w-full text-ui-base"
                    size="lg"
                    data-testid={
                      provider.id === BIGMODEL_PROVIDER_ID
                        ? TID_OAUTH_LOGIN_BUTTON
                        : testId(TID_OAUTH_LOGIN_BUTTON, provider.id)
                    }
                    onClick={() => void startTrackedLogin(provider.id)}
                  >
                    {renderOAuthProviderIcon(provider.id, "size-4")}
                    <span className="min-w-0 truncate">
                      {intl.formatMessage(
                        { id: getLoginOAuthButtonMessageId(provider.id) },
                        { provider: provider.displayName },
                      )}
                    </span>
                    <LoginOAuthRegionTag providerId={provider.id} />
                  </Button>
                ))}
                <Button
                  variant="outline"
                  className="h-10 w-full text-ui-base"
                  size="lg"
                  data-testid={TID_LOGIN_USE_API_KEY_BUTTON}
                  onClick={() => {
                    setLoginMode("apiKey");
                  }}
                >
                  {intl.formatMessage({ id: "login.useApiKey" })}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {status === "idle" && loginMode === "apiKey" ? (
          <LoginApiKeyForm
            onCancel={() => setLoginMode("providers")}
            onSaved={() => {
              resetApiKeyForm();
              return onComplete("apiKey");
            }}
            onSkipped={() => {
              resetApiKeyForm();
              return onComplete("skip");
            }}
          />
        ) : null}

        {status === "waiting" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface p-2 text-ui-base text-foreground-subtle">
              <LoaderIcon className="size-4 animate-spin" />
              {intl.formatMessage(
                { id: "login.oauth.waiting" },
                { provider: pendingProviderName ?? "OAuth" },
              )}
            </div>
            <Button
              variant="outline"
              className="h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // "Cancel" in the OAuth waiting state should only cancel the browser authorization wait.
                // The entire login portal cannot be closed, otherwise the user needs to reopen it from the portal to change the login method.
                finishActiveLoginEntryAttempt("cancelled");
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
          </div>
        )}

        {(status === "error" || oauthError) && (
          <div className="space-y-4">
            <Alert
              variant="warning"
              className="flex items-center justify-center gap-2 text-center"
              data-testid={TID_OAUTH_ERROR}
            >
              <TriangleAlertIcon className="size-4" />
              <AlertDescription className="text-center">
                {/* A sign-in failure is usually a retryable / switchable-provider state, so a destructive red
                    would misleadingly read as a destructive error. warning semantics are used
                    uniformly here, and the copy is centered to match the centered visual rhythm of
                    the sign-in panel.
                    */}
                {oauthError || error}
              </AlertDescription>
            </Alert>
            <Button
              className="h-10 w-full text-ui-base"
              size="lg"
              onClick={() => {
                const retryProvider = resolveLoginRetryProvider({
                  pendingProvider,
                  lastAttemptProvider: lastAttemptProviderRef.current,
                  providers,
                });
                if (!retryProvider) {
                  return;
                }
                // Failure of the OAuth callback triggers reset(), which clears the pendingProvider.
                // Re-login must follow the failed channel, and cannot return to BigModel because of the original order of providers[0].
                // Store residual errors are cleared uniformly before startTrackedLogin is initiated.
                void startTrackedLogin(retryProvider);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.retry" })}
            </Button>
            <Button
              variant="outline"
              className="h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // In the failed state, you cannot just "log in again" and try again along the original channel: if you want to change the channel, you can only close it.
                // When the login portal is reopened, it is easy to fail repeatedly on the same failed link. Here the alignment wait state is canceled
                // Semantics: End this failed process and return to the channel list, and the login portal will not be closed.
                finishActiveLoginEntryAttempt("cancelled");
                setOAuthError(null);
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function LoginPanelHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <header className="flex flex-col items-center gap-3 text-center">
      <LoginPanelLogo />
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-ui-base/relaxed text-foreground-subtle">{description}</p>
      </div>
      {children}
    </header>
  );
}

function LoginPanelLogo() {
  return (
    // The login logo shell has a fixed dark background, and the border cannot follow the light theme token, otherwise the border under the light theme will be too heavy.
    <div
      className="relative mb-1 flex size-16 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:border before:border-[rgba(255,255,255,0.1)]"
      aria-label="ZCode"
      role="img"
    >
      <ZCodeAboutLogo className="h-auto w-10" />
    </div>
  );
}

function getLoginOAuthButtonMessageId(providerId: string): string {
  switch (providerId) {
    case ZAI_PROVIDER_ID:
      return "login.oauth.button.zai";
    case BIGMODEL_PROVIDER_ID:
      return "login.oauth.button.bigmodel";
    default:
      return "login.oauth.button";
  }
}

function getLoginOAuthRegionTagMessageId(providerId: string): string | null {
  switch (providerId) {
    case ZAI_PROVIDER_ID:
      return "login.oauth.regionTag.zai";
    case BIGMODEL_PROVIDER_ID:
      return "login.oauth.regionTag.bigmodel";
    default:
      return null;
  }
}

function LoginOAuthRegionTag({ providerId }: { providerId: string }) {
  const { intl } = useZCodeIntl();
  const messageId = getLoginOAuthRegionTagMessageId(providerId);

  if (!messageId) {
    return null;
  }

  return (
    <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/30 px-2 text-ui-xs font-medium leading-none text-primary-foreground/60">
      {intl.formatMessage({ id: messageId })}
    </span>
  );
}

function getProviderPriority(provider: OAuthProviderMeta): number {
  switch (provider.id) {
    // In the Windows login portal, the z.ai portal needs to be fixed at the top.
    // After setting BigModel to a higher priority, the user will see the secondary entrance first on the first screen.
    // The sorting weight is directly adjusted here, only the display order is changed, and the real configuration source of the OAuth provider is not affected.
    case ZAI_PROVIDER_ID:
      return 0;
    case BIGMODEL_PROVIDER_ID:
      return 1;
    default:
      return 10 + provider.order;
  }
}

function resolveVisibleLoginProviders(providers: OAuthProviderMeta[]): OAuthProviderMeta[] {
  // ZAI / BigModel now share the App login fact source, and the login portal must display both portals when not logged in.
  // BigModel cannot be temporarily hidden, otherwise users cannot actively select BigModel as the active provider.
  return [...providers].sort((left, right) => {
    return getProviderPriority(left) - getProviderPriority(right);
  });
}

function resolveLoginRetryProvider({
  pendingProvider,
  lastAttemptProvider,
  providers,
}: {
  pendingProvider: OAuthProviderMeta["id"] | null;
  lastAttemptProvider: OAuthProviderMeta["id"] | null;
  providers: OAuthProviderMeta[];
}): OAuthProviderMeta["id"] | null {
  return pendingProvider ?? lastAttemptProvider ?? providers[0]?.id ?? null;
}
