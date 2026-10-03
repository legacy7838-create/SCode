# Specification: GitHub Activity Button & Contribution Heatmap

## 1. Overview & Objective
Replace the removed Help button position in the Workspace Header (`WorkspaceHeaderActionSection`) with a GitHub action button (`WorkspaceGitHubActivityButton`).
On hover/interaction, an accessible `HoverCard` displays:
1. **Unconnected State**: A clean "Connect GitHub" call-to-action allowing user to link their GitHub account (via username or quick connect) to track real-time commit activity.
2. **Connected State**: A short, compact 3-month rolling GitHub-style contribution activity heatmap with right-aligned month arrow navigation, month header labels, and an integrated right-slot year selector.

## 2. Product Rules & State Ownership
- **Owner**: `useGitHubActivityStore` (`packages/ui/src/store/githubActivityStore.ts`).
- **Persistence**: User login state and cached activity are persisted in browser/desktop local storage (`zcode_github_activity_session`).
- **Data Source & Rolling 3-Month Window**:
  - Live full-calendar multi-year contributions queried via standard contributions API (`https://github-contributions-api.jogruber.de/v4/{username}`) with direct calendar fallback, ensuring complete historical fidelity across all months.
  - The heatmap display is constrained to a focused **3-month window** (~14 weeks) inside a compact card layout (`w-[320px]`).
  - **Month Navigation**: Right-aligned arrow buttons (`<` and `>`) navigate backward and forward across months with smooth year boundary crossing. Month header names (e.g. `May  Jun  Jul`) are displayed directly above their respective week columns without truncation.
  - **Integrated Year Selector**: Embedded directly inside the heatmap container on the right side with sleek 3px mini scrollbar styling (`.zcode-mini-scrollbar`), replacing thick native system scrollbars.
  - **Summary**: Displays contribution total for the visible 3-month window. The redundant Recent Activity commit footer has been removed to keep the popover ultra-compact and focused.
- **Design System Rules**:
  - Strictly follow `DESIGN.md`: Typography using `text-ui-base`, `text-ui-sm`, `text-ui-xs`.
  - Icon: Hugeicons `GithubIcon` (`@hugeicons/core-free-icons` via `@hugeicons/react`).
  - Colors: Semantic tokens (`bg-popover`, `border-popover-border`, `text-foreground`, `text-foreground-subtle`, `--color-usage-heatmap-*`).
  - Native Windows title bar compatibility via `useWindowsCaptionSpacing`.

## 3. Interfaces
```typescript
export interface GitHubActivityDay {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface GitHubActivityWeek {
  weekIndex: number;
  days: GitHubActivityDay[];
  monthLabel?: string;
}

export interface GitHubUserProfile {
  username: string;
  name?: string;
  avatarUrl?: string;
  bio?: string;
  publicRepos?: number;
  totalContributions: number;
}
```

## 4. Acceptance Scenarios
1. **Header Placement**: GitHub icon appears directly where Help was previously placed, aligned with terminal and side-pane toggles.
2. **Click & Toggle Interaction**: The button uses a Radix `Popover` (instead of `HoverCard`). Moving the mouse cursor away does not dismiss the card. The card stays open until the user clicks the GitHub toggle button again or clicks the cross (`X`) close button inside the card header.
3. **Explicit Close Cross Button**: Header provides a dedicated cross (`Cancel01Icon`) button to close the popover cleanly, distinct from the account disconnect/logout action (`Logout01Icon`).
4. **Connect Flow**: If not connected, user can enter username or click connect. The connect form also includes a close cross button.
5. **Activity Display**: If connected, displays avatar, visible 3-month contributions count, and compact heatmap with weekday labels and day tooltips.
6. **Month & Year Navigation**: User can click Left/Right arrows to slide across months, and click years to view any historical year's 3-month windows.
7. **Disconnect Action**: User can disconnect or change account anytime using the logout action button.
8. **GitHub Account Login**: In the popover header next to the disconnect/close buttons, a "Login" button allows the user to log in to their GitHub account using a GitHub Personal Access Token (PAT) with `repo` and `read:user` access.
9. **Private Repositories & Private Contributions**:
   - When authenticated, queries both public and private repositories (`type=all`), displaying private repositories with a distinct "Private" badge.
   - Queries the official GitHub GraphQL API (`viewer.contributionsCollection`) to aggregate complete contribution counts and heatmap calendar cells including private repository commits, PRs, and reviews.
10. **Login Toast Feedback**: When user logs in, a toast notification confirms "GitHub account logged in successfully! Private repositories & contributions enabled."
11. **Arrow-Tip Button**: Once logged in, an arrow tip button (`ArrowRight01Icon`) is displayed in place of the login button.
12. **Side Pane Toggle Panel Opening**: Clicking the arrow button automatically opens/reveals the 3rd toggle panel (Side Pane) and activates the `github-repos` tab.
13. **Complete Repositories View**: In the Side Pane, user's repositories (both public and private) are displayed with search filtering, language tags, star/fork counts, and quick actions ("Open in GitHub", "Copy Clone URL").
14. **Login Dialog Layering & Auto-Closure Prevention**:
    - When "Login" is clicked, the "Login with GitHub" dialog rises to the foreground (`z-[101]`) above an elevated dark backdrop overlay (`z-[100]`), while the underlying activity popover is pushed to the background/underneath (`opacity-20`, `pointer-events-none`).
    - The Login Dialog enforces strict auto-closure prevention (`onPointerDownOutside`, `onInteractOutside`, `onEscapeKeyDown` prevented), ensuring switching windows to generate a token or moving the cursor does not dismiss the dialog. It only closes upon explicit "Cancel", top-right "X", or successful login submission.
    - Upon successful login, the dialog closes, and the background activity card returns to focus with updated private metrics and the side-pane arrow navigation button.
15. **GitHub CLI (`gh`) Authentication**:
    - The Login Dialog provides dual login methods: "GitHub CLI (gh)" and "Personal Access Token".
    - In GitHub CLI mode, users can copy `gh auth token` with 1 click, or click "Paste & Login" to automatically import their active `gh` CLI token (`gho_...`) from the system clipboard.
    - Full support for `gho_` tokens enables instant private repository and private heatmap access without visiting the browser to generate a token.




