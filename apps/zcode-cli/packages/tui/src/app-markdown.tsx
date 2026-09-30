import { baseComponents } from "@mbears/opentui-react";
import React from "react";
import {
  createMarkdownParseSession,
  type MarkdownParseState,
} from "@zcode/rust/markdown";
import { createMarkdownSyntaxStyle } from "./app-markdown-theme.js";
import { activeTuiTheme } from "./theme/index.js";

type MarkdownRenderMode = "markdown" | "code" | "plain";

type MarkdownTextProps = {
  backgroundColor?: string;
  content: string;
  foregroundColor?: string;
  mode?: MarkdownRenderMode;
  streaming?: boolean;
};

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

function detectMarkdownRenderMode(
  components: Record<string, unknown> = baseComponents,
): MarkdownRenderMode {
  if (typeof components.markdown === "function") return "markdown";
  if (typeof components.code === "function") return "code";
  return "plain";
}

/**
 * Native parse session for one markdown element. The four rules below are the
 * integration contract from docs/specs/rust-native-markdown.md:
 * 1. Mount — the markdown element mounts with `content: ""` and fills after
 *    the first parse resolves (no constructor JS lex).
 * 2. Seed order — `_parseState` precedes `content` in the props object
 *    (prop application is insertion-ordered).
 * 3. Streaming — the renderable's `streaming` prop is never true; the caller
 *    flag only selects the native `trailingUnstable` (2 while streaming, 0
 *    after).
 * 4. Skip — no native call when the content string is unchanged (finalize
 *    flip causes zero work).
 */
function NativeMarkdown({
  content,
  streaming,
  syntaxStyle,
}: {
  content: string;
  streaming: boolean;
  syntaxStyle: unknown;
}): React.ReactElement {
  const sessionRef = useRef<ReturnType<
    typeof createMarkdownParseSession
  > | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = createMarkdownParseSession();
  }
  const session = sessionRef.current;

  const [state, setState] = useState<MarkdownParseState | null>(null);
  const parsedContentRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  // Unmount guard: a parse resolving after unmount is discarded.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    // Skip rule: unchanged content (e.g. the streaming→false finalize flip)
    // makes no native call and no prop changes.
    if (parsedContentRef.current === content) {
      return;
    }
    parsedContentRef.current = content;
    void session.update(content, streaming ? 2 : 0).then((next) => {
      // Drop guard: apply a result only when it still matches the newest
      // content the component intends to render — a finalize flip
      // (streaming→false, same content) must not discard the parse that is
      // already in flight for that content.
      if (mountedRef.current && parsedContentRef.current === next.content) {
        setState(next);
      }
    });
  }, [content, streaming, session]);

  return h("markdown", {
    conceal: true,
    _parseState: state,
    content: state ? state.content : "",
    syntaxStyle,
  });
}

// Local React hooks alias (kept next to `h` for the untyped-props pattern).
const useRef = React.useRef;
const useState = React.useState;
const useEffect = React.useEffect;

export function MarkdownText({
  content,
  foregroundColor,
  mode = detectMarkdownRenderMode(),
  streaming = false,
}: MarkdownTextProps): React.ReactElement {
  const theme = activeTuiTheme();
  const textColor = foregroundColor ?? theme.markdownText;
  const syntaxStyle = createMarkdownSyntaxStyle(theme);

  // Markdown mode always renders the markdown element (mount rule): the
  // empty-content `h("text")` shortcut does not apply here.
  if (mode === "markdown" && syntaxStyle) {
    return h(NativeMarkdown, { content, streaming, syntaxStyle });
  }
  if (!content) {
    return h("text", { style: { fg: textColor } }, "");
  }

  if (mode === "code" && syntaxStyle) {
    return h("code", {
      conceal: true,
      content,
      drawUnstyledText: false,
      fg: textColor,
      filetype: "markdown",
      streaming,
      syntaxStyle,
    });
  }

  return h("text", { style: { fg: textColor } }, content);
}
