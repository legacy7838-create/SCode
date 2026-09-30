/**
 * Typed wrapper over the zcode-image napi binary (spec: docs/specs/rust-native-image.md).
 * Load errors are thrown loudly by loadNative — there is no JS fallback here.
 */
import { loadNative } from "./loader.js";

export interface NativeImageCancelHandle {
  cancel(): void;
}

export interface NativeImagePrepareRequest {
  data: Uint8Array;
  mediaType: string;
  maxDimension: number;
  maxBase64Bytes: number;
  maxRawBytes: number;
  maxTokens?: number;
  tokenToBase64CharRatio?: number;
}

export interface NativeImageResizeToFitRequest {
  data: Uint8Array;
  mediaType: string;
  maxDimension: number;
}

export interface NativeImageResizeResult {
  data: Uint8Array;
  mediaType: string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  resized: boolean;
}

export interface NativeImagePrepareResult {
  data: Uint8Array;
  mediaType: string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  resized: boolean;
  compressed: boolean;
  strategy: string;
  originalSizeBytes: number;
  transformedSizeBytes: number;
}

export interface NativeImageApi {
  ImageCancelHandle: { new (): NativeImageCancelHandle };
  prepareImageForModel(
    request: NativeImagePrepareRequest,
    cancel: NativeImageCancelHandle,
  ): Promise<NativeImagePrepareResult>;
  resizeImageToFit(
    request: NativeImageResizeToFitRequest,
    cancel: NativeImageCancelHandle,
  ): Promise<NativeImageResizeResult>;
}

export function loadNativeImageApi(): NativeImageApi {
  return loadNative<NativeImageApi>("zcode-image");
}
