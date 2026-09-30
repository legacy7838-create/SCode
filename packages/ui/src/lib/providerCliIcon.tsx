import type { ZCodeProvider } from "@zcode/shared";
import { GlmMonochromeIcon } from "@/components/ui/GlmMonochromeIcon.js";

export function renderProviderCliIcon(_provider: ZCodeProvider = "glm", className?: string) {
  // Only the glm provider is left; the original logo outline is retained and only grayed out.
  // Although the previous wireframe was more "pure black and white", the brand recognition dropped too obviously;
  // After changing to the unified filter, the page still has the original logo, and the colors are more restrained.
  return <GlmMonochromeIcon className={className} />;
}
