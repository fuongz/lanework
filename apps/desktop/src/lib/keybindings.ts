/**
 * Every keyboard shortcut the app handles, for Settings › Keybindings.
 *
 * ⚠️ A LIST, not the source of the keys. The menu's accelerators live in
 * `electron/main/menu.ts` and each screen's in its own key handler; this
 * only says what they are. Adding or changing a shortcut means changing it
 * there AND here — `where` names the file, so the two can be checked.
 *
 * Keys are spelled the macOS way. The renderer's handlers take Ctrl for ⌘
 * off macOS (all but ⌘⇧M).
 */
export interface Keybinding {
  /** "Area: Action", the way the list sorts and reads. */
  command: string;
  /** One or more ways to press it: `["⌘`", "⌃`"]`. */
  keys: string[];
  /** When it works. */
  when: string;
  /** Where it is handled — for whoever changes it. */
  where: string;
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
    keys: ["⌘1…⌘9"],
    when: "Always",
    where: "project-switcher.tsx",
  },
  {
    command: "App: Hide Lanework",
    keys: ["⌘H"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "App: Hide Others",
    keys: ["⌥⌘H"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "App: Minimize",
    keys: ["⌘M"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "App: Quit",
    keys: ["⌘Q"],
    when: "Always",
    where: "electron/main/menu.ts",
  },

  {
    command: "Edit: Undo",
    keys: ["⌘Z"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Redo",
    keys: ["⇧⌘Z"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Cut",
    keys: ["⌘X"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Copy",
    keys: ["⌘C"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Paste",
    keys: ["⌘V"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Paste and Match Style",
    keys: ["⌥⇧⌘V"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Select All",
    keys: ["⌘A"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Edit: Emoji & Symbols",
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
    keys: ["⌘R"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Force Reload",
    keys: ["⇧⌘R"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Toggle Developer Tools",
    keys: ["⌥⌘I"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Actual Size",
    keys: ["⌘0"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Zoom In",
    keys: ["⌘+"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Zoom Out",
    keys: ["⌘−"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "View: Toggle Full Screen",
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
    keys: ["⌘T", "⌃⇧`"],
    when: "Always",
    where: "electron/main/menu.ts",
  },
  {
    command: "Terminal: Move Tab Left",
    keys: ["⌥⌘←"],
    when: "Terminal tab focused",
    where: "terminal-tab.tsx",
  },
  {
    command: "Terminal: Move Tab Right",
    keys: ["⌥⌘→"],
    when: "Terminal tab focused",
    where: "terminal-tab.tsx",
  },
  {
    command: "Terminal: Insert Newline",
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
    keys: ["⌘↩"],
    when: "New issue form",
    where: "new-issue.tsx",
  },
  {
    command: "Issues: Discard New Issue",
    keys: ["Esc"],
    when: "New issue form",
    where: "new-issue.tsx",
  },
  {
    command: "Issues: Save Issue",
    keys: ["⌘S"],
    when: "Issue with unsaved changes",
    where: "issue-detail.tsx",
  },
  {
    command: "Issues: Post Comment",
    keys: ["⌘↩"],
    when: "Comment editor",
    where: "issue-activity.tsx",
  },
  {
    command: "Issues: Cancel Comment Edit",
    keys: ["Esc"],
    when: "Editing a comment",
    where: "issue-activity.tsx",
  },

  {
    command: "Composer: Send Message",
    keys: ["↩"],
    when: "Composer focused",
    where: "composer.tsx",
  },
  {
    command: "Composer: New Line",
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
    command: "Changes: Commit",
    keys: ["⌘↩"],
    when: "Commit message",
    where: "commit-box.tsx",
  },

  {
    command: "Pull Requests: Send Comment",
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
    keys: ["⌘S"],
    when: "Skills or Config files editor",
    where: "agent-config-editor.tsx",
  },
  {
    command: "Settings: Close Tab",
    keys: ["⌘W"],
    when: "Skills or Config files",
    where: "agent-config-page.tsx",
  },
];
