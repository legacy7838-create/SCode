import type { ControlledView } from "./browserCommandTypes.js";

interface ScreenshotCaptureResult {
  data?: string;
}

interface ScreenshotDimensions {
  height: number;
  width: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const SCREENSHOT_DIMENSION_EPSILON = 1;
const SCREENSHOT_SCALE_EPSILON = 0.001;
const MAX_SCREENSHOT_QUALITY_SCALE = 2;
const MIN_SCREENSHOT_QUALITY_SCALE = 1.25;
const MAX_SCREENSHOT_RASTER_EDGE = 4096;
const MAX_SCREENSHOT_RASTER_PIXELS = 16_777_216;

function readPngDimensions(data: string): ScreenshotDimensions | null {
  try {
    // The signature + IHDR size of PNG only occupies the first 24 bytes to avoid copying the entire large image in order to read the width and height.
    const header = Buffer.from(data.slice(0, 64), "base64");
    if (
      header.byteLength < 24 ||
      PNG_SIGNATURE.some((byte, index) => header[index] !== byte) ||
      header.toString("ascii", 12, 16) !== "IHDR"
    ) {
      return null;
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function screenshotDimensionDistance(
  actual: ScreenshotDimensions,
  target: ScreenshotDimensions,
): number {
  return (
    Math.abs(actual.width - target.width) / target.width +
    Math.abs(actual.height - target.height) / target.height
  );
}

function screenshotMatchesTarget(
  actual: ScreenshotDimensions,
  target: ScreenshotDimensions,
): boolean {
  return (
    Math.abs(actual.width - target.width) < SCREENSHOT_DIMENSION_EPSILON &&
    Math.abs(actual.height - target.height) < SCREENSHOT_DIMENSION_EPSILON
  );
}

function screenshotHasUniformScale(
  actual: ScreenshotDimensions,
  target: ScreenshotDimensions,
): boolean {
  return (
    Math.abs(actual.width / target.width - actual.height / target.height) <=
    SCREENSHOT_SCALE_EPSILON
  );
}

function resolveScreenshotQualityScale(target: ScreenshotDimensions): number {
  const targetPixels = target.width * target.height;
  const qualityScale = Math.min(
    MAX_SCREENSHOT_QUALITY_SCALE,
    MAX_SCREENSHOT_RASTER_EDGE / target.width,
    MAX_SCREENSHOT_RASTER_EDGE / target.height,
    Math.sqrt(MAX_SCREENSHOT_RASTER_PIXELS / targetPixels),
  );

  // A large viewport already has enough pixels. When the magnification is too small, the benefits are limited, but a large image capture will still be added.
  return Number.isFinite(qualityScale) && qualityScale >= MIN_SCREENSHOT_QUALITY_SCALE
    ? qualityScale
    : 1;
}

async function resizeScreenshotToTarget(
  view: ControlledView,
  result: ScreenshotCaptureResult,
  target: ScreenshotDimensions,
): Promise<ScreenshotCaptureResult | null> {
  if (!view.resizeScreenshotToCssPixels || !result.data) return null;
  try {
    const resizedData = await view.resizeScreenshotToCssPixels(result.data, target);
    if (!resizedData) return null;
    const resizedDimensions = readPngDimensions(resizedData);
    return resizedDimensions && screenshotMatchesTarget(resizedDimensions, target)
      ? { ...result, data: resizedData }
      : null;
  } catch {
    return null;
  }
}

function chooseHigherInformationScreenshot(
  first: ScreenshotCaptureResult,
  firstDimensions: ScreenshotDimensions,
  second: ScreenshotCaptureResult,
  secondDimensions: ScreenshotDimensions,
): ScreenshotCaptureResult {
  const firstPixels = firstDimensions.width * firstDimensions.height;
  const secondPixels = secondDimensions.width * secondDimensions.height;
  if (secondPixels !== firstPixels) return secondPixels > firstPixels ? second : first;
  return screenshotDimensionDistance(secondDimensions, firstDimensions) <= SCREENSHOT_SCALE_EPSILON
    ? second
    : first;
}

function readScreenshotTarget(params: Record<string, unknown>): {
  scale: number;
  target: ScreenshotDimensions;
} | null {
  const clip = params.clip;
  if (!clip || typeof clip !== "object" || Array.isArray(clip)) return null;
  const value = clip as { height?: unknown; scale?: unknown; width?: unknown };
  if (
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    value.width <= 0 ||
    typeof value.height !== "number" ||
    !Number.isFinite(value.height) ||
    value.height <= 0 ||
    typeof value.scale !== "number" ||
    !Number.isFinite(value.scale) ||
    value.scale <= 0
  ) {
    return null;
  }
  return {
    scale: value.scale,
    // PNG rasters only have integer pixels; CSS clips may come from content metrics with decimals.
    target: {
      width: Math.max(1, Math.round(value.width)),
      height: Math.max(1, Math.round(value.height)),
    },
  };
}

export async function captureScreenshotWithCssPixelCorrection(
  view: ControlledView,
  params: Record<string, unknown>,
): Promise<ScreenshotCaptureResult> {
  const first = (await view.cdp.send("Page.captureScreenshot", params)) as ScreenshotCaptureResult;
  if (!view.normalizeScreenshotToCssPixels || !first.data) return first;

  const expected = readScreenshotTarget(params);
  const firstDimensions = readPngDimensions(first.data);
  if (!expected || !firstDimensions) return first;
  if (!screenshotHasUniformScale(firstDimensions, expected.target)) return first;

  if (
    firstDimensions.width > expected.target.width &&
    firstDimensions.height > expected.target.height
  ) {
    // Retina/guest compositor returns the high-resolution first frame and then uses decimal CDP
    // Scale capture loses text detail during the Chromium rendering phase. The target size must be from the current
    // CSS clip, host-side high-quality downsampling of rendered high-resolution PNGs, does not assume fixed DPR.
    return (await resizeScreenshotToTarget(view, first, expected.target)) ?? first;
  }

  const firstMatchesTarget = screenshotMatchesTarget(firstDimensions, expected.target);
  const widthCorrection = expected.target.width / firstDimensions.width;
  const heightCorrection = expected.target.height / firstDimensions.height;
  const qualityScale = view.resizeScreenshotToCssPixels
    ? resolveScreenshotQualityScale(expected.target)
    : 1;
  if (firstMatchesTarget && qualityScale === 1) return first;

  const correctedScale =
    expected.scale *
    (firstMatchesTarget ? qualityScale : ((widthCorrection + heightCorrection) / 2) * qualityScale);
  if (
    !Number.isFinite(correctedScale) ||
    correctedScale < expected.scale ||
    Math.abs(correctedScale - expected.scale) < SCREENSHOT_SCALE_EPSILON
  ) {
    return first;
  }

  // Under attach/first frame timing, IHDR is exactly equal to the CSS target, or it may just be that details have been lost.
  // Low definition raster. The fixed 1280×720/Retina DPR cannot be used as a criterion; it is calculated dynamically based on the current clip.
  // A bounded quality source that is re-caught at most once and downsampled by the host graphics engine to a CSS target.
  let corrected: ScreenshotCaptureResult;
  try {
    corrected = (await view.cdp.send("Page.captureScreenshot", {
      ...params,
      clip: {
        ...(params.clip as Record<string, unknown>),
        scale: correctedScale,
      },
    })) as ScreenshotCaptureResult;
  } catch {
    return first;
  }
  if (!corrected.data) return first;
  const correctedDimensions = readPngDimensions(corrected.data);
  if (!correctedDimensions) return first;
  if (!screenshotHasUniformScale(correctedDimensions, expected.target)) return first;
  if (screenshotMatchesTarget(correctedDimensions, expected.target)) return corrected;
  if (
    correctedDimensions.width > expected.target.width &&
    correctedDimensions.height > expected.target.height
  ) {
    const resized = await resizeScreenshotToTarget(view, corrected, expected.target);
    if (resized) return resized;
  }
  return chooseHigherInformationScreenshot(first, firstDimensions, corrected, correctedDimensions);
}
