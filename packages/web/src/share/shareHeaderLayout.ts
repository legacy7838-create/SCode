interface ShareHeaderMeasurements {
  /** Share the width of the Header shell. */
  shellWidth: number;
  /** Content rail The distance from the left and right edges to the edge of the shell. */
  railContentLeft: number;
  railContentRight: number;
  brandWidth: number;
  titleContentWidth: number;
  /** Total width of theme button with full continue CTA. */
  continueWidth: number;
  /** Theme buttons compactly continue the total width of the CTA. */
  compactContinueWidth?: number;
  /** Whether the right area contains a continue CTA; read-only sharing will still retain the topic button. */
  hasContinueAction?: boolean;
  gap?: number;
  /** The padding of the widescreen anchor point from the edge of the viewport. */
  edgePadding?: number;
  /** The safe distance that must be maintained before elements on both sides enter continuous displacement animation. */
  minClearance?: number;
  /** A full CTA should be at least as wide as the visible title. */
  minTitleWidth?: number;
}

export interface ShareHeaderView {
  /** 0 is the inline position inside the content column, 1 is the anchored position at the viewport edges. */
  progress: number;
  brandLeft: number;
  titleLeft: number;
  titleWidth: number;
  continueRight: number;
  titleTruncated: boolean;
  continueVisible: boolean;
  continueCompact: boolean;
}

const DEFAULT_GAP = 16;
const DEFAULT_EDGE_PADDING = 24;
const DEFAULT_MIN_CLEARANCE = 16;
const DEFAULT_MIN_TITLE_WIDTH = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/**
 * Computes the continuous geometry of the share Header.
 *
 * This used to return two discrete layouts, inline and rail-aligned, so the brand and the CTA
 * would switch from the flex flow to absolute positioning all at once at the critical width. It
 * now derives progress from the gutter available between the content column and the viewport
 * edges, which lets the three elements move continuously along a single track: the wide-screen
 * outer anchors are held for as long as the gutter can still accommodate the corresponding
 * element, and only once the gutter runs short do they start collapsing back toward the content
 * column.
 */
export function resolveShareHeaderView({
  shellWidth,
  railContentLeft,
  railContentRight,
  brandWidth,
  titleContentWidth,
  continueWidth,
  compactContinueWidth = continueWidth,
  hasContinueAction = continueWidth > 0,
  gap = DEFAULT_GAP,
  edgePadding = DEFAULT_EDGE_PADDING,
  minClearance = DEFAULT_MIN_CLEARANCE,
  minTitleWidth = DEFAULT_MIN_TITLE_WIDTH,
}: ShareHeaderMeasurements): ShareHeaderView {
  const normalizedShellWidth = Math.max(0, shellWidth);
  const normalizedRailLeft = Math.max(0, railContentLeft);
  const normalizedRailRight = Math.max(0, railContentRight);
  const normalizedBrandWidth = Math.max(0, brandWidth);
  const normalizedTitleContentWidth = Math.max(0, titleContentWidth);
  const normalizedContinueWidth = Math.max(0, continueWidth);
  const normalizedCompactContinueWidth = Math.min(
    normalizedContinueWidth,
    Math.max(0, compactContinueWidth),
  );
  const normalizedGap = Math.max(0, gap);
  const normalizedEdgePadding = Math.max(0, edgePadding);
  const normalizedMinClearance = Math.max(0, minClearance);
  const normalizedMinTitleWidth = Math.max(0, minTitleWidth);
  const brandRequiredGutter = normalizedBrandWidth + normalizedEdgePadding + normalizedMinClearance;
  const brandProgress = clamp(normalizedRailLeft / brandRequiredGutter, 0, 1);
  const narrowBrandLeft = normalizedRailLeft;
  const narrowTitleLeft = normalizedRailLeft + normalizedBrandWidth + normalizedGap;
  const wideBrandLeft = normalizedEdgePadding;
  const wideTitleLeft = normalizedRailLeft;
  const wideTitleRight = normalizedShellWidth - normalizedRailRight;
  const wideContinueRight = normalizedEdgePadding;
  const brandLeft = lerp(narrowBrandLeft, wideBrandLeft, brandProgress);
  const titleLeft = Math.max(
    brandLeft + normalizedBrandWidth + normalizedGap,
    lerp(narrowTitleLeft, wideTitleLeft, brandProgress),
  );

  const resolveTrailingGeometry = (trailingWidth: number) => {
    const continueRequiredGutter = trailingWidth + normalizedEdgePadding + normalizedMinClearance;
    const continueProgress =
      trailingWidth === 0 ? 1 : clamp(normalizedRailRight / continueRequiredGutter, 0, 1);
    const continueRight = lerp(normalizedRailRight, wideContinueRight, continueProgress);
    const narrowTitleRight =
      normalizedShellWidth - normalizedRailRight - trailingWidth - normalizedGap;
    const titleRight = Math.min(
      lerp(narrowTitleRight, wideTitleRight, continueProgress),
      normalizedShellWidth - continueRight - trailingWidth - normalizedGap,
    );
    return {
      continueProgress,
      continueRight,
      titleWidth: Math.max(0, titleRight - titleLeft),
    };
  };

  const fullGeometry = resolveTrailingGeometry(normalizedContinueWidth);
  // Extremely narrow screens still permanently reserve width for the complete CTA, which will push the title to 0. Keep the continuous track first,
  // Switch to a compact icon button in the same position only if the full CTA cannot leave the minimum title width.
  const continueCompact =
    hasContinueAction &&
    normalizedCompactContinueWidth < normalizedContinueWidth &&
    fullGeometry.titleWidth < normalizedMinTitleWidth;
  const geometry = continueCompact
    ? resolveTrailingGeometry(normalizedCompactContinueWidth)
    : fullGeometry;

  return {
    progress: Math.min(brandProgress, geometry.continueProgress),
    brandLeft,
    titleLeft,
    titleWidth: geometry.titleWidth,
    continueRight: geometry.continueRight,
    titleTruncated: normalizedTitleContentWidth > geometry.titleWidth,
    continueVisible: hasContinueAction,
    continueCompact,
  };
}
