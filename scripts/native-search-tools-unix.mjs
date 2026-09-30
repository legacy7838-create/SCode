/* eslint-disable max-lines -- Native search and build steps share the same compilation environment in dependency order, making centralized maintenance easier to audit. */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import process from "node:process";
import {
  LINUX_NATIVE_SEARCH_GLIBC_BASELINE,
  MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET,
  NATIVE_SEARCH_BFS_CONFIGURE_ARGS,
  NATIVE_SEARCH_TOOL_VERSIONS,
  getNativeSearchSourceArchivesForTarget,
  isMacosRosettaTarget,
  normalizeNativeSearchArch,
  normalizeNativeSearchPlatform,
  resolveNativeSearchBuildPlan,
} from "./native-search-tools-config.mjs";
import { downloadAndExtractSources, run, runCapture } from "./native-search-tools-process.mjs";
import { verifyBuiltNativeSearchProducerOutputs } from "./native-search-tools-verify.mjs";

const MACOS_BFS_CPP_FLAGS = Object.freeze([
  // The macOS 26 SDK will let bfs give priority to the standard functions that only exist in 26.0; after blocking, the _np version available since 10.15 will be used.
  "-Dposix_spawn_file_actions_addfchdir=__bfs_poison_addfchdir_macos_26_0",
  "-Dfdclosedir=__bfs_poison_fdclosedir_macos_26_4",
]);

function appendFlags(currentValue, flags) {
  return [currentValue, ...flags].filter(Boolean).join(" ");
}

function readVersionMajor(version) {
  return Number.parseInt(String(version).trim().split(".", 1)[0] ?? "", 10);
}

export function assertLinuxNativeSearchBuildEnvironment({
  nodeVersion,
  glibcVersion,
  gccVersion,
  cxxVersion,
}) {
  if (readVersionMajor(nodeVersion) !== 24) {
    throw new Error(
      `Linux native search producer requires Node 24; received ${nodeVersion || "<missing>"}`,
    );
  }
  if (String(glibcVersion).trim() !== LINUX_NATIVE_SEARCH_GLIBC_BASELINE) {
    throw new Error(
      `Linux native search producer requires builder glibc ${LINUX_NATIVE_SEARCH_GLIBC_BASELINE}; received ${glibcVersion || "<missing>"}`,
    );
  }
  if (readVersionMajor(gccVersion) !== 12) {
    throw new Error(
      `Linux native search producer requires GCC 12; received ${gccVersion || "<missing>"}`,
    );
  }
  if (readVersionMajor(cxxVersion) !== 12) {
    throw new Error(
      `Linux native search producer requires G++ 12 via CXX; received ${cxxVersion || "<missing>"}`,
    );
  }
}

function verifyLinuxNativeSearchBuildEnvironment(config) {
  const glibcVersion = runCapture("getconf", ["GNU_LIBC_VERSION"])
    .trim()
    .replace(/^glibc\s+/u, "");
  const gccVersion = runCapture(config.cc, ["-dumpfullversion"]).trim();
  // ugrep is compiled by CXX; checking only CC will make mixed toolchains like CXX=g++-13
  // Bypass the producer access control and write non-GCC Toolset 12 C++ products into fixed release.
  const cxxVersion = runCapture(config.cxx, ["-dumpfullversion"]).trim();
  assertLinuxNativeSearchBuildEnvironment({
    nodeVersion: process.versions.node,
    glibcVersion,
    gccVersion,
    cxxVersion,
  });
  console.log(
    `==> Linux producer environment Node ${process.versions.node}, glibc ${glibcVersion}, GCC ${gccVersion}, G++ ${cxxVersion}`,
  );
}

export function resolveNativeUnixBuildConfig({
  platform = process.platform,
  arch = process.arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  env = process.env,
} = {}) {
  const normalizedPlatform = normalizeNativeSearchPlatform(platform);
  const normalizedArch = normalizeNativeSearchArch(arch);
  const normalizedHostPlatform = normalizeNativeSearchPlatform(hostPlatform);
  const normalizedHostArch = normalizeNativeSearchArch(hostArch);

  if (normalizedPlatform !== "darwin" && normalizedPlatform !== "linux") {
    throw new Error(`native Unix search build does not support platform ${normalizedPlatform}`);
  }
  const usesRosettaCrossBuild = isMacosRosettaTarget({
    platform: normalizedPlatform,
    arch: normalizedArch,
    hostPlatform: normalizedHostPlatform,
    hostArch: normalizedHostArch,
  });
  if (
    normalizedHostPlatform !== normalizedPlatform ||
    (normalizedHostArch !== normalizedArch && !usesRosettaCrossBuild)
  ) {
    throw new Error(
      `native Unix search build must run natively for ${normalizedPlatform}-${normalizedArch}; host is ${normalizedHostPlatform}-${normalizedHostArch}`,
    );
  }

  const targetCompilerArgs =
    normalizedPlatform === "darwin" ? ["-arch", normalizedArch === "x64" ? "x86_64" : "arm64"] : [];
  const ugrepConfigureArgs = [
    // When Rosetta is built, config.guess still sees the arm64 runner and the x64 host must be explicitly declared to write the correct platform identity.
    ...(usesRosettaCrossBuild ? ["--host=x86_64-apple-darwin"] : []),
    ...(normalizedArch === "x64" ? ["--disable-avx2"] : []),
  ];

  return {
    platform: normalizedPlatform,
    arch: normalizedArch,
    cc: env.CC?.trim() || (normalizedPlatform === "darwin" ? "clang" : "gcc"),
    cxx: env.CXX?.trim() || (normalizedPlatform === "darwin" ? "clang++" : "g++"),
    ar: env.AR?.trim() || "ar",
    ranlib: env.RANLIB?.trim() || "ranlib",
    targetCompilerArgs,
    usesRosettaCrossBuild,
    macosDeploymentTarget:
      normalizedPlatform === "darwin" ? MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET : undefined,
    brotliOsDefine: normalizedPlatform === "darwin" ? "OS_MACOSX" : "OS_LINUX",
    bfsCppFlags: normalizedPlatform === "darwin" ? MACOS_BFS_CPP_FLAGS : [],
    // Linux executables link static PCRE2 with PIE; non-PIC archives fail at the final link stage.
    pcre2ConfigureArgs:
      normalizedPlatform === "linux" ? ["--enable-jit", "--with-pic"] : ["--disable-jit"],
    ugrepConfigureArgs,
    ugrepLdFlags: [
      "-Wl,-x",
      ...(normalizedPlatform === "linux" ? ["-static-libgcc", "-static-libstdc++"] : []),
    ],
  };
}

function buildOniguruma(sourcePath, prefix, jobs, env, quiet) {
  console.log("==> Build Oniguruma (static)");
  run("./configure", [`--prefix=${prefix}`, "--disable-shared", "--enable-static"], {
    cwd: sourcePath,
    env,
    quiet,
  });
  run("make", [`-j${jobs}`], { cwd: sourcePath, env, quiet });
  run("make", ["install"], { cwd: sourcePath, env, quiet });
}

function buildPcre2(sourcePath, prefix, jobs, env, quiet, config) {
  console.log(`==> Build PCRE2 ${config.platform === "linux" ? "with" : "without"} JIT (static)`);
  run(
    "./configure",
    [
      `--prefix=${prefix}`,
      "--disable-shared",
      "--enable-static",
      ...config.pcre2ConfigureArgs,
      "--disable-pcre2-16",
      "--disable-pcre2-32",
      "--disable-pcre2test-libreadline",
    ],
    { cwd: sourcePath, env, quiet },
  );
  run("make", [`-j${jobs}`], { cwd: sourcePath, env, quiet });
  run("make", ["install"], { cwd: sourcePath, env, quiet });
}

function buildZlib(sourcePath, prefix, jobs, env, quiet) {
  console.log("==> Build zlib (static)");
  run("./configure", ["--static", `--prefix=${prefix}`], {
    cwd: sourcePath,
    env,
    quiet,
  });
  run("make", [`-j${jobs}`], { cwd: sourcePath, env, quiet });
  run("make", ["install"], { cwd: sourcePath, env, quiet });
}

function buildBzip2(sourcePath, prefix, jobs, env, quiet, config) {
  console.log("==> Build bzip2 (static)");
  // The release sidecar does not carry debugging information to avoid DWARF recording random build directories.
  run(
    "make",
    [
      `-j${jobs}`,
      `CC=${config.cc}`,
      `AR=${config.ar}`,
      `RANLIB=${config.ranlib}`,
      `CFLAGS=${appendFlags("-Wall -Winline -O3 -D_FILE_OFFSET_BITS=64", config.targetCompilerArgs)}`,
    ],
    { cwd: sourcePath, env, quiet },
  );
  copyFileSync(join(sourcePath, "libbz2.a"), join(prefix, "lib", "libbz2.a"));
  copyFileSync(join(sourcePath, "bzlib.h"), join(prefix, "include", "bzlib.h"));
}

function buildZstd(sourcePath, prefix, jobs, env, quiet) {
  console.log("==> Build zstd (static)");
  run("make", ["-C", "lib", `-j${jobs}`, "libzstd.a-release"], {
    cwd: sourcePath,
    env,
    quiet,
  });
  run(
    "make",
    ["-C", "lib", `PREFIX=${prefix}`, "install-static", "install-includes", "install-pc"],
    { cwd: sourcePath, env, quiet },
  );
}

function compileBrotliLibrary({
  sourcePath,
  buildPath,
  sourceGroup,
  libraryPath,
  env,
  quiet,
  config,
}) {
  const sourceDir = join(sourcePath, "c", sourceGroup);
  const objectDir = join(buildPath, sourceGroup);
  mkdirSync(objectDir, { recursive: true });

  const objectPaths = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".c"))
    .sort()
    .map((name) => {
      const objectPath = join(objectDir, `${basename(name, ".c")}.o`);
      run(
        config.cc,
        [
          "-O3",
          "-DNDEBUG",
          "-fPIC",
          `-D${config.brotliOsDefine}`,
          "-DBROTLI_HAVE_LOG2=1",
          ...config.targetCompilerArgs,
          `-I${join(sourcePath, "c", "include")}`,
          "-c",
          join(sourceDir, name),
          "-o",
          objectPath,
        ],
        { env, quiet },
      );
      return objectPath;
    });

  run(config.ar, ["crs", libraryPath, ...objectPaths], { env, quiet });
}

function buildBrotli(sourcePath, prefix, workDir, env, quiet, config) {
  console.log("==> Build Brotli (static)");
  const buildPath = join(workDir, "brotli-build");
  const libraries = [
    ["common", "libbrotlicommon.a"],
    ["dec", "libbrotlidec.a"],
    ["enc", "libbrotlienc.a"],
  ];

  for (const [sourceGroup, libraryName] of libraries) {
    compileBrotliLibrary({
      sourcePath,
      buildPath,
      sourceGroup,
      libraryPath: join(prefix, "lib", libraryName),
      env,
      quiet,
      config,
    });
  }

  const includeSource = join(sourcePath, "c", "include", "brotli");
  const includeDestination = join(prefix, "include", "brotli");
  mkdirSync(includeDestination, { recursive: true });
  for (const name of readdirSync(includeSource).filter((entry) => entry.endsWith(".h"))) {
    copyFileSync(join(includeSource, name), join(includeDestination, name));
  }
}

export function createBfsBuildEnvironment({ sourcePath, prefix, env, config }) {
  const relativePrefix = relative(sourcePath, prefix) || ".";
  return {
    ...env,
    EXTRA_CPPFLAGS: [
      env.EXTRA_CPPFLAGS,
      ...config.bfsCppFlags,
      `-I${join(relativePrefix, "include")}`,
    ]
      .filter(Boolean)
      .join(" "),
    EXTRA_LDFLAGS: appendFlags(env.EXTRA_LDFLAGS, [`-L${join(relativePrefix, "lib")}`]),
    EXTRA_LDLIBS: appendFlags(env.EXTRA_LDLIBS, ["-lonig"]),
    // bfs will write the final flags into the version information; use explicit relative paths to avoid random working directories entering the product.
    PKG_CONFIG: "true",
    // CC fixes the release patch version through the build environment to avoid --version appearing in CONFFLAGS.
    VERSION: NATIVE_SEARCH_TOOL_VERSIONS.bfs,
  };
}

function buildBfs(sourcePath, prefix, jobs, env, quiet, runUpstreamTests, config) {
  console.log(`==> Build bfs ${NATIVE_SEARCH_TOOL_VERSIONS.bfs}`);
  const buildEnv = createBfsBuildEnvironment({ sourcePath, prefix, env, config });
  run("./configure", NATIVE_SEARCH_BFS_CONFIGURE_ARGS, { cwd: sourcePath, env: buildEnv, quiet });
  run("make", [`-j${jobs}`], { cwd: sourcePath, env: buildEnv, quiet });
  if (runUpstreamTests) {
    run("make", ["unit-tests"], { cwd: sourcePath, env: buildEnv, quiet });
  }
  return join(sourcePath, "bin", "bfs");
}

function buildUgrep(sourcePath, prefix, jobs, env, quiet, runUpstreamTests, config) {
  console.log(`==> Build ugrep ${NATIVE_SEARCH_TOOL_VERSIONS.ugrep}`);
  const buildEnv = {
    ...env,
    CFLAGS: appendFlags("-O3 -DNDEBUG", config.targetCompilerArgs),
    CXXFLAGS: appendFlags("-O3 -DNDEBUG", config.targetCompilerArgs),
    CPPFLAGS: `-I${join(prefix, "include")}`,
    LDFLAGS: [
      ...config.targetCompilerArgs,
      `-L${join(prefix, "lib")}`,
      ...config.ugrepLdFlags,
    ].join(" "),
    LIBS: "-lbrotlicommon",
  };
  run(
    "./configure",
    [
      "--disable-dependency-tracking",
      ...config.ugrepConfigureArgs,
      `--with-pcre2=${prefix}`,
      `--with-zlib=${prefix}`,
      `--with-bzlib=${prefix}`,
      "--without-lzma",
      "--without-lz4",
      `--with-zstd=${prefix}`,
      `--with-brotli=${prefix}`,
      "--without-bzip3",
    ],
    { cwd: sourcePath, env: buildEnv, quiet },
  );
  run("make", [`-j${jobs}`], { cwd: sourcePath, env: buildEnv, quiet });
  if (runUpstreamTests) {
    run("make", ["test"], { cwd: sourcePath, env: buildEnv, quiet });
  }
  return join(sourcePath, "src", "ugrep");
}

export function buildNativeSearchToolsUnix({
  platform = process.platform,
  arch = process.arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  outputDir,
  jobs = Math.max(1, Math.min(cpus().length, 8)),
  keepWorkdir = false,
  quiet = false,
  runUpstreamTests = false,
  processEnv = process.env,
} = {}) {
  const config = resolveNativeUnixBuildConfig({
    platform,
    arch,
    hostPlatform,
    hostArch,
    env: processEnv,
  });
  const plan = resolveNativeSearchBuildPlan({
    platform: config.platform,
    arch: config.arch,
    outputDir,
  });
  if (config.platform === "linux") {
    // Only relying on the final binary smoke will make the higher version runner produce GLIBC_2.34/2.36
    // Fixed release entered by mistake. Before downloading the source code, lock the producer environment first, and then review it with the readelf gate during the production stage.
    verifyLinuxNativeSearchBuildEnvironment(config);
  }
  const workDir = mkdtempSync(join(tmpdir(), "zcode-native-search-build-"));
  const prefix = join(workDir, "prefix");
  const env = {
    ...processEnv,
    AR: config.ar,
    CFLAGS: appendFlags(processEnv.CFLAGS, config.targetCompilerArgs),
    CC: config.cc,
    CXXFLAGS: appendFlags(processEnv.CXXFLAGS, config.targetCompilerArgs),
    CXX: config.cxx,
    LANG: "C",
    LDFLAGS: appendFlags(processEnv.LDFLAGS, config.targetCompilerArgs),
    LC_ALL: "C",
    ...(config.macosDeploymentTarget
      ? { MACOSX_DEPLOYMENT_TARGET: config.macosDeploymentTarget }
      : {}),
    RANLIB: config.ranlib,
  };
  mkdirSync(join(prefix, "include"), { recursive: true });
  mkdirSync(join(prefix, "lib", "pkgconfig"), { recursive: true });

  console.log("==> ZCode native search build");
  console.log(`    target:  ${plan.platformKey}`);
  console.log(`    output:  ${plan.outputDir}`);
  console.log(`    workdir: ${workDir}`);

  try {
    const sources = downloadAndExtractSources({
      sources: getNativeSearchSourceArchivesForTarget({
        platform: plan.platform,
        arch: plan.arch,
      }),
      workDir,
      env,
      quiet,
    });
    buildOniguruma(sources.oniguruma, prefix, jobs, env, quiet);
    buildPcre2(sources.pcre2, prefix, jobs, env, quiet, config);
    buildZlib(sources.zlib, prefix, jobs, env, quiet);
    buildBzip2(sources.bzip2, prefix, jobs, env, quiet, config);
    buildZstd(sources.zstd, prefix, jobs, env, quiet);
    buildBrotli(sources.brotli, prefix, workDir, env, quiet, config);

    const builtBfsPath = buildBfs(sources.bfs, prefix, jobs, env, quiet, runUpstreamTests, config);
    const builtUgrepPath = buildUgrep(
      sources.ugrep,
      prefix,
      jobs,
      env,
      quiet,
      runUpstreamTests,
      config,
    );
    verifyBuiltNativeSearchProducerOutputs({
      bfsPath: builtBfsPath,
      ugrepPath: builtUgrepPath,
      platform: plan.platform,
      arch: plan.arch,
      producerOutputIds: plan.producerOutputIds,
    });

    mkdirSync(dirname(plan.bfsPath), { recursive: true });
    mkdirSync(dirname(plan.ugrepPath), { recursive: true });
    copyFileSync(builtBfsPath, plan.bfsPath);
    copyFileSync(builtUgrepPath, plan.ugrepPath);
    chmodSync(plan.bfsPath, 0o755);
    chmodSync(plan.ugrepPath, 0o755);
    verifyBuiltNativeSearchProducerOutputs({
      bfsPath: plan.bfsPath,
      ugrepPath: plan.ugrepPath,
      platform: plan.platform,
      arch: plan.arch,
      producerOutputIds: plan.producerOutputIds,
    });
    console.log(`==> Built ${plan.bfsPath}`);
    console.log(`==> Built ${plan.ugrepPath}`);
    return plan;
  } finally {
    if (keepWorkdir) {
      console.log(`==> Preserved workdir ${workDir}`);
    } else {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
