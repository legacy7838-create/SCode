/**
 * Single source of truth for every data-testid, shared by UI components and E2E tests.
 * Add new test ids here instead of hardcoding strings inside components.
 * Each one also needs a comment explaining what it targets
 */

// Login entry
/** Sign-in trigger button in the top-right corner */
export const TID_LOGIN_TRIGGER = "login-trigger";
/** Sign-in action in the user menu */
export const TID_LOGIN_MENU_ITEM = "login-menu-item";
/** Button on the login page that switches to API Key sign-in */
export const TID_LOGIN_USE_API_KEY_BUTTON = "login-use-api-key-button";
/** Provider picker trigger for API Key sign-in */
export const TID_LOGIN_API_KEY_PROVIDER_TRIGGER = "login-api-key-provider-trigger";
/** Provider option for API Key sign-in (dynamic suffix is the provider choice) */
export const TID_LOGIN_API_KEY_PROVIDER_ITEM = "login-api-key-provider-item";
/** API Key input field for API Key sign-in */
export const TID_LOGIN_API_KEY_INPUT = "login-api-key-input";
/** Continue button for API Key sign-in */
export const TID_LOGIN_API_KEY_CONTINUE_BUTTON = "login-api-key-continue-button";
/** Cancel button for API Key sign-in */
export const TID_LOGIN_API_KEY_CANCEL_BUTTON = "login-api-key-cancel-button";
/** "Skip for now" button for API Key sign-in */
export const TID_LOGIN_API_KEY_SKIP_BUTTON = "login-api-key-skip-button";
/** Error message for API Key sign-in */
export const TID_LOGIN_API_KEY_ERROR = "login-api-key-error";
/** Sign-in button inside the OAuth popup */
export const TID_OAUTH_LOGIN_BUTTON = "oauth-login-button";
/** Cancel button in the OAuth popup */
export const TID_OAUTH_CANCEL = "oauth-cancel";
/** Error text for OAuth */
export const TID_OAUTH_ERROR = "oauth-error";

// App
/** Top navigation bar */
export const TID_APP_HEADER = "app-header";
/** Language switch button */
export const TID_LOCALE_TOGGLE = "locale-toggle";
/** Theme switch button */
export const TID_THEME_TOGGLE = "theme-toggle";
/** Sign-out button */
export const TID_LOGOUT_BUTTON = "logout-button";
/** Button that shows/hides the terminal */
export const TID_TERMINAL_TOGGLE = "terminal-toggle";
export const TID_SIDE_PANE_TOGGLE = "side-pane-toggle";
/** Close button for the terminal panel */
export const TID_TERMINAL_CLOSE_BUTTON = "terminal-close-button";
/** Button that shows/hides the browser */
export const TID_BROWSER_TOGGLE = "browser-toggle";
/** Button that shows/hides Git */
export const TID_GIT_TOGGLE = "git-toggle";
/** Browser panel container */
export const TID_BROWSER_PANE = "browser-pane";
/** Close button for the browser panel */
export const TID_BROWSER_CLOSE_BUTTON = "browser-close-button";
/** Git panel container */
export const TID_GIT_PANE = "git-pane";
/** Close button for the Git panel */
export const TID_GIT_CLOSE_BUTTON = "git-close-button";
/** Main Git commit or push entry point in the header */
export const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
/** Git commit dialog */
export const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
/** Git commit message input */
export const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
/** Button that generates the Git commit message */
export const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
/** Toggle in the Git commit dialog for including unstaged changes */
export const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
/** Command action list at the bottom of the Git commit dialog */
export const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
/** Action item at the bottom of the Git commit dialog (dynamic suffix is the action id) */
export const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
/** Browser address bar input */
export const TID_BROWSER_ADDRESS_INPUT = "browser-address-input";
/** Browser back button */
export const TID_BROWSER_BACK_BUTTON = "browser-back-button";
/** Browser forward button */
export const TID_BROWSER_FORWARD_BUTTON = "browser-forward-button";
/** Browser refresh button */
export const TID_BROWSER_REFRESH_BUTTON = "browser-refresh-button";
/** Button for the browser responsive (free-size) mode */
export const TID_BROWSER_RESPONSIVE_BUTTON = "browser-responsive-button";
/** Viewport of the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_VIEWPORT = "browser-responsive-viewport";
/** Toolbar at the top of the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_TOOLBAR = "browser-responsive-toolbar";
/** Width input for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_WIDTH_INPUT = "browser-responsive-width-input";
/** Height input for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_HEIGHT_INPUT = "browser-responsive-height-input";
/** Zoom selector for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_ZOOM_SELECT = "browser-responsive-zoom-select";
/** Zoom option in the browser responsive mode (dynamic suffix is the zoom value) */
export const TID_BROWSER_RESPONSIVE_ZOOM_OPTION = "browser-responsive-zoom-option";
/** Placeholder for the scaled canvas in the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_SCALED_FRAME = "browser-responsive-scaled-frame";
/** Left resize handle for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_LEFT = "browser-responsive-resize-left";
/** Right resize handle for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_WIDTH = "browser-responsive-resize-width";
/** Top resize handle for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_TOP = "browser-responsive-resize-top";
/** Bottom resize handle for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT = "browser-responsive-resize-height";
/** Top-left resize corner for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT =
  "browser-responsive-resize-corner-top-left";
/** Top-right resize corner for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT =
  "browser-responsive-resize-corner-top-right";
/** Bottom-left resize corner for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT =
  "browser-responsive-resize-corner-bottom-left";
/** Bottom-right resize corner for the browser responsive mode */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER = "browser-responsive-resize-corner";
/** Element picker button in the browser */
export const TID_BROWSER_ELEMENT_PICKER_BUTTON = "browser-element-picker-button";
/** More-actions button in the browser address bar */
export const TID_BROWSER_MORE_BUTTON = "browser-more-button";
/** Menu item that opens the page in the default browser */
export const TID_BROWSER_OPEN_EXTERNAL_ITEM = "browser-open-external-item";
/** Button that opens the browser devtools */
export const TID_BROWSER_DEVTOOLS_BUTTON = "browser-devtools-button";
/** Browser web view */
export const TID_BROWSER_WEBVIEW = "browser-webview";
/** Readable error state shown when the browser page fails to load */
export const TID_BROWSER_LOAD_ERROR = "browser-load-error";
/** Certificate-acceptance guidance shown inside the browser load-error state */
export const TID_BROWSER_LOAD_ERROR_CERT_HINT = "browser-load-error-cert-hint";
/** Preview panel container */
export const TID_PREVIEW_PANE = "preview-pane";
/** Close button for the preview panel */
export const TID_PREVIEW_CLOSE_BUTTON = "preview-close-button";
/** Previous-chunk button in the preview panel */
export const TID_PREVIEW_PREV_BUTTON = "preview-prev-button";
/** Next-chunk button in the preview panel */
export const TID_PREVIEW_NEXT_BUTTON = "preview-next-button";
/** "View code" button inside a tool call */
export const TID_TOOL_CODE_VIEWER_BUTTON = "tool-code-viewer-button";
/** Trigger on a tool call summary row (dynamic suffix is the toolId) */
export const TID_TOOL_SUMMARY_TRIGGER = "tool-summary-trigger";

// Terminal
/** Terminal container */
export const TID_TERMINAL = "terminal";

// SSHDialog
/** Trigger that opens the SSH connect dialog */
export const TID_SSH_CONNECT_TRIGGER = "ssh-connect-trigger";
/** SSH connect dialog container */
export const TID_SSH_DIALOG = "ssh-dialog";
/** Remote connection kind: switch to SSH */
export const TID_REMOTE_KIND_SSH = "remote-kind-ssh";
/** Remote connection kind: switch to WSL */
/** SSH host address input */
export const TID_SSH_HOST_INPUT = "ssh-host-input";
/** SSH port input */
export const TID_SSH_PORT_INPUT = "ssh-port-input";
/** SSH username input */
export const TID_SSH_USERNAME_INPUT = "ssh-username-input";
/** SSH config alias picker */
export const TID_SSH_CONFIG_ALIAS_SELECT = "ssh-config-alias-select";
/** SSH password input */
export const TID_SSH_PASSWORD_INPUT = "ssh-password-input";
/** SSH private key path input */
export const TID_SSH_PRIVATE_KEY_INPUT = "ssh-private-key-input";
/** SSH auth method: password */
export const TID_SSH_AUTH_PASSWORD = "ssh-auth-password";
/** SSH auth method: private key */
export const TID_SSH_AUTH_PRIVATE_KEY = "ssh-auth-private-key";
/** WSL distribution picker */
/** WSL Linux user input */
/** SSH connect confirm button */
export const TID_SSH_CONNECT_BUTTON = "ssh-connect-button";
/** Cancel button in the SSH dialog */
export const TID_SSH_CANCEL_BUTTON = "ssh-cancel-button";

// Sidebar
/** Sidebar container */
export const TID_SIDEBAR = "sidebar";
/** Button that opens a workspace from the sidebar */
export const TID_WORKSPACE_OPEN_BUTTON = "workspace-open-button";
/** Workspace list in the sidebar */
export const TID_WORKSPACE_LIST = "workspace-list";
/** Workspace entry in the sidebar (dynamic suffix is the workspacePath) */
export const TID_WORKSPACE_ITEM = "workspace-item";
/** Button that closes a workspace from the sidebar (dynamic suffix is the workspacePath) */
export const TID_WORKSPACE_CLOSE = "workspace-close";
/** Secondary conversations section in the project view */
export const TID_CONVERSATION_SECTION = "conversation-section";
/** Secondary projects section in the project view */
export const TID_PROJECT_SECTION = "project-section";
/** New task button in the conversations section */
export const TID_CONVERSATION_NEW_TASK = "conversation-new-task";
/** Add menu button in the projects section */
export const TID_PROJECT_ADD = "project-add";
/** Composer workspace picker trigger */
export const TID_COMPOSER_WORKSPACE_TRIGGER = "composer-workspace-trigger";
/** Remote connection entry in the Composer workspace menu */
export const TID_COMPOSER_REMOTE_CONNECTION = "composer-remote-connection";
/** Button that detaches the current project in the Composer */
export const TID_COMPOSER_PROJECT_DETACH = "composer-project-detach";
/** "Work outside a project" entry in the Composer workspace menu */
export const TID_COMPOSER_WORK_OUTSIDE_PROJECT = "composer-work-outside-project";
// ChatView
/** Chat view container */
export const TID_CHAT_VIEW = "chat-view";
/** Chat message list */
export const TID_CHAT_MESSAGES = "chat-messages";
/** Error banner above the chat input area */
export const TID_CHAT_ERROR_BANNER = "chat-error-banner";
/** Details button for a hook-blocked error */
export const TID_CHAT_ERROR_DETAILS_BUTTON = "chat-error-details-button";
/** Icon on the left of the hook-blocked error banner */
export const TID_CHAT_ERROR_HOOK_ICON = "chat-error-hook-icon";
/** Chat empty state container */
export const TID_CHAT_EMPTY = "chat-empty";
/** Chat input box */
export const TID_CHAT_INPUT = "chat-input";
/** Chat attachment button */
export const TID_CHAT_ATTACHMENT_BUTTON = "chat-attachment-button";
/** Chat attachment menu item */
export const TID_CHAT_ATTACHMENT_MENU_ITEM = "chat-attachment-menu-item";
/** Chat send button */
export const TID_CHAT_SEND_BUTTON = "chat-send-button";
/** Chat stop button */
export const TID_CHAT_STOP_BUTTON = "chat-stop-button";
/** Chat loading indicator */
export const TID_CHAT_LOADING = "chat-loading";
/** Status summary panel in the top-right of the chat */
export const TID_CHAT_SUMMARY_PANEL = "chat-summary-panel";
/** Context-compaction bar on the chat timeline (dynamic suffix is the inputId or operationId) */
export const TID_CHAT_COMPACT_MARKER = "chat-compact-marker";
/** Retry button after a context compaction failed or was interrupted (dynamic suffix is the inputId or operationId) */
export const TID_CHAT_COMPACT_RETRY_BUTTON = "chat-compact-retry-button";
/** Goal verification bar on the chat timeline (dynamic suffix is targetId:goalIteration or verificationId) */
export const TID_CHAT_GOAL_VERIFICATION_MARKER = "chat-goal-verification-marker";
/** Chat queue panel */
export const TID_CHAT_QUEUE_PANEL = "chat-queue-panel";
/** Chat queue item (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_ITEM = "chat-queue-item";
/** Chat queue item content (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_ITEM_CONTENT = "chat-queue-item-content";
/** Send-now button on a chat queue item (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_SEND_NOW_BUTTON = "chat-queue-send-now-button";
/** Edit button on a chat queue item (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_EDIT_BUTTON = "chat-queue-edit-button";
/** Edit input on a chat queue item (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_EDIT_INPUT = "chat-queue-edit-input";
/** Save button in the chat queue item editor (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_EDIT_SAVE_BUTTON = "chat-queue-edit-save-button";
/** Cancel button in the chat queue item editor (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_EDIT_CANCEL_BUTTON = "chat-queue-edit-cancel-button";
/** Remove button on a chat queue item (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_REMOVE_BUTTON = "chat-queue-remove-button";
/** Drag handle on a chat queue item (dynamic suffix is the queueItemId) */
export const TID_CHAT_QUEUE_DRAG_HANDLE = "chat-queue-drag-handle";
/** Chat user message container (dynamic suffix is the messageId) */
export const TID_CHAT_USER_MESSAGE = "chat-user-message";
/** Chat assistant message container (dynamic suffix is the messageId) */
export const TID_CHAT_ASSISTANT_MESSAGE = "chat-assistant-message";
/** Trigger that collapses assistant message history in the chat (dynamic suffix is the historyStateKey) */
export const TID_CHAT_ASSISTANT_HISTORY_TRIGGER = "chat-assistant-history-trigger";
/** Collapsed assistant message history content in the chat (dynamic suffix is the historyStateKey) */
export const TID_CHAT_ASSISTANT_HISTORY_CONTENT = "chat-assistant-history-content";
/** Task title of a standalone background result turn (dynamic suffix is the turn key) */
export const TID_CHAT_BACKGROUND_RESULT_TITLE = "chat-background-result-title";
/** Chat tool call block container (dynamic suffix is the toolCallId) */
export const TID_CHAT_TOOL_CALL_BLOCK = "chat-tool-call-block";
/** Edit button on a chat user message (dynamic suffix is the messageId) */
export const TID_CHAT_MESSAGE_EDIT_BUTTON = "chat-message-edit-button";
/** Edit input for a chat user message (dynamic suffix is the messageId) */
export const TID_CHAT_MESSAGE_EDIT_INPUT = "chat-message-edit-input";
/** Submit button in the chat user message editor (dynamic suffix is the messageId) */
export const TID_CHAT_MESSAGE_EDIT_SUBMIT = "chat-message-edit-submit";
/** Cancel button in the chat user message editor (dynamic suffix is the messageId) */
export const TID_CHAT_MESSAGE_EDIT_CANCEL = "chat-message-edit-cancel";
/** Fork button on a chat assistant message (dynamic suffix is the messageId) */
export const TID_CHAT_MESSAGE_FORK_BUTTON = "chat-message-fork-button";
/** Undo/re-apply button in the chat change summary (dynamic suffix is the messageId) */
export const TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON =
  "chat-change-summary-toggle-files-button";
/** Prompt suggestion panel above the chat input */
export const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
/** Prompt suggestion group in the chat input (dynamic suffix is the group id) */
export const TID_PROMPT_SUGGESTION_SECTION = "prompt-suggestion-section";
/** Prompt suggestion option in the chat input (dynamic suffix is the option id) */
export const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
/** Status row of a prompt suggestion group in the chat input (dynamic suffix is the group id) */
export const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

// TaskList
/** Task list container */
export const TID_TASK_LIST = "task-list";
/** New task button */
export const TID_TASK_NEW_BUTTON = "task-new-button";
/** Task list entry (dynamic suffix is the taskId) */
export const TID_TASK_ITEM = "task-item";
/** Task list empty state */
export const TID_TASK_EMPTY = "task-empty";
/** Task archive button (dynamic suffix is the taskId) */
export const TID_TASK_ARCHIVE = "task-archive";
/** Settings entry button below the task list */
export const TID_TASK_SETTINGS_BUTTON = "task-settings-button";

// Settings
/** Settings page container */
export const TID_SETTINGS_PAGE = "settings-page";
/** Button that returns from settings to the workspace */
export const TID_SETTINGS_BACK_BUTTON = "settings-back-button";
/** Section entry in the left nav of the settings page (dynamic suffix is the section id) */
export const TID_SETTINGS_SECTION_NAV = "settings-section-nav";
/** Enhanced Find/Grep toggle in General settings */
export const TID_SETTINGS_NATIVE_SEARCH_SWITCH = "settings-native-search-switch";
/** Read-only data storage path input in General settings */
export const TID_SETTINGS_DATA_BASE_DIR_INPUT = "settings-data-base-dir-input";
/** Directory picker button for the data storage path in General settings */
export const TID_SETTINGS_DATA_BASE_DIR_BROWSE = "settings-data-base-dir-browse";
/** Save button for the data storage path in General settings */
export const TID_SETTINGS_DATA_BASE_DIR_SAVE = "settings-data-base-dir-save";
/** Copied / pending-restart / failed status of the data storage path in General settings */
export const TID_SETTINGS_DATA_BASE_DIR_STATUS = "settings-data-base-dir-status";
/** Tab at the top of the resource manager (suffix=cpu|memory|storage) */
export const TID_RESOURCE_MANAGER_TAB = "resource-manager-tab";
/** Resource manager "Storage" tab: partition container */
export const TID_RESOURCE_MANAGER_STORAGE_SECTION = "resource-manager-storage-section";
/** Resource manager "Storage" tab: total usage number */
export const TID_RESOURCE_MANAGER_STORAGE_TOTAL = "resource-manager-storage-total";
/** Resource manager "Storage" tab: scan status (data-state=scanning|complete|cancelled|failed|idle) */
export const TID_RESOURCE_MANAGER_STORAGE_STATUS = "resource-manager-storage-status";
/** Resource manager "Storage" tab: rescan button */
export const TID_RESOURCE_MANAGER_STORAGE_RESCAN = "resource-manager-storage-rescan";
/** Resource manager "Storage" tab: disk card (suffix=volume key index) */
export const TID_RESOURCE_MANAGER_STORAGE_DISK_CARD = "resource-manager-storage-disk-card";
/** Resource manager "Storage" tab: root directory row inside a disk card (suffix=rootId) */
export const TID_RESOURCE_MANAGER_STORAGE_ROOT = "resource-manager-storage-root";
/** Resource manager "Storage" tab: category row (suffix=categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW = "resource-manager-storage-category-row";
/** Resource manager "Storage" tab: size on a category row (suffix=categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE = "resource-manager-storage-category-size";
/** Resource manager "Storage" tab: clean button for a category (suffix=categoryId) */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN =
  "resource-manager-storage-category-clean";
/** Resource manager "Storage" tab: category detail view */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL = "resource-manager-storage-detail";
/** Resource manager "Storage" tab: back button from the detail view */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK = "resource-manager-storage-detail-back";
/** Resource manager "Storage" tab: detail entry row */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY = "resource-manager-storage-detail-entry";
/** Resource manager "Storage" tab: clean confirmation dialog */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG =
  "resource-manager-storage-confirm-dialog";
/** Resource manager "Storage" tab: confirm button of the clean confirmation dialog */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT =
  "resource-manager-storage-confirm-accept";
/** Resource manager "Storage" tab: cancel button of the clean confirmation dialog */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL =
  "resource-manager-storage-confirm-cancel";
/** Master switch in the Memory settings section */
export const TID_SETTINGS_MEMORY_SWITCH = "settings-memory-switch";
/** Refresh button in the Memory settings section */
export const TID_SETTINGS_MEMORY_REFRESH = "settings-memory-refresh";
/** Memory workspace scope menu trigger */
export const TID_SETTINGS_MEMORY_SCOPE_TRIGGER = "settings-memory-scope-trigger";
/** Memory workspace scope icon */
export const TID_SETTINGS_MEMORY_SCOPE_ICON = "settings-memory-scope-icon";
/** Number of files in the current Memory workspace */
export const TID_SETTINGS_MEMORY_COUNT = "settings-memory-count";
/** Memory file-name search input */
export const TID_SETTINGS_MEMORY_SEARCH_INPUT = "settings-memory-search-input";
/** Clear button for the Memory file-name search */
export const TID_SETTINGS_MEMORY_SEARCH_CLEAR = "settings-memory-search-clear";
/** Button that goes from the Memory project file list back to the project list */
export const TID_SETTINGS_MEMORY_BACK_PROJECTS = "settings-memory-back-projects";
/** Button that goes from a Memory file body back to the project file list */
export const TID_SETTINGS_MEMORY_BACK_MEMORIES = "settings-memory-back-memories";
/** Memory workspace row (dynamic suffix is the workspace id) */
export const TID_SETTINGS_MEMORY_WORKSPACE = "settings-memory-workspace";

/** Memory file row (dynamic suffix is the file name) */
export const TID_SETTINGS_MEMORY_FILE = "settings-memory-file";
/** Memory file type icon (dynamic suffix is the file name) */
export const TID_SETTINGS_MEMORY_FILE_ICON = "settings-memory-file-icon";
/** Memory file name (dynamic suffix is the file name) */
export const TID_SETTINGS_MEMORY_FILE_NAME = "settings-memory-file-name";
/** Memory file updated-at (dynamic suffix is the file name) */
export const TID_SETTINGS_MEMORY_FILE_UPDATED_AT = "settings-memory-file-updated-at";
/** Memory file editor action group (dynamic suffix is the file name) */
export const TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS = "settings-memory-file-editor-actions";
/** Raw Markdown preview of a Memory file */
export const TID_SETTINGS_MEMORY_PREVIEW = "settings-memory-preview";
/** AskUserQuestion auto-continue toggle in General settings */
export const TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH =
  "settings-ask-user-question-auto-resolution-switch";
/** Interface language dropdown trigger in the General section of the settings page */
export const TID_SETTINGS_LOCALE_SELECT_TRIGGER = "settings-locale-select-trigger";
/** Interface language dropdown item in the General section of the settings page (dynamic suffix is the locale preference) */
export const TID_SETTINGS_LOCALE_SELECT_ITEM = "settings-locale-select-item";
/** User/workspace MCP list row (dynamic suffix is the MCP runtime name) */
export const TID_MCP_SERVER_ROW = "mcp-server-row";
/** Plugin MCP list row (dynamic suffix is the MCP runtime name) */
export const TID_PLUGIN_MCP_SERVER_ROW = "plugin-mcp-server-row";
/** MCP OAuth authorization button (dynamic suffix is the MCP runtime name) */
export const TID_MCP_OPEN_AUTHORIZATION_BUTTON = "mcp-open-authorization-button";
/** Subagent list row (dynamic suffix is the subagent name) */
export const TID_SUBAGENT_ROW = "subagent-row";
/** Model picker for a built-in subagent (dynamic suffix is the subagent name) */
export const TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER = "subagent-built-in-model-trigger";
/** Top-level usage tab on the settings page (dynamic suffix is the usage tab id) */
export const TID_SETTINGS_USAGE_TAB = "settings-usage-tab";
/** Remaining-quota submenu entry in the sidebar avatar menu */
export const TID_SIDEBAR_USAGE_REMAINING_TRIGGER = "sidebar-usage-remaining-trigger";
/** Usage entry in the sidebar avatar menu */
export const TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON = "sidebar-coding-plan-usage-button";

// Model Provider Settings
/** Add button at the top of the model provider settings */
export const TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON = "model-provider-add-provider-button";
/** Model provider template picker page */
export const TID_MODEL_PROVIDER_TEMPLATE_PICKER = "model-provider-template-picker";
/** Model provider template item (dynamic suffix is the templateId, where `custom` means fully custom) */
export const TID_MODEL_PROVIDER_TEMPLATE_ITEM = "model-provider-template-item";
/** Button that returns from the model provider template picker to the current provider details */
export const TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON = "model-provider-template-back-button";
/** Model provider nav item in the left sidebar (dynamic suffix is the provider node key) */
export const TID_MODEL_PROVIDER_NAV_ITEM = "model-provider-nav-item";
/** Connection mode dropdown trigger for a model provider */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER = "model-provider-connection-mode-trigger";
/** Shortcut entry showing how many Start Plans already exist on the settings page. */
export const TID_MODEL_PROVIDER_START_PLAN_COUNT_SHORTCUT =
  "model-provider-start-plan-count-shortcut";
export const TID_MODEL_PROVIDER_START_PLAN_SWITCH_PREFIX =
  "model-provider-start-plan-switch-prefix";
/** Connection mode dropdown item for a model provider (dynamic suffix is the connection mode key) */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM = "model-provider-connection-mode-item";
/** API Key input in the model provider details */
export const TID_MODEL_PROVIDER_API_KEY_INPUT = "model-provider-api-key-input";
/** Name edit button for a model provider */
export const TID_MODEL_PROVIDER_NAME_EDIT_BUTTON = "model-provider-name-edit-button";
/** Name input for a model provider */
export const TID_MODEL_PROVIDER_NAME_INPUT = "model-provider-name-input";
/** Base URL input for a model provider */
export const TID_MODEL_PROVIDER_BASE_URL_INPUT = "model-provider-base-url-input";
/** API format dropdown trigger for a model provider */
export const TID_MODEL_PROVIDER_API_FORMAT_TRIGGER = "model-provider-api-format-trigger";
/** API format dropdown item for a model provider (dynamic suffix is the API format) */
export const TID_MODEL_PROVIDER_API_FORMAT_ITEM = "model-provider-api-format-item";
/** Model input for a model provider (dynamic suffix is the model row index) */
export const TID_MODEL_PROVIDER_MODEL_INPUT = "model-provider-model-input";
/** Delete button on a model provider model (dynamic suffix is the model row index) */
export const TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON = "model-provider-model-delete-button";
/** Add model button for a model provider */
export const TID_MODEL_PROVIDER_ADD_MODEL_BUTTON = "model-provider-add-model-button";

// Chat Toolbar
/** Model picker button in the chat toolbar */
export const TID_CHAT_MODEL_SELECT_TRIGGER = "chat-model-select-trigger";
/** Model provider group in the chat toolbar (dynamic suffix is the provider group key) */
export const TID_CHAT_MODEL_SELECT_GROUP = "chat-model-select-group";
/** Model picker item in the chat toolbar (dynamic suffix is the model value) */
export const TID_CHAT_MODEL_SELECT_ITEM = "chat-model-select-item";
/** Thought-level picker button in the chat toolbar */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER = "chat-thought-level-select-trigger";
/** Thought-level picker item in the chat toolbar (dynamic suffix is the thought-level value) */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM = "chat-thought-level-select-item";
/** Mode picker button in the chat toolbar (e2e anchor for the v4 switchCollaborationMode) */
export const TID_CHAT_MODE_SELECT_TRIGGER = "chat-mode-select-trigger";
/** Mode picker item in the chat toolbar (dynamic suffix is the mode value) */
export const TID_CHAT_MODE_SELECT_ITEM = "chat-mode-select-item";
/** Context usage button in the chat toolbar */
export const TID_CHAT_CONTEXT_USAGE_TRIGGER = "chat-context-usage-trigger";
/** Trigger that collapses a reasoning block */
export const TID_CHAT_REASONING_TRIGGER = "chat-reasoning-trigger";
/** Collapsed reasoning block content container */
export const TID_CHAT_REASONING_CONTENT = "chat-reasoning-content";

// Workspace
/** Header of the main content area */
export const TID_WORKSPACE_HEADER = "workspace-header";
/** Workspace title */
export const TID_WORKSPACE_TITLE = "workspace-title";
/** Workspace path */
export const TID_WORKSPACE_PATH = "workspace-path";
/** More-menu button in the workspace header */
export const TID_WORKSPACE_MORE_BUTTON = "workspace-more-button";
/** Question-mark help menu trigger in the top-right corner */
export const TID_WORKSPACE_HELP_MENU_TRIGGER = "workspace-help-menu-trigger";
/** "Resource Manager" item in the question-mark help menu (desktop only) */
export const TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER = "workspace-help-menu-resource-manager";
/** Button that opens the workspace file tree from the sidebar (dynamic suffix is the workspacePath) */
export const TID_WORKSPACE_FILE_TREE_BUTTON = "workspace-file-tree-button";
/** Workspace file tree panel */
export const TID_WORKSPACE_FILE_TREE_PANEL = "workspace-file-tree-panel";
/** Refresh button in the workspace file tree */
export const TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON = "workspace-file-tree-refresh-button";
/** Workspace file tree entry (dynamic suffix is the absolute file path) */
export const TID_WORKSPACE_FILE_TREE_ROW = "workspace-file-tree-row";
// SSH error message
/** SSH connection error message */
export const TID_SSH_ERROR = "ssh-error";
/** SSH connection success message */
export const TID_SSH_SUCCESS = "ssh-success";

// V4 session pane (protocol-v4 vertical cut; positioning protocol with paneId dimension: same as session double pane, distinguished by paneId suffix)
/** v4 session pane container (dynamic suffix is the paneId) */
export const TID_V4_SESSION_PANE = "v4-session-pane";
/** v4 message timeline container */
export const TID_V4_TIMELINE = "v4-timeline";
/** v4 timeline empty state placeholder */
export const TID_V4_TIMELINE_EMPTY = "v4-timeline-empty";
/** v4 projection row (dynamic suffix is the rowId) */
export const TID_V4_ROW = "v4-row";
/** Container of the v4 workspace hook pending-review banner */
export const TID_V4_WORKSPACE_HOOK_PENDING_BANNER = "v4-workspace-hook-pending-banner";
/** "Review" button on the v4 workspace hook pending-review banner */
export const TID_V4_WORKSPACE_HOOK_PENDING_REVIEW = "v4-workspace-hook-pending-review";
/** "Dismiss" button on the v4 workspace hook pending-review banner */
export const TID_V4_WORKSPACE_HOOK_PENDING_DISMISS = "v4-workspace-hook-pending-dismiss";
/** v4 composer container */
export const TID_V4_COMPOSER = "v4-composer";
/** v4 composer text input */
export const TID_V4_COMPOSER_INPUT = "v4-composer-input";
/** Entry point for background tasks of the current session in the v4 composer */
export const TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER = "v4-composer-background-work-trigger";
/** Always-visible computer use (CUA) entry button in the v4 composer */
export const TID_V4_COMPOSER_CUA_ENTRY = "v4-composer-cua-entry";
/** v4 composer send button */
export const TID_V4_COMPOSER_SEND = "v4-composer-send";
/** v4 paused-queue send confirmation: clear the queue and send */
export const TID_V4_COMPOSER_CLEAR_QUEUE_SEND = "v4-composer-clear-queue-send";
/** v4 paused-queue send confirmation: keep the queue and send */
export const TID_V4_COMPOSER_KEEP_QUEUE_SEND = "v4-composer-keep-queue-send";
/** v4 paused-queue send confirmation dialog */
export const TID_V4_PAUSED_QUEUE_SEND_DIALOG = "v4-paused-queue-send-dialog";
/** V4 composer attachment chip (dynamic suffix is the attachment id) */
export const TID_V4_ATTACHMENT = "v4-attachment";
/** V4 composer attachment upload progress (dynamic suffix is the attachment id) */
export const TID_V4_ATTACHMENT_UPLOAD_PROGRESS = "v4-attachment-upload-progress";
/** V4 composer attachment upload retry (dynamic suffix is the attachment id) */
export const TID_V4_ATTACHMENT_UPLOAD_RETRY = "v4-attachment-upload-retry";
/** v4 stop button */
export const TID_V4_STOP = "v4-stop";
/** Fork button on a v4 assistant row (dynamic suffix is the rowId) */
export const TID_V4_FORK = "v4-fork";
/** Retry button on a v4 assistant row (dynamic suffix is the rowId) */
export const TID_V4_RETRY = "v4-retry";
/** Thumbs-up button on a v4 assistant row (dynamic suffix is the rowId) */
export const TID_V4_FEEDBACK_LIKE = "v4-feedback-like";
/** Thumbs-down button on a v4 assistant row (dynamic suffix is the rowId) */
export const TID_V4_FEEDBACK_DISLIKE = "v4-feedback-dislike";
/** Details button for a turn hook (dynamic suffix is the product turnId) */
export const TID_V4_HOOK_DETAILS_TRIGGER = "v4-hook-details-trigger";
/** Popover with the turn hook details (dynamic suffix is the product turnId) */
export const TID_V4_HOOK_DETAILS_CONTENT = "v4-hook-details-content";
/** Edit button on a v4 user row (dynamic suffix is the rowId) */
export const TID_V4_EDIT = "v4-edit";
/** Edit input for a v4 user query (dynamic suffix is the rowId) */
export const TID_V4_EDIT_INPUT = "v4-edit-input";
/** Submit button in the v4 user query editor (dynamic suffix is the rowId) */
export const TID_V4_EDIT_SUBMIT = "v4-edit-submit";
/** Cancel button in the v4 user query editor (dynamic suffix is the rowId) */
export const TID_V4_EDIT_CANCEL = "v4-edit-cancel";
/** Attachment remove button in the v4 user query editor (dynamic suffix is rowId-index) */
export const TID_V4_EDIT_ATTACHMENT_REMOVE = "v4-edit-attachment-remove";
export const TID_V4_EDIT_REWIND_WORKSPACE = "v4-edit-rewind-workspace";
/** v4 edit file conflict dialog */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG = "v4-edit-workspace-conflict-dialog";
/** Fallback to trimming only the conversation when the v4 edit hits a file conflict */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY =
  "v4-edit-workspace-conflict-conversation-only";
/** v4 queue panel container */
export const TID_V4_QUEUE = "v4-queue";
/** v4 paused-queue reason / resume banner */
export const TID_V4_QUEUE_PAUSED_BANNER = "v4-queue-paused-banner";
/** Button that resumes auto-draining the paused v4 queue */
export const TID_V4_QUEUE_RESUME = "v4-queue-resume";
/** Inline edit input of a v4 queue item (dynamic suffix is the queueItemId) */
/** v4 queue item (dynamic suffix is the queueItemId) */
export const TID_V4_QUEUE_ITEM = "v4-queue-item";
/** Delete button on a v4 queue item (dynamic suffix is the queueItemId) */
export const TID_V4_QUEUE_ITEM_DELETE = "v4-queue-item-delete";
/** Edit button on a v4 queue item (dynamic suffix is the queueItemId) */
export const TID_V4_QUEUE_ITEM_EDIT = "v4-queue-item-edit";
/** Send-now button on a v4 queue item (dynamic suffix is the queueItemId) */
export const TID_V4_QUEUE_ITEM_SEND_NOW = "v4-queue-item-send-now";
/** Move-up button on a v4 queue item (dynamic suffix is the queueItemId) */
export const TID_V4_QUEUE_ITEM_UP = "v4-queue-item-up";
/** v4 input control: queue autoDrain toggle button (setAutoDrain command) */
export const TID_V4_AUTODRAIN_TOGGLE = "v4-autodrain-toggle";
/** v4 input control: followup routing mode toggle button (setFollowupMode command) */
export const TID_V4_FOLLOWUP_TOGGLE = "v4-followup-toggle";
/** v4 session title display (meta.title; a placeholder is shown when it is empty) */
export const TID_V4_SESSION_TITLE = "v4-session-title";
/** v4 session rename input (renameSession command) */
export const TID_V4_RENAME_INPUT = "v4-rename-input";
/** v4 session rename submit button (renameSession command) */
export const TID_V4_RENAME_SUBMIT = "v4-rename-submit";
/** v4 goal status banner (objective + status, a projection of the sendGoalCommand/resumeGoal effects) */
export const TID_V4_GOAL_BANNER = "v4-goal-banner";
/** v4 session delete button (deleteSession command; falls back to the draft after deletion) */
export const TID_V4_DELETE_SESSION = "v4-delete-session";
/** v4 background work panel (a projection of backgroundWorks) */
export const TID_V4_BACKGROUND_WORKS = "v4-background-works";
/** v4 background work item (dynamic suffix is the workId) */
export const TID_V4_BACKGROUND_WORK_ITEM = "v4-background-work-item";
/** Cancel button on a v4 background work item (cancelBackgroundWork command; dynamic suffix is the workId) */
export const TID_V4_BACKGROUND_WORK_CANCEL = "v4-background-work-cancel";
/** v4 model config display (data-provider/data-model/data-thought, a projection of the switchModelConfig effects) */
export const TID_V4_MODEL_CONFIG = "v4-model-config";
// v4-model-provider-input / v4-model-model-input / v4-model-thought-input /
// v4-model-apply (debug form) is retired - model switching is done by composer toolbar
// TID_CHAT_MODEL_SELECT_* / TID_CHAT_THOUGHT_LEVEL_SELECT_* bearers.
/** Reconnect button after a v4 subscription failure */
export const TID_V4_RETRY_SUBSCRIBE = "v4-retry-subscribe";
/** v4 userInput interaction dialog container */
export const TID_V4_USER_INPUT_DIALOG = "v4-user-input-dialog";
/** v4 userInput option button (dynamic suffix is the optionId) */
export const TID_V4_USER_INPUT_OPTION = "v4-user-input-option";
/** v4 userInput free-text input */
export const TID_V4_USER_INPUT_TEXT = "v4-user-input-text";
/** "Back to bottom" button of the v4 timeline (appears once bottom-following is released; the virtual-scroll anchor) */
export const TID_V4_TIMELINE_BOTTOM = "v4-timeline-bottom";
/** v4 pane shell (wrapper added by the Layout/Focus layer, dynamic suffix is the paneId; data-focused marks the focused pane in a split) */
export const TID_V4_PANE_SHELL = "v4-pane-shell";
/** Button that splits the pane to the right (pane header; phase 1 means "open split view", phase 2 generalizes it to a split) */
export const TID_V4_SPLIT_OPEN = "v4-split-open";
/** Button that splits the pane downward (pane header, grid layout) */
export const TID_V4_SPLIT_DOWN = "v4-split-down";
/** Button that closes a pane (header of a non-primary pane; phase 1 means "close split view") */
export const TID_V4_SPLIT_CLOSE = "v4-split-close";
/** Split-view drag divider (pointer drag resizes the width; data-split-id marks the split node) */
export const TID_V4_SPLIT_DIVIDER = "v4-split-divider";
/** Workspace badge in a v4 pane header (shows ownership for panes that span workspaces) */
export const TID_V4_PANE_WORKSPACE_BADGE = "v4-pane-workspace-badge";
/** "Open in split view" item in the sidebar conversation context menu (desktop shell only, finishing touch) */
export const TID_V4_TASK_OPEN_IN_SPLIT = "v4-task-open-in-split";
/** "Load earlier" button of the v4 timeline (cursor pagination; appears while the first line of the window has not reached the first line of the full order) */
export const TID_V4_TIMELINE_LOAD_OLDER = "v4-timeline-load-older";
/** Global turn navigation rail of the v4 conversation (appears on wide screens once 2+ turns are navigable) */
export const TID_V4_TURN_NAVIGATOR = "v4-turn-navigator";
/** v4 turn navigation item (dynamic suffix is the render unit key) */
export const TID_V4_TURN_NAVIGATOR_ITEM = "v4-turn-navigator-item";
/** HoverCard preview in the v4 turn navigation (dynamic suffix is the render unit key) */
export const TID_V4_TURN_NAVIGATOR_TOOLTIP = "v4-turn-navigator-tooltip";
/** Drill-down toggle on a v4 subagent row (dynamic suffix is the rowId; only clickable when a childSessionId exists) */
export const TID_V4_SUBAGENT_TOGGLE = "v4-subagent-toggle";
/** Mini timeline container of a v4 subagent drill-down (dynamic suffix is the childSessionId) */
export const TID_V4_SUBAGENT_DRILLDOWN = "v4-subagent-drilldown";
/** "Open in split view" entry of a v4 subagent drill-down (dynamic suffix is the childSessionId) */
/** @deprecated subagent details moved to the tabs on the right; the constant is kept so older external tests still compile. */
export const TID_V4_SUBAGENT_OPEN_SPLIT = "v4-subagent-open-split";
export const TID_V4_SUBAGENT_OPEN_SIDE_PANE = "v4-subagent-open-side-pane";
/** v4 userInput row attachment list (dynamic suffix is the rowId) */
export const TID_V4_ROW_ATTACHMENTS = "v4-row-attachments";

// Plugin store
/** Entry button that opens the plugin store from the Plugin settings page (the store is a main WorkspaceShell view, not a settings section) */
export const TID_PLUGIN_STORE_BROWSE = "plugin-store-browse";

// Automations / scheduled tasks
export const TID_AUTOMATIONS_OPEN = "automations-open";
export const TID_AUTOMATIONS_LIST = "automations-list";
/** Status filter pill row shared by the scheduled and off-peak lists (all / running / done / failed) */
export const TID_AUTOMATIONS_STATUS_FILTER = "automations-status-filter";
export const TID_AUTOMATION_CREATE_MENU = "automation-create-menu";
export const TID_AUTOMATION_CREATE_MANUALLY = "automation-create-manually";
export const TID_AUTOMATION_CARD = "automation-card";
// Off-peak tasks (off-peak, independent)
export const TID_OFFPEAK_CREATE_BUTTON = "offpeak-create-button";
export const TID_OFFPEAK_CARD = "offpeak-card";
/** Off-peak card footnote: the title of the bound session (created from inside a session). */
export const TID_OFFPEAK_CARD_SESSION = "offpeak-card-session";
export const TID_OFFPEAK_CARD_MENU = "offpeak-card-menu";
export const TID_OFFPEAK_EDIT_VIEW = "offpeak-edit-view";
export const TID_OFFPEAK_EDIT_SUBMIT = "offpeak-edit-submit";
export const TID_OFFPEAK_FORM_TITLE = "offpeak-form-title";
export const TID_OFFPEAK_FORM_INSTRUCTIONS = "offpeak-form-instructions";
export const TID_OFFPEAK_ACTION_PAUSE = "offpeak-action-pause";
export const TID_OFFPEAK_ACTION_CONTINUE = "offpeak-action-continue";
export const TID_OFFPEAK_ACTION_DELETE = "offpeak-action-delete";
export const TID_OFFPEAK_TAB = "offpeak-tab";
export const TID_AUTOMATION_CARD_MENU = "automation-card-menu";
export const TID_AUTOMATION_ACTION_TOGGLE = "automation-action-toggle";
export const TID_AUTOMATION_ACTION_DELETE = "automation-action-delete";
export const TID_AUTOMATION_FORM_TITLE = "automation-form-title";
export const TID_AUTOMATION_FORM_PROMPT = "automation-form-prompt";
export const TID_AUTOMATION_FORM_SUBMIT = "automation-form-submit";
export const TID_AUTOMATION_RUN_NOW = "automation-run-now";
export const TID_AUTOMATION_EDIT_BACK = "automation-edit-back";
// Scheduling builder / custom repeat / year month and day selector (e2e stable anchor)
export const TID_AUTOMATION_FREQUENCY_SELECT = "automation-frequency-select";
export const TID_AUTOMATION_FREQUENCY_OPTION = "automation-frequency-option";
export const TID_AUTOMATION_CUSTOM_UNIT_SELECT = "automation-custom-unit-select";
export const TID_AUTOMATION_CUSTOM_UNIT_OPTION = "automation-custom-unit-option";
export const TID_AUTOMATION_CUSTOM_INTERVAL_SELECT = "automation-custom-interval-select";
export const TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT = "automation-custom-interval-increment";
export const TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT = "automation-custom-interval-decrement";
export const TID_AUTOMATION_CUSTOM_INTERVAL_OPTION = "automation-custom-interval-option";
export const TID_AUTOMATION_CUSTOM_REPEAT_EDIT = "automation-custom-repeat-edit";
export const TID_AUTOMATION_CUSTOM_CONFIRM = "automation-custom-confirm";
export const TID_AUTOMATION_YEAR_MONTHDAY = "automation-year-monthday";
export const TID_AUTOMATION_YEAR_MONTH_OPTION = "automation-year-month-option";
export const TID_AUTOMATION_YEAR_DAY_OPTION = "automation-year-day-option";
export const TID_AUTOMATION_SCHEDULE_PREVIEW = "automation-schedule-preview";
export const TID_AUTOMATION_SCHEDULE_ADD = "automation-schedule-add";
export const TID_AUTOMATION_SCHEDULE_DELETE = "automation-schedule-delete";
export const TID_CRON_CREATE_CARD = "cron-create-card";
export const TID_CRON_CREATE_OPEN = "cron-create-open";
export const TID_OFFPEAK_CREATE_CARD = "offpeak-create-card";
export const TID_OFFPEAK_CREATE_OPEN = "offpeak-create-open";
export const TID_CONFIRM_DIALOG_CONFIRM = "confirm-dialog-confirm";

/** Builds a suffixed test id for dynamic elements, e.g. file-tree-item-/home/user */
export function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

export const TID_START_PLAN_RECOMMENDATION_DIALOG = "start-plan-recommendation-dialog";

/** Opt-in switch for sharing diagnostic logs for user feedback */
export const TID_FEEDBACK_LOGS_OPT_IN = "feedback-logs-opt-in";
