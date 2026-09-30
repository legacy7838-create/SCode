"use strict";

const v8 = require("node:v8");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { basename, dirname, join } = require("node:path");

function configureBytecodeRuntime() {
  // The bytecode does not come with recompilable source code and must be completely compiled and preserved; the compiler and loader share this configuration.
  v8.setFlagsFromString("--no-lazy --no-flush-bytecode");
  return {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cachedDataVersionTag: v8.cachedDataVersionTag(),
  };
}

function bytecodeDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadBytecode(metadata, targetModule, targetRequire) {
  const runtime = configureBytecodeRuntime();
  if (JSON.stringify(runtime) !== JSON.stringify(metadata.runtime)) {
    throw new Error(
      "The bytecode runtime does not match, please rerun pnpm build:desktop-agent:bytecode with the current Electron",
    );
  }
  const directory = dirname(targetModule.filename);
  if (basename(metadata.bytecodeFile) !== metadata.bytecodeFile) {
    throw new Error("Invalid bytecode file name");
  }
  const cachedData = await readFile(join(directory, metadata.bytecodeFile));
  if (bytecodeDigest(cachedData) !== metadata.bytecodeSha256) {
    throw new Error("Bytecode digest mismatch, please rebuild desktop agent");
  }
  // Use ASCII spaces instead of double-byte zero-width characters. Here only the plaintext source code is eliminated, and the equal-length placeholder memory is still retained.
  const source = " ".repeat(metadata.sourceLength);
  const filename = join(directory, metadata.sourceFile);
  const script = new vm.Script(source, {
    cachedData,
    filename,
    // Dynamic import must be returned to Node, and external ESM and native dependencies will continue to be parsed according to the URL of the original bundle.
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  if (script.cachedDataRejected) {
    throw new Error("V8 refuses bytecode caching, please rebuild the desktop agent");
  }
  const run = script.runInThisContext();
  if (typeof run !== "function") throw new Error("Bytecode is not a CommonJS module");
  run.call(
    targetModule.exports,
    targetModule.exports,
    targetRequire,
    targetModule,
    filename,
    directory,
  );
}

module.exports = { configureBytecodeRuntime, bytecodeDigest, loadBytecode };
