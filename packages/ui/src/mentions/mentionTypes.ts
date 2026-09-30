export type MentionCategory =
  | "files"
  | "skills"
  | "commands"
  | "subagents"
  | "whiteboards"
  | "sessions"
  | "plugins";

export interface MentionItemData {
  kind?: "file" | "directory" | "whiteboard";
  path?: string;
  relativePath?: string;
  boardId?: string;
  scope?: "built-in" | "workspace" | "user" | "plugin";
  source?: "built-in" | "user" | "plugin";
  model?: string;
  /** The stable identity (`name@marketplace`) referenced by the Plugin, the canonical link target; the label does not participate in the identity. */
  pluginId?: string;
  /** Plugin store listing original icon; only used for UI, must be loaded after HTTPS verification. */
  icon?: string;
}

export interface MentionItem {
  id: string;
  category: MentionCategory;
  label: string;
  description: string;
  value: string;
  markdown: string;
  keywords?: string[];
  data?: MentionItemData;
  /**
   * A localized display name for panel rendering only (such as the displayName of Plugin listing).
   * `label` is the label of panel copy and chip/markdown carrier at the same time. Direct localization of `label` will make
   * The display of composer chip and message bubble (rebuilt according to markdown label) are inconsistent; the panel display name uses this field separately.
   */
  displayLabel?: string;
  /** Disabled state (V1 Plugin conflict with the same name fail closed): The panel is visible but cannot be selected. */
  disabled?: boolean;
  /** The reason for the ban is displayed in the weak information bit on the right side of the candidate row. */
  disabledReason?: string;
}

export interface MentionCategoryResult {
  items: MentionItem[];
  loading: boolean;
  error: Error | null;
  emptyText: string;
  title: string;
  refresh?: () => Promise<void>;
}
