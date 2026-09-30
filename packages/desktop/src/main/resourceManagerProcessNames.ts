import { BrowserWindow } from "electron";
import type { WebContents } from "electron";
import { basename } from "node:path";
import { formatZCodeRendererProcessName } from "@zcode/shared";

/** Display name of non-BrowserWindow built-in renderer (WebContentsView / DevTools / webview) in the resource manager */

function normalizeProcessLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pickUrlLabel(url: string | null | undefined): string | null {
  const normalizedUrl = normalizeProcessLabel(url);
  if (!normalizedUrl) return null;

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol === "devtools:") {
      return "devtools";
    }

    if (parsed.protocol === "file:") {
      const fileName = basename(parsed.pathname);
      return normalizeProcessLabel(fileName) ?? "file";
    }

    return normalizeProcessLabel(parsed.hostname) ?? normalizeProcessLabel(parsed.protocol);
  } catch {
    return null;
  }
}

function pickWindowLabel(win: BrowserWindow | null): string | null {
  if (!win || win.isDestroyed()) return null;
  return normalizeProcessLabel(win.getTitle()) ?? `window-${win.id}`;
}

export function buildAuxiliaryRendererName(contents: WebContents): string {
  const type = contents.getType();
  const contentsId = contents.id;
  const title = normalizeProcessLabel(contents.getTitle());
  const url = normalizeProcessLabel(contents.getURL());
  const ownerWindow = BrowserWindow.fromWebContents(contents);
  const ownerLabel = pickWindowLabel(ownerWindow);
  const hostContents = contents.hostWebContents;
  const hostTitle = normalizeProcessLabel(hostContents?.getTitle());
  const hostUrlLabel = pickUrlLabel(hostContents?.getURL());
  const pageLabel =
    title ?? pickUrlLabel(url) ?? ownerLabel ?? hostTitle ?? hostUrlLabel ?? `wc-${contentsId}`;

  // Encode the WebContents meta information known to Electron into the name, and you can directly see the type and attribution clues when troubleshooting PID.
  if (url?.startsWith("devtools://")) {
    return formatZCodeRendererProcessName(
      `devtools-${contentsId}-${hostTitle ?? ownerLabel ?? "unknown"}`,
    );
  }

  if (type === "window") {
    return formatZCodeRendererProcessName(title ?? `window-${contentsId}`);
  }

  return formatZCodeRendererProcessName(`${type}-${contentsId}-${pageLabel}`);
}
