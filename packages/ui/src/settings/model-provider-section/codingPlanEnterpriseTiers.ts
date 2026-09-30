import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";

// 2026-09: The native purchase panel (CodingPlanPurchasePanel) is offline as a whole, and the purchase process is switched to the embedded official website
// webview. This file is moved out of the panel and is still used by the settings page (Detail.tsx) and login recovery logic.
// Enterprise package grouping/level display helper to avoid live code dependence on 6200 dead panel files.

export type PurchaseAudience = "personal" | "team";

export interface EnterpriseCodingPlanProductGroup {
  key: string;
  title: string;
  products: EnterpriseCodingPlanProductDisplay[];
}
