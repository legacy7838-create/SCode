import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getPatchPreviewLineContent,
  parseTruncatedMarkerOmittedLineCount,
} from "@/lib/patchDiffPreview.js";
import type { CodePreviewSettings } from "@/store/index.js";

export type LightweightDiffLineKind = "added" | "removed" | "context";

export interface LightweightDiffLineParts {
  content: string;
  kind: LightweightDiffLineKind;
  marker: string;
  raw: string;
}

type LightweightDiffLineStyles = {
  gutterStyle?: CSSProperties;
  lineNumberClassName: string;
  rowStyle?: CSSProperties;
};

export interface LightweightDiffPreviewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  codePreviewSettings: Pick<
    CodePreviewSettings,
    "fontSizePx" | "showLineNumbers" | "wrapLongLines"
  >;
  lines: readonly string[];
  renderLineContent?: (line: LightweightDiffLineParts, index: number) => ReactNode;
}

export function getLightweightDiffLineParts(line: string): LightweightDiffLineParts {
  if (line.startsWith("+")) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: "added",
      marker: "+",
      raw: line,
    };
  }

  if (line.startsWith("-")) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: "removed",
      marker: "-",
      raw: line,
    };
  }

  if (line.startsWith(" ")) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: "context",
      marker: " ",
      raw: line,
    };
  }

  return {
    content: getPatchPreviewLineContent(line),
    kind: "context",
    marker: "",
    raw: line,
  };
}

function getLightweightDiffLineStyles(kind: LightweightDiffLineKind): LightweightDiffLineStyles {
  if (kind === "added") {
    return {
      lineNumberClassName: "text-diff-added",
      rowStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-added) 14%, transparent)",
        boxShadow: "inset 3px 0 0 var(--color-diff-added)",
      },
      gutterStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-added) 18%, var(--color-background))",
        boxShadow: "inset 3px 0 0 var(--color-diff-added)",
        color: "var(--color-diff-added)",
      },
    };
  }

  if (kind === "removed") {
    return {
      lineNumberClassName: "text-diff-removed",
      rowStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-removed) 14%, transparent)",
        boxShadow: "inset 3px 0 0 var(--color-diff-removed)",
      },
      gutterStyle: {
        backgroundColor:
          "color-mix(in srgb, var(--color-diff-removed) 18%, var(--color-background))",
        boxShadow: "inset 3px 0 0 var(--color-diff-removed)",
        color: "var(--color-diff-removed)",
      },
    };
  }

  return {
    lineNumberClassName: "text-foreground-subtlest",
    gutterStyle: {
      backgroundColor: "var(--color-background)",
    },
  };
}

export function LightweightDiffPreview({
  className,
  codePreviewSettings,
  lines,
  renderLineContent,
  ...props
}: LightweightDiffPreviewProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      className={cn("w-full min-w-0 overflow-auto bg-background", className)}
      data-lightweight-diff-preview
      {...props}
    >
      <div
        className={cn(
          "min-w-full font-mono leading-relaxed text-foreground",
          !codePreviewSettings.wrapLongLines && "w-max",
        )}
        data-lightweight-diff-scroll-content
        style={{ fontSize: codePreviewSettings.fontSizePx }}
      >
        {lines.map((line, index) => {
          const omittedLineCount = parseTruncatedMarkerOmittedLineCount(line);

          if (omittedLineCount !== null) {
            return (
              <div className="px-3 py-1 text-foreground-subtle" key={index}>
                {intl.formatMessage(
                  { id: "diff.preview.truncatedLines" },
                  { count: String(omittedLineCount) },
                )}
              </div>
            );
          }

          const lineParts = getLightweightDiffLineParts(line);
          const lineStyles = getLightweightDiffLineStyles(lineParts.kind);

          return (
            <div className="flex min-w-full w-full" key={index} style={lineStyles.rowStyle}>
              {/* When there is no line wrapping, the max-content width is calculated uniformly by the inner scroll surface.
              If each row has its own w-max, the short row background will end early when scrolling horizontally to the right, resulting in a black gap. */}
              {codePreviewSettings.showLineNumbers ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "sticky left-0 z-[1] w-12 shrink-0 select-none border-r border-border px-2 text-right tabular-nums",
                    lineStyles.lineNumberClassName,
                  )}
                  style={lineStyles.gutterStyle}
                >
                  {index + 1}
                </span>
              ) : null}
              <code
                className={cn(
                  "block flex-1 px-3",
                  codePreviewSettings.wrapLongLines
                    ? "whitespace-pre-wrap break-words"
                    : "whitespace-pre",
                )}
              >
                {/* Lightweight diff only uses line background, status bar and line number colors to express additions and deletions, which is consistent with rich DiffViewer;
                The `+/-/space` protocol marker of unified diff cannot be displayed as code content. */}
                {renderLineContent?.(lineParts, index) ?? (lineParts.content || " ")}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
