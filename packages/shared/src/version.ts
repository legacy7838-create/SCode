// Injected by each bundler through define to avoid cross-bundler compatibility issues of JSON import at runtime.
// define does not exist in non-build environments (such as mocha for e2e testing).
// Use typeof checking + fallback to avoid ReferenceError.
declare const __ZCODE_VERSION__: string;
declare const __ZCODE_COMMIT__: string;
declare const __ZCODE_BUILD_TIME__: string;

export const ZCODE_VERSION: string =
  typeof __ZCODE_VERSION__ !== "undefined" ? __ZCODE_VERSION__ : "0.0.0-dev";
export const ZCODE_COMMIT: string =
  typeof __ZCODE_COMMIT__ !== "undefined" ? __ZCODE_COMMIT__ : "unknown";
export const ZCODE_BUILD_TIME: string =
  typeof __ZCODE_BUILD_TIME__ !== "undefined" ? __ZCODE_BUILD_TIME__ : "unknown";
