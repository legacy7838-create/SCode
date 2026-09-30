export type QuickPickCommandIcon =
  | "book"
  | "browser"
  | "community"
  | "diff"
  | "feedback"
  | "folder"
  | "login"
  | "logout"
  | "message"
  | "mcp"
  | "settings"
  | "sidebarClose"
  | "sidebarOpen"
  | "skills"
  | "themeDark"
  | "themeLight"
  | "terminal";

export type QuickPickCommandSectionId =
  | "suggested"
  | "chat"
  | "navigation"
  | "panels"
  | "configure"
  | "app";

export const QUICK_PICK_SECTION_ORDER: QuickPickCommandSectionId[] = [
  "suggested",
  "chat",
  "navigation",
  "panels",
  "configure",
  "app",
];

export interface QuickPickCommand {
  id: string;
  sectionId: QuickPickCommandSectionId;
  titleId: string;
  icon: QuickPickCommandIcon;
  shortcut?: string;
  keywords: string[];
  disabled?: boolean;
  run: () => void | Promise<void>;
}

interface QuickPickCommandHandlers {
  createTask: () => void;
  openWorkspace: () => void;
  openSettings: () => void;
  openSkillsSettings: () => void;
  openMcpSettings: () => void;
  switchTheme: () => void;
  openFeedback: () => void | Promise<void>;
  openCommunity: () => void | Promise<void>;
  openProductDocs: () => void | Promise<void>;
  login?: () => void | Promise<void>;
  logout?: () => void | Promise<void>;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  togglePreview: () => void;
  openTerminalTab: () => void;
  openBrowserTab: () => void;
  openReviewTab: () => void;
}

interface CreateQuickPickCommandsOptions {
  allowOpenWorkspace: boolean;
  canOpenCommunity: boolean;
  isSidebarVisible: boolean;
  isLoggedIn: boolean;
  supportsEmbeddedBrowser?: boolean;
  supportsTerminal?: boolean;
  supportsReview?: boolean;
  themeTarget: "dark" | "light";
  shortcuts: {
    newTask: string;
    openWorkspace: string;
    toggleSidebar: string;
    toggleTerminal: string;
  };
  handlers: QuickPickCommandHandlers;
}

export function createQuickPickCommands({
  allowOpenWorkspace,
  canOpenCommunity,
  isSidebarVisible,
  isLoggedIn,
  supportsEmbeddedBrowser = true,
  supportsTerminal = true,
  supportsReview = true,
  themeTarget,
  shortcuts,
  handlers,
}: CreateQuickPickCommandsOptions): QuickPickCommand[] {
  const commands: QuickPickCommand[] = [
    {
      id: "new-task",
      sectionId: "suggested",
      titleId: "quickPick.command.newTask",
      icon: "message",
      shortcut: shortcuts.newTask,
      keywords: ["new", "task", "Task", "new tasks", "Create new task"],
      run: handlers.createTask,
    },
    {
      id: "open-workspace",
      sectionId: "suggested",
      titleId: "quickPick.command.openWorkspace",
      icon: "folder",
      shortcut: shortcuts.openWorkspace,
      keywords: ["open", "workspace", "folder", "project", "open", "folder", "Project"],
      disabled: !allowOpenWorkspace,
      run: handlers.openWorkspace,
    },
    {
      id: "suggested-settings",
      sectionId: "suggested",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "Configuration", "settings"],
      run: handlers.openSettings,
    },
    {
      id: "toggle-sidebar",
      sectionId: "panels",
      titleId: "quickPick.command.toggleSidebar",
      icon: isSidebarVisible ? "sidebarClose" : "sidebarOpen",
      shortcut: shortcuts.toggleSidebar,
      keywords: [
        "sidebar",
        "left sidebar",
        "toggle sidebar",
        "sidebar",
        "sidebar",
        "Toggle sidebar",
      ],
      run: handlers.toggleSidebar,
    },
    {
      id: "toggle-terminal",
      sectionId: "panels",
      titleId: "quickPick.command.toggleTerminal",
      icon: "terminal",
      shortcut: shortcuts.toggleTerminal,
      keywords: ["terminal", "shell", "console", "terminal"],
      run: handlers.toggleTerminal,
    },
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "toggle-preview",
            sectionId: "panels",
            titleId: "quickPick.command.togglePreview",
            icon: "browser",
            keywords: [
              "preview",
              "browser",
              "web",
              "show",
              "hide",
              "Preview",
              "Browser",
              "web page",
              "show",
              "hide",
            ],
            run: handlers.togglePreview,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      id: "add-terminal-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addTerminalTab",
      icon: "terminal",
      keywords: ["add", "terminal", "tab", "new terminal", "add terminal", "terminal label"],
      run: handlers.openTerminalTab,
    },
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "add-browser-tab",
            sectionId: "panels",
            titleId: "quickPick.command.addBrowserTab",
            icon: "browser",
            keywords: ["add", "browser", "tab", "preview", "Add browser", "browser tab"],
            run: handlers.openBrowserTab,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      id: "add-review-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addReviewTab",
      icon: "diff",
      keywords: ["add", "review", "diff", "changes", "add review", "censorship tag", "change"],
      run: handlers.openReviewTab,
    },
    {
      id: "settings",
      sectionId: "configure",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "Configuration", "settings"],
      run: handlers.openSettings,
    },
    {
      id: "switch-theme",
      sectionId: "configure",
      titleId:
        themeTarget === "dark"
          ? "quickPick.command.switchThemeToDark"
          : "quickPick.command.switchThemeToLight",
      icon: themeTarget === "dark" ? "themeDark" : "themeLight",
      keywords: ["theme", "dark", "light", "Topic", "Dark", "light color"],
      run: handlers.switchTheme,
    },
    {
      id: "skills-settings",
      sectionId: "configure",
      titleId: "quickPick.command.skills",
      icon: "skills",
      keywords: ["skills", "skill", "Configuration", "Skills"],
      run: handlers.openSkillsSettings,
    },
    {
      id: "mcp-settings",
      sectionId: "configure",
      titleId: "quickPick.command.mcpServers",
      icon: "mcp",
      keywords: ["mcp", "server", "servers", "MCP", "server"],
      run: handlers.openMcpSettings,
    },
  ];

  commands.push({
    id: "feedback",
    sectionId: "app",
    titleId: "quickPick.command.feedback",
    icon: "feedback",
    keywords: [
      "feedback",
      "issue",
      "support",
      "tickets",
      "Issue escalation",
      "Problem feedback",
      "feedback",
      "my feedback",
      "work order",
    ],
    run: handlers.openFeedback,
  });

  if (canOpenCommunity) {
    commands.push({
      id: "community",
      sectionId: "app",
      titleId: "quickPick.command.community",
      icon: "community",
      keywords: ["community", "users", "chat", "user community", "community"],
      run: handlers.openCommunity,
    });
  }

  commands.push({
    id: "product-docs",
    sectionId: "app",
    titleId: "quickPick.command.productDocs",
    icon: "book",
    keywords: ["docs", "documentation", "product docs", "Documentation", "Product documentation"],
    run: handlers.openProductDocs,
  });

  if (isLoggedIn && handlers.logout) {
    commands.push({
      id: "logout",
      sectionId: "app",
      titleId: "quickPick.command.logout",
      icon: "logout",
      keywords: ["disconnect", "logout", "sign out", "Disconnect", "Log out"],
      run: handlers.logout,
    });
  } else if (!isLoggedIn && handlers.login) {
    commands.push({
      id: "login",
      sectionId: "app",
      titleId: "quickPick.command.login",
      icon: "login",
      // The account actions in the command panel are expressed to the user as "connect/disconnect", and the search terms must also be synchronized.
      keywords: ["connect", "login", "sign in", "connect", "Login"],
      run: handlers.login,
    });
  }

  return commands.filter(
    (command) =>
      (supportsTerminal ||
        (command.id !== "toggle-terminal" && command.id !== "add-terminal-tab")) &&
      (supportsReview || command.id !== "add-review-tab"),
  );
}
