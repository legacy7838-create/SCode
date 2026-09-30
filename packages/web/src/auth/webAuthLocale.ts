interface WebAuthPageCopy {
  brand: string;
  loginTitle: string;
  loginDescription: string;
  loginAction: string;
  callbackTitle: string;
  callbackDescription: string;
  callbackErrorTitle: string;
  callbackErrorDescription: string;
  retryAction: string;
  waitingTitle: string;
  waitingDescription: string;
  signedInAs: string;
  logoutAction: string;
}

export const WEB_AUTH_COPY: WebAuthPageCopy = {
  brand: "ZCode",
  loginTitle: "Sign In To Continue",
  loginDescription: "Use the same Z.AI account identity as desktop for Web remote control.",
  loginAction: "Sign in with Z.AI",
  callbackTitle: "Finishing Sign-In",
  callbackDescription: "Verifying your account identity.",
  callbackErrorTitle: "Sign-In Failed",
  callbackErrorDescription: "The authorization flow did not complete. Sign in again.",
  retryAction: "Sign In Again",
  waitingTitle: "Signed In",
  waitingDescription:
    "Device selection is coming next. No remote target is selected for this account yet.",
  signedInAs: "Signed in as",
  logoutAction: "Disconnect",
};
