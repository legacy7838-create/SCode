import type { ProviderConfigObject } from "@zcode/provider";

/**
 * Product display exception: image input for the GLM-5.3 plan is bridged server-side, so a bridged
 * capability must not be labeled as native vision.
 */
export function shouldShowModelVisionBadge(
  modelId: string,
  supportsImage: boolean | null | undefined,
  access?: ProviderConfigObject["access"],
): boolean {
  if (supportsImage !== true) return false;
  // The Experience Plan is also covered by the display exception; like the Coding Plan only the GLM-5.3 logo is hidden.
  const hideGlm53Vision =
    access?.type === "zhipu-coding-plan-api-key" ||
    (access?.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" ||
        access.mode === "team-coding-plan" ||
        access.mode === "start-plan"));
  // Controls only logo, does not change capability facts, attachment verification, or exact model identity; Flash and other models are not affected.
  return !(hideGlm53Vision && modelId.toLowerCase() === "glm-5.3");
}
