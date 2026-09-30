import type { CodingPlanStatus } from "./constants.js";

export interface CodingPlanStatusPanelViewState {
  displayStatus: CodingPlanStatus;
  actionStatus: CodingPlanStatus;
  balanceStatus: CodingPlanStatus;
  loginLoading: boolean;
}

export function resolveCodingPlanStatusPanelViewState({
  status,
  loginPending,
}: {
  status: CodingPlanStatus;
  loginPending: boolean;
}): CodingPlanStatusPanelViewState {
  if (!loginPending) {
    return buildStableCodingPlanStatusPanelViewState(status, false);
  }

  if (status === "purchased" || status === "notPurchased") {
    // Both states come from the resolved entitlement snapshot. Continue to display when background refreshes
    // Cache results and keep only the loading flag to avoid details flickering between old data and checking.
    return buildStableCodingPlanStatusPanelViewState(status, true);
  }

  return {
    // Login pending and equity query checking are two semantics.
    // The login status copy needs to feedback checking, but the button should still be retained in its pre-click state and the spinner should be displayed;
    // The Start Plan balance card cannot appear in advance due to login pending.
    displayStatus: "checking",
    actionStatus: status,
    balanceStatus: status,
    loginLoading: true,
  };
}

function buildStableCodingPlanStatusPanelViewState(
  status: CodingPlanStatus,
  loginLoading: boolean,
): CodingPlanStatusPanelViewState {
  return {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading,
  };
}
