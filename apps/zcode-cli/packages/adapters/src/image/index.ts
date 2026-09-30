import {
  createImageProcessorError,
  type ImageCompressionStrategy,
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
  type ImageProcessorPort,
  type ImageResizeRequest,
  type ImageResizeResult,
} from "@zcode/contracts";
import { loadNativeImageApi } from "@zcode/rust/image";

// Native image processor (spec: docs/specs/rust-native-image.md). The decode,
// resize and encode ladder run inside the zcode-image napi binary; this adapter
// only maps contracts ↔ native payloads and translates errors. There is no JS
// fallback: if the binary cannot be loaded, loadNative throws at import time.
const nativeApi = loadNativeImageApi();

// Native error messages use the `zcode-image:<code>:<message>` transport
// defined in the port spec.
function mapNativeError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^zcode-image:([a-z_]+):([\s\S]*)$/.exec(message);
  if (!match) {
    throw createImageProcessorError({
      code: "processing_failed",
      message: "Image processing failed in the native image adapter",
      cause: error,
    });
  }
  const [, code, detail] = match;
  if (code === "aborted") {
    throw new Error(detail);
  }
  if (
    code === "empty" ||
    code === "invalid_request" ||
    code === "processing_failed" ||
    code === "too_large" ||
    code === "unsupported"
  ) {
    throw createImageProcessorError({
      code,
      message: detail,
      cause: error,
    });
  }
  throw createImageProcessorError({
    code: "processing_failed",
    message: detail,
    cause: error,
  });
}

function createCancelHandle(signal: AbortSignal | undefined) {
  const handle = new nativeApi.ImageCancelHandle();
  if (signal) {
    if (signal.aborted) {
      throw new Error("Image resize was cancelled");
    }
    signal.addEventListener("abort", () => handle.cancel(), { once: true });
  }
  return handle;
}

class NativeImageProcessorAdapter implements ImageProcessorPort {
  async resizeToFit(
    request: ImageResizeRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImageResizeResult> {
    if (!Number.isFinite(request.maxDimension) || request.maxDimension <= 0) {
      throw new Error("Image resize maxDimension must be a positive finite number");
    }
    const cancel = createCancelHandle(options.signal);
    try {
      return await nativeApi.resizeImageToFit(
        {
          data: request.data,
          mediaType: request.mediaType,
          maxDimension: request.maxDimension,
        },
        cancel,
      );
    } catch (error) {
      mapNativeError(error);
    }
  }

  async prepareForModel(
    request: ImagePrepareForModelRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImagePrepareForModelResult> {
    const cancel = createCancelHandle(options.signal);
    try {
      const result = await nativeApi.prepareImageForModel(
        {
          data: request.data,
          mediaType: request.mediaType,
          maxDimension: request.maxDimension,
          maxBase64Bytes: request.maxBase64Bytes,
          maxRawBytes: request.maxRawBytes,
          maxTokens: request.maxTokens,
          tokenToBase64CharRatio: request.tokenToBase64CharRatio,
        },
        cancel,
      );
      return {
        data: result.data,
        mediaType: result.mediaType,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        width: result.width,
        height: result.height,
        resized: result.resized,
        compressed: result.compressed,
        strategy: result.strategy as ImageCompressionStrategy,
        originalSizeBytes: result.originalSizeBytes,
        transformedSizeBytes: result.transformedSizeBytes,
      };
    } catch (error) {
      mapNativeError(error);
    }
  }
}

export function createImageProcessorAdapter(): ImageProcessorPort {
  return new NativeImageProcessorAdapter();
}
