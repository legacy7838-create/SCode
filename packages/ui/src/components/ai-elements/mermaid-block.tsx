"use client";

import { createMermaidPlugin, type MermaidConfig } from "@streamdown/mermaid";
import { Loader2Icon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";

type MermaidRenderState =
  | {
      status: "loading";
    }
  | {
      status: "ready";
      svg: string;
    }
  | {
      status: "plaintext";
    };

export interface MermaidBlockProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  /**
   * Application topic (store coupling stripping): passed in from the upper state by the caller.
   * The default "system" follows the operating system and is used for old call points/code to be deleted.
   */
  theme?: Theme;
  onOpenPreview?: () => void;
  onPreviewSvgChange?: (svg: string | null) => void;
}

const mermaidPlugin = createMermaidPlugin();
let mermaidRenderQueue = Promise.resolve();
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

// Mermaid's underlying khroma parser does not support the common oklab/color-mix results of Tailwind v4.
// Let the browser parse the theme token first, and then sample it into traditional rgb/rgba through canvas to avoid passing modern CSS colors directly to Mermaid.
// The startup test of Web remote control only provides a minimal document mock, and the SSR/pre-rendering environment may not have a DOM factory;
// Color normalization is an enhancement that does not allow static imports of MessageResponse to crash directly in these environments.
const canCreateDomElements =
  typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }

  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) {
      return fallback;
    }

    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    // If canvas does not support this color format, fillStyle will stop at the sentinel color and fall back directly to the safe color that Mermaid can parse.
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }

    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  return normalizeCssColorForMermaid(color, fallback);
}

function createMermaidConfig(resolvedTheme: "light" | "dark"): MermaidConfig {
  const background = resolveCssColor(
    "--color-card",
    resolvedTheme === "dark" ? "#18181b" : "#ffffff",
  );
  const surface = resolveCssColor(
    "--color-surface",
    resolvedTheme === "dark" ? "#27272a" : "#f4f4f5",
  );
  const accent = resolveCssColor(
    "--color-accent",
    resolvedTheme === "dark" ? "#1f2937" : "#f0f9ff",
  );
  const text = resolveCssColor(
    "--color-foreground",
    resolvedTheme === "dark" ? "#f4f4f5" : "#27272a",
  );
  const subtleText = resolveCssColor(
    "--color-foreground-subtle",
    resolvedTheme === "dark" ? "#a1a1aa" : "#52525b",
  );
  const border = resolveCssColor(
    "--color-border",
    resolvedTheme === "dark" ? "#3f3f46" : "#d4d4d8",
  );

  return {
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  };
}

function resolveBrowserTheme(theme: Theme): "light" | "dark" {
  if (typeof window === "undefined") {
    return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
  }

  return resolveTheme(theme);
}

function useSystemThemeRevision(theme: Theme): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setRevision((current) => current + 1);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme]);

  return revision;
}

function normalizeMermaidRenderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MermaidBlock({
  code,
  className,
  theme = "system",
  onOpenPreview,
  onPreviewSvgChange,
  ...props
}: MermaidBlockProps) {
  const { intl } = useZCodeIntl();
  const systemThemeRevision = useSystemThemeRevision(theme);
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const trimmedCode = code.trim();
  const resolvedTheme = resolveBrowserTheme(theme);
  const themeKey = `${theme}:${resolvedTheme}:${systemThemeRevision}`;
  const mermaidConfig = useMemo(
    () => createMermaidConfig(resolvedTheme),
    [resolvedTheme, themeKey],
  );
  const renderKey = useMemo(
    () => `${themeKey}:${hashMermaidCode(trimmedCode)}`,
    [themeKey, trimmedCode],
  );
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;

    if (!trimmedCode) {
      setRenderState({
        status: "plaintext",
      });
      onPreviewSvgChange?.(null);
      return;
    }

    setRenderState({ status: "loading" });
    onPreviewSvgChange?.(null);
    const renderId = `zcode-mermaid-${renderIdPrefix}-${hashMermaidCode(renderKey)}`;

    void enqueueMermaidRender(async () => {
      const renderer = mermaidPlugin.getMermaid(mermaidConfig);
      return renderer.render(renderId, trimmedCode);
    })
      .then(({ svg }) => {
        if (!cancelled) {
          setRenderState({ status: "ready", svg });
          onPreviewSvgChange?.(svg);
        }
      })
      .catch((error: unknown) => {
        const message = normalizeMermaidRenderError(error);
        logger.debug("[MermaidBlock] mermaid render failed", {
          error: message,
          codeLength: trimmedCode.length,
        });
        if (!cancelled) {
          // Mermaid parsing failures are common when model streaming output is incomplete or the user has pasted non-standard syntax.
          // Returning to plain text keeps the content readable and avoids interrupting chat reading with error panels.
          setRenderState({ status: "plaintext" });
          onPreviewSvgChange?.(null);
        }
      });

    return () => {
      cancelled = true;
      onPreviewSvgChange?.(null);
    };
  }, [intl, mermaidConfig, onPreviewSvgChange, renderIdPrefix, renderKey, trimmedCode]);

  return (
    <div
      className={cn("group/mermaid relative min-h-32 w-full bg-card", className)}
      data-mermaid-block=""
      {...props}
    >
      <div className="max-h-[420px] overflow-auto p-3 text-foreground">
        {renderState.status === "loading" ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-foreground-subtle text-ui-base">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "codeBlock.mermaid.loading" })}</span>
          </div>
        ) : null}
        {renderState.status === "plaintext" ? (
          <pre className="m-0 min-h-28 min-w-max bg-transparent font-mono text-foreground text-ui-base leading-relaxed">
            {code}
          </pre>
        ) : null}
        {renderState.status === "ready" ? (
          <div
            aria-label={intl.formatMessage({ id: "codeBlock.mermaid.ariaLabel" })}
            className="flex min-h-28 min-w-max items-center justify-center [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
            onDoubleClick={onOpenPreview}
            role="img"
          />
        ) : null}
      </div>
    </div>
  );
}
