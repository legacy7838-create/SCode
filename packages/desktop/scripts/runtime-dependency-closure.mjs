import { existsSync, readFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { createRequire } from "node:module";

function findPackageRoot(entryPath) {
  let currentDir = dirname(entryPath);
  const root = parse(currentDir).root;
  while (currentDir !== root) {
    const packageJsonPath = resolve(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }
  return null;
}

function readRuntimePackage(moduleLookupRoots, moduleName, parentPackagePath = null) {
  if (parentPackagePath) {
    try {
      const requireFromParent = createRequire(parentPackagePath);
      const entryPath = requireFromParent.resolve(moduleName);
      const packageRoot = findPackageRoot(entryPath);
      if (packageRoot) {
        const packageJsonPath = resolve(packageRoot, "package.json");
        return {
          packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")),
          packageJsonPath,
          packageRoot,
        };
      }
    } catch {
      // When the relative resolution of the parent package fails, continue to go through the workspace lookup roots.
    }
  }

  for (const lookupRoot of moduleLookupRoots) {
    const packageJsonPath = resolve(lookupRoot, "node_modules", moduleName, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    return {
      packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")),
      packageJsonPath,
      packageRoot: dirname(packageJsonPath),
    };
  }
  return null;
}

export function collectRuntimeModuleClosure(moduleNames, moduleLookupRoots) {
  return collectRuntimeModuleClosureEntries(moduleNames, moduleLookupRoots).map(
    (entry) => entry.moduleName,
  );
}

export function collectRuntimeModuleClosureEntries(moduleNames, moduleLookupRoots) {
  const collected = [];
  const visited = new Set();

  function visit(moduleName, optional = false, parentPackagePath = null) {
    if (visited.has(moduleName)) {
      return;
    }

    const runtimePackage = readRuntimePackage(moduleLookupRoots, moduleName, parentPackagePath);
    if (!runtimePackage && optional) {
      return;
    }

    visited.add(moduleName);
    collected.push({
      moduleName,
      sourceModulePath: runtimePackage?.packageRoot ?? null,
      packageJsonPath: runtimePackage?.packageJsonPath ?? null,
    });

    if (!runtimePackage) {
      return;
    }

    const { packageJson, packageJsonPath } = runtimePackage;
    const dependencies = packageJson.dependencies ?? {};
    const optionalDependencies = packageJson.optionalDependencies ?? {};
    const dependencyEntries = [
      ...Object.keys(dependencies).map((dependencyName) => [dependencyName, false]),
      ...Object.keys(optionalDependencies).map((dependencyName) => [dependencyName, true]),
    ];

    for (const [dependencyName, isOptional] of dependencyEntries.sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      // When the runtime external package is included in app.asar, its hoisted sub-dependencies will not be automatically included in the package.
      // Collect dependencies recursively, allowing packaging injection and product verification to cover the complete runtime resolution chain.
      // When pnpm has multi-version dependencies with the same name, the first directory cannot be taken from the fixed lookup roots at each layer.
      // For example, yazl requires buffer-crc32@1.x, and the desktop test dependency also has 0.2.x;
      // It must be relatively resolved from the parent package's package.json to copy to the version that will be loaded by the real runtime.
      visit(dependencyName, isOptional, packageJsonPath);
    }
  }

  for (const moduleName of moduleNames) {
    visit(moduleName);
  }

  return collected;
}
