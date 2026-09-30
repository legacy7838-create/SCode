import type { OAuthCachedSessionRestoreResult, UserInfo } from "@zcode/shared";
import type { AlertDialogRequest } from "@/store/alertDialogStore.js";

export async function applyCachedOAuthSessionRestoreResult(params: {
  result: OAuthCachedSessionRestoreResult;
  setUser: (user: UserInfo | null) => void;
  requestAlert: (request: AlertDialogRequest) => Promise<boolean>;
  onReauthenticationRequired: () => void;
  copy: AlertDialogRequest;
}): Promise<boolean> {
  if (params.result.status === "authenticated") {
    params.setUser(params.result.userInfo);
    return true;
  }

  if (params.result.status === "reauthentication-required") {
    // The authentication fact has expired and the UI login status cannot be cleared after the user confirms the pop-up window.
    params.setUser(null);
    await params.requestAlert(params.copy);
    params.onReauthenticationRequired();
  }

  return false;
}
