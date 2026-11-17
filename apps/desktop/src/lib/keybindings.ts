// Every keyboard shortcut the app handles, for Settings › Keybindings.
//
// NOTE: A LIST, not the source of the keys. The menu's accelerators live in
// `electron/main/menu.ts` and each screen's in its own key handler; this only
// says what they are. Adding or changing a shortcut means changing it there
// AND here — `where` names the file, so the two can be checked.
//
// Keys are spelled the macOS way. The renderer's handlers take Ctrl for ⌘ off
// macOS (all but ⌘⇧M).

interface Keybinding {
  /** "Area: Action", the way the list sorts and reads. */
  command: string;
  /** One or more ways to press it: `["⌘`", "⌃`"]`. */
  keys: string[];
  /** When it works. */
  when: string;
  /** Where it is handled — for whoever changes it. */
  where: string;
  /**
   * The system's or Electron's own (Hide, Quit, Copy, Paste, Zoom, Reload,
   * Full Screen…), or a form's usual keys (↩ or ⌘↩ to send, Esc to cancel,
   * ⌘S to save): kept here so the list stays whole, but not shown in
   * Settings, which lists what Lanework itself adds.
   */
  standard?: true;
}

export const KEYBINDINGS: Keybinding[] = [
  // The app menu (menu.ts).
  {
    command: "App: Settings",
    keys: ["⌘,"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "App: Command Palette",
    keys: ["⌘K"],
    when: "Always",
    where: "command-palette.tsx",
  },
  {
    command: "App: Open Project 1–9",
    keys: ["⌥⌘1…⌥⌘9"],
    when: "Always",
    where: "project-switcher.tsx",
  },
  {
    command: "App: Switch Project",
    keys: ["⌘O"],
    when: "Always",
    where: "project-switcher.tsx",
  },
  {
    command: "Tabs: Go to Tab 1–8",
    keys: ["⌘1…⌘8"],
    when: "In a project",
    where: "session-tabs.tsx",
  },
  {
    command: "Tabs: Go to Last Tab",
    keys: ["⌘9"],
    when: "In a project",
    where: "session-tabs.tsx",
  },
  {
    command: "Tabs: Next Tab",
    standard: true,
    keys: ["⌃⇥", "⇧⌘]"],
    when: "In a project",
    where: "session-tabs.tsx",
  },
  {
    command: "Tabs: Previous Tab",
    standard: true,
    keys: ["⌃⇧⇥", "⇧⌘["],
    when: "In a project",
    where: "session-tabs.tsx",
  },
  {
    command: "Tabs: New Tab",
    keys: ["⌘T"],
    when: "In a project",
    where: "session-tabs.tsx",
  },
  {
    command: "Tabs: Close Tab",
    keys: ["⌘W"],
    when: "In a chat (asks first while its agent runs)",
    where: "conversation-view.stop.tsx",
  },
  {
    command: "App: Hide Lanework",
    standard: true,
    keys: ["⌘H"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "App: Hide Others",
    standard: true,
    keys: ["⌥⌘H"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "App: Minimize",
    standard: true,
    keys: ["⌘M"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "App: Quit",
    standard: true,
    keys: ["⌘Q"],
    when: "Always",
    where: "electron/main/menu.ts",
  },

  {
    command: "Edit: Undo",
    standard: true,
    keys: ["⌘Z"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Redo",
    standard: true,
    keys: ["⇧⌘Z"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Cut",
    standard: true,
    keys: ["⌘X"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Copy",
    standard: true,
    keys: ["⌘C"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Paste",
    standard: true,
    keys: ["⌘V"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Paste and Match Style",
    standard: true,
    keys: ["⌥⇧⌘V"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Select All",
    standard: true,
    keys: ["⌘A"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Emoji & Symbols",
    standard: true,
    keys: ["⌃⌘Space"],
    when: "Always",
    where: "electron/main/menu.ts",
  },

  {
    command: "View: Toggle Sidebar",
    keys: ["⌘B"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Reload",
    standard: true,
    keys: ["⌘R"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Force Reload",
    standard: true,
    keys: ["⇧⌘R"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Toggle Developer Tools",
    standard: true,
    keys: ["⌥⌘I"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Actual Size",
    standard: true,
    keys: ["⌘0"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Zoom In",
    standard: true,
    keys: ["⌘+"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Zoom Out",
    standard: true,
    keys: ["⌘−"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Toggle Full Screen",
    standard: true,
    keys: ["⌃⌘F"],
    when: "Always",
    where: "electron/main/menu.ts",
  },

  {
    command: "Terminal: Toggle Terminal",
    keys: ["⌘`", "⌃`"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Terminal: New Terminal",
    keys: ["⌃⇧`"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Terminal: Move Tab Left",
    standard: true,
    keys: ["⌥⌘←"],
    when: "Terminal tab focused",
    where: "terminal-tab.tsx",
  },
  {
    command: "Terminal: Move Tab Right",
    standard: true,
    keys: ["⌥⌘→"],
    when: "Terminal tab focused",
    where: "terminal-tab.tsx",
  },
  {
    command: "Terminal: Insert Newline",
    standard: true,
    keys: ["⇧↩"],
    when: "Terminal focused",
    where: "xterm-pane.tsx",
  },

  {
    command: "Issues: New Issue",
    keys: ["⌘N"],
    when: "Project open",
    where: "app-sidebar.tsx",
  },
  {
    command: "Issues: Create Issue",
    standard: true,
    keys: ["⌘↩"],
    when: "New issue form",
    where: "new-issue.tsx",
  },
  {
    command: "Issues: Discard New Issue",
    standard: true,
    keys: ["Esc"],
    when: "New issue form",
    where: "new-issue.tsx",
  },
  {
    command: "Issues: Save Issue",
    standard: true,
    keys: ["⌘S"],
    when: "Issue with unsaved changes",
    where: "issue-detail.tsx",
  },
  {
    command: "Issues: Post Comment",
    standard: true,
    keys: ["⌘↩"],
    when: "Comment editor",
    where: "issue-activity.tsx",
  },
  {
    command: "Issues: Cancel Comment Edit",
    standard: true,
    keys: ["Esc"],
    when: "Editing a comment",
    where: "issue-activity.tsx",
  },

  {
    command: "Composer: Send Message",
    standard: true,
    keys: ["↩"],
    when: "Composer focused",
    where: "composer.tsx",
  },
  {
    command: "Composer: New Line",
    standard: true,
    keys: ["⇧↩"],
    when: "Composer focused",
    where: "composer.tsx",
  },
  {
    command: "Composer: Dictation",
    keys: ["⌘⇧M"],
    when: "Composer or nothing focused",
    where: "composer.tsx",
  },
  {
    command: "Composer: Delete to Line Start",
    keys: ["⌘U"],
    when: "Composer focused",
    where: "composer.tsx",
  },
  {
    command: "Composer: Edit Last Queued Message",
    keys: ["↑"],
    when: "Empty composer, messages queued",
    where: "composer.tsx",
  },
  {
    command: "Composer: Accept Suggestion",
    standard: true,
    keys: ["↩", "⇥"],
    when: "Suggestions open",
    where: "composer.tsx",
  },

  {
    command: "Files: Go to File",
    keys: ["⌘P"],
    when: "Files",
    where: "files-layout.tsx",
  },
  {
    command: "Files: Search in Files",
    keys: ["⇧⌘F"],
    when: "Files",
    where: "files-layout.tsx",
  },
  {
    command: "Files: Back to the Tree",
    standard: true,
    keys: ["Esc"],
    when: "Search in Files",
    where: "files-search.tsx",
  },
  {
    command: "Files: Close Tab",
    keys: ["⌘W"],
    when: "Files, a file open",
    where: "files-layout.tsx",
  },
  {
    command: "Files: Expand Whole Folder",
    keys: ["⌥Click"],
    when: "File tree",
    where: "files-tree.tsx",
  },
  {
    command: "Commits: Show Changes",
    standard: true,
    keys: ["⇧⌘1"],
    when: "Commits view, terminal not focused",
    where: "git-tabs.tsx",
  },
  {
    command: "Commits: Show History",
    standard: true,
    keys: ["⇧⌘2"],
    when: "Commits view, terminal not focused",
    where: "git-tabs.tsx",
  },
  {
    command: "Commits: Previous or Next Tab",
    standard: true,
    keys: ["←", "→"],
    when: "Commits tabs focused",
    where: "git-tabs.tsx",
  },
  {
    command: "Changes: Commit",
    standard: true,
    keys: ["⌘↩"],
    when: "Commit message",
    where: "commit-box.tsx",
  },

  {
    command: "Pull Requests: Send Comment",
    standard: true,
    keys: ["⌘↩"],
    when: "Comment box",
    where: "comment-box.tsx",
  },

  {
    command: "Projects: Move Up",
    keys: ["⌥↑"],
    when: "Reordering projects",
    where: "project-reorder-list.tsx",
  },
  {
    command: "Projects: Move Down",
    keys: ["⌥↓"],
    when: "Reordering projects",
    where: "project-reorder-list.tsx",
  },

  {
    command: "Settings: Save File",
    standard: true,
    keys: ["⌘S"],
    when: "Skills or Config files editor",
    where: "agent-config-editor.tsx",
  },
  {
    command: "Settings: Close Tab",
    standard: true,
    keys: ["⌘W"],
    when: "Skills or Config files",
    where: "agent-config-page.tsx",
  },
];
