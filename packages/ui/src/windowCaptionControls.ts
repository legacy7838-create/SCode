import type { CSSProperties } from "react";

const WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX = 136;
export const WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR =
  "var(--windows-caption-controls-right-inset)";

type WindowsCaptionControlsStyle = CSSProperties & {
  "--windows-caption-controls-right-inset": string;
  "--windows-caption-control-width": string;
};

export function createWindowsCaptionControlsStyle(
  _fallbackRightInsetPx = WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX,
): WindowsCaptionControlsStyle {
  return {
    // Self-drawn buttons scale with the page; the geometry after WCO is turned off may still return to the full window width and can no longer be used to calculate the safe area.
    "--windows-caption-controls-right-inset": `${WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX}px`,
    // The old caption menu on the settings page still reuses the third equal width; the compact window control itself uses a fixed 28px.
    "--windows-caption-control-width": "calc(var(--windows-caption-controls-right-inset) / 3)",
  };
}

// This style can only be explicitly enabled by the Windows title bar path to avoid affecting the original spacing of Linux self-drawn title bars.
export const WINDOWS_CAPTION_CONTROL_CLASS =
  "h-full w-[var(--windows-caption-control-width,46px)] rounded-none";
