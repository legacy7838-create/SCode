/**
 * Geometry math for the permission drag floating panel.
 *
 * Deliberately a pure function with no Electron dependency: snapping needs the "bounds of the
 * system settings window", external data that may be unavailable at any time (the CLI providing it
 * did not ship, was killed, or the settings page was never opened). Only after separating the
 * geometry from the data lookup can the fail-open behavior be tested exhaustively — snapping is a
 * visual nicety, not a usability requirement, so when the bounds cannot be obtained the panel must
 * fall back to a position that is definitely usable.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

interface ResolvePanelBoundsInput {
  /** The system sets the screen coordinates of the main window; null means it is currently unavailable (fail-open to the bottom of the screen). */
  settings: Rect | null;
  /** The available workspace of the target monitor (menu bar/Dock excluded). */
  display: Rect;
  panel: PanelSize;
}

/** When adsorbed, it slightly overlaps with the bottom edge of the settings page, making the panel and settings page look and feel integrated. */
const ANCHOR_OVERLAP_PX = 6;
/** The margin at the bottom of the screen when fail-opening. */
const SCREEN_BOTTOM_INSET_PX = 28;

function clamp(value: number, min: number, max: number): number {
  // When max < min (the panel is larger than the visual area), priority is given to ensuring that it does not exceed the upper/left boundary
  return Math.max(min, Math.min(value, max));
}

function isUsableRect(rect: Rect | null): rect is Rect {
  // CGWindowList occasionally returns a 0-size transitional window; snapping to it will throw the panel to the corner of the screen and be treated as unavailable.
  return rect !== null && rect.width > 0 && rect.height > 0;
}

export function resolvePanelBounds(input: ResolvePanelBoundsInput): Rect {
  const { settings, display, panel } = input;

  const anchored = isUsableRect(settings);
  const rawX = anchored
    ? settings.x + (settings.width - panel.width) / 2
    : display.x + (display.width - panel.width) / 2;
  const rawY = anchored
    ? settings.y + settings.height - ANCHOR_OVERLAP_PX
    : display.y + display.height - panel.height - SCREEN_BOTTOM_INSET_PX;

  return {
    x: Math.round(clamp(rawX, display.x, display.x + display.width - panel.width)),
    y: Math.round(clamp(rawY, display.y, display.y + display.height - panel.height)),
    width: Math.round(panel.width),
    height: Math.round(panel.height),
  };
}
