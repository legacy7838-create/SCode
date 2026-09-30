import {
  DOCUMENT_FILE_ICON_SRC,
  FOLDER_FILE_ICON_SRC,
  INLINE_FALLBACK_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";
import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";
import {
  COMMAND_MENTION_ICON_NODE,
  COMPACT_COMMAND_MENTION_ICON_NODE,
  createMentionSvgIcon,
  GOAL_COMMAND_MENTION_ICON_NODE,
  PLUGIN_MENTION_ICON_NODE,
  SESSION_MENTION_ICON_NODE,
  SKILL_MENTION_ICON_NODE,
  SUBAGENT_MENTION_ICON_NODE,
  WHITEBOARD_MENTION_ICON_NODE,
  WORKFLOW_COMMAND_MENTION_ICON_NODE,
  type MentionLucideIconNode,
} from "@/mentions/nodes/mentionIconDom.js";

const pendingImages = new WeakMap<HTMLElement, HTMLImageElement>();

function cssUrl(url: string): string {
  // Relative URLs in CSS will be parsed according to the style sheet path; they will be parsed according to the document baseURI, which is consistent with the original img.src.
  return `url(${JSON.stringify(new URL(url, document.baseURI).href)})`;
}

function setMask(dom: HTMLElement, icon: MentionLucideIconNode) {
  const svg = createMentionSvgIcon(icon);
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  dom.style.removeProperty("--mention-image");
  dom.style.setProperty(
    "--mention-mask",
    cssUrl(`data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}`),
  );
  dom.style.setProperty("--mention-icon-color", "currentColor");
}

function setImage(dom: HTMLElement, url: string, fallback: () => void) {
  dom.style.removeProperty("--mention-mask");
  dom.style.removeProperty("--mention-icon-color");
  dom.style.setProperty("--mention-image", cssUrl(url));
  const image = new Image();
  pendingImages.set(dom, image);
  // Root cause: The icon error callback is past replaceChildren, and the text node may be destroyed after the user selection is established.
  // Icons only update decoration variables, and callbacks from old requests must not overwrite new node state.
  image.onerror = () => {
    if (pendingImages.get(dom) !== image) return;
    pendingImages.delete(dom);
    fallback();
  };
  image.onload = () => {
    if (pendingImages.get(dom) === image) pendingImages.delete(dom);
  };
  image.src = url;
}

export function decoratePromptMention(
  dom: HTMLElement,
  category: MentionCategory,
  value: string,
  data?: MentionItemData,
) {
  pendingImages.delete(dom);
  if (category === "plugins") {
    const fallback = () => setMask(dom, PLUGIN_MENTION_ICON_NODE);
    const icon = resolvePluginIconSource(value, data?.icon);
    if (icon) setImage(dom, icon, fallback);
    else fallback();
    return;
  }
  if (category === "files") {
    const descriptor = resolveFileDisplayDescriptor(data?.path ?? data?.relativePath ?? value);
    const url = data?.kind === "directory" ? FOLDER_FILE_ICON_SRC : descriptor.fileIconSrc;
    setImage(dom, url, () =>
      setImage(dom, DOCUMENT_FILE_ICON_SRC, () => {
        dom.style.setProperty("--mention-image", cssUrl(INLINE_FALLBACK_FILE_ICON_SRC));
      }),
    );
    return;
  }
  const command = value.trim().replace(/^\/+/, "");
  const icon =
    category === "skills"
      ? SKILL_MENTION_ICON_NODE
      : category === "subagents"
        ? SUBAGENT_MENTION_ICON_NODE
        : category === "sessions"
          ? SESSION_MENTION_ICON_NODE
          : category === "whiteboards"
            ? WHITEBOARD_MENTION_ICON_NODE
            : command === "goal"
              ? GOAL_COMMAND_MENTION_ICON_NODE
              : command === "workflow"
                ? WORKFLOW_COMMAND_MENTION_ICON_NODE
                : command === "compact"
                  ? COMPACT_COMMAND_MENTION_ICON_NODE
                  : COMMAND_MENTION_ICON_NODE;
  setMask(dom, icon);
}
