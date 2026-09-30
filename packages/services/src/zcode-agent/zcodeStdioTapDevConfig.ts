import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ZCodeStdioTapDevState } from "@zcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface ZCodeStdioTapStateFile {
  enabled?: boolean;
}

function isZCodeStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

function getZCodeStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getZCodeStdioTapDevLogDir(): string {
  return join(getZCodeStdioTapDevDir(), "stdio-traffic");
}

function getZCodeStdioTapDevStatePath(): string {
  return join(getZCodeStdioTapDevDir(), "zcode-stdio-tap.json");
}

function readStateFile(path: string): ZCodeStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ZCodeStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readZCodeStdioTapDevState(): ZCodeStdioTapDevState {
  const visible = isZCodeStdioTapDevVisible();
  const statePath = getZCodeStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getZCodeStdioTapDevLogDir(),
    statePath,
  };
}

export function setZCodeStdioTapDevEnabled(enabled: boolean): ZCodeStdioTapDevState {
  const visible = isZCodeStdioTapDevVisible();
  const statePath = getZCodeStdioTapDevStatePath();
  mkdirSync(getZCodeStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // The development stdio packet capture is a high-frequency original protocol frame, and the bypass file can only be written through an explicit switch to avoid accidentally entering the production log.
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readZCodeStdioTapDevState();
}
