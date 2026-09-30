type OAuthCallback = (url: string) => void | Promise<void>;

export function createOAuthCallbackHandler(callback: OAuthCallback, notifyHandled: () => void) {
  return async (_event: unknown, url: string): Promise<void> => {
    try {
      await callback(url);
    } catch {
      // preload is only responsible for bridging the OAuth callback and handshaking with the main process, and cannot continue to throw renderer callback exceptions as unhandled rejections.
      // Business errors are displayed by the renderer itself; regardless of success or failure, a handled receipt must be sent back to main.
    } finally {
      notifyHandled();
    }
  };
}
