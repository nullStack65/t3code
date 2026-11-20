# T3 Code feature map

A site map of every feature as the user sees it. Use these ids and labels to name UI
precisely ("the **Settle thread** item in **sidebar.thread-menu**") instead of describing it.

Conventions:

- **area.feature** is a stable id, always written in bold. Quoted text is the exact visible label.
- Code formatting is only for routes, keybinding commands, keys and file names; `scripts/feature-map.test.ts` checks every backticked route and command against the code.
- `mod` is Command on macOS and Ctrl elsewhere. Defaults come from the built-in keybindings;
  "no default" means the command exists but is unbound until you bind it in
  **Settings → Keybindings**.
- Routes are web/desktop paths. Desktop shows the same pages inside its window.

## Top-level layout

- **layout.main-sidebar** — left column with threads and projects. Toggle with "Toggle main sidebar" or `sidebar.toggle` (`mod+b`).
- **layout.thread-view** — centre column: thread header, timeline and composer.
- **layout.right-panel** — tabbed "Workspace panel" on the right. "Toggle right panel", `rightPanel.toggle` (`mod+alt+b`).
- **layout.thread-details-panel** — thread details side panel. "Toggle thread details panel", `threadPanel.toggle` (`mod+shift+b`).
- **layout.terminal-drawer** — terminal drawer under the thread. "Toggle terminal drawer", `terminal.toggle` (`mod+j`).
- **layout.focus-cycle** — moves keyboard focus between sidebar, thread, composer and panels. "Focus Next Workspace Area" / "Focus Previous Workspace Area", `workspace.focusNext` (`f6`, `mod+f6`) and `workspace.focusPrevious` (`shift+f6`, `mod+shift+f6`).
- **layout.history** — back and forward through visited views. "Go back" / "Go forward", `navigation.back` (`mod+[`) and `navigation.forward` (`mod+]`); trackpad swipe on desktop.

## Sidebar

Code: apps/web/src/components/sidebar/

- **sidebar.new-thread** — "New thread". Starts a draft; opens the project picker when several projects are open. Shift-click starts in the current project. `chat.new` (`mod+n`, `mod+shift+o`).
- **sidebar.new-local-thread** — new thread in the current checkout instead of a new worktree. `chat.newLocal` (`mod+shift+n`).
- **sidebar.new-thread-without-project** — thread with its own scratch folder and no project. "New thread without a project", `chat.newWithoutProject` (`mod+alt+n`).
- **sidebar.search** — "Search threads" filters by title and message text ("Searching thread messages…"); "Clear thread search" resets it.
- **sidebar.project-filter** — "Filter threads by project", with "All projects", "Search projects" and "Show all projects".
- **sidebar.add-project** — "Add project". Opens the add-project flow (see `palette.add-project`).
- **sidebar.pinned-section** — "Pinned" threads, above active work.
- **sidebar.active-section** — "Active" threads in your saved order. Drag to reorder.
- **sidebar.working-section** — collapsed "Working" section for threads busy with background work. Turn off in **Settings → General → Working section**.
- **sidebar.snoozed-shelf** — "Snoozed" threads, hidden until their wake time.
- **sidebar.settled-shelf** — "Settled" finished threads. Drag a thread onto the header to settle it.
- **sidebar.bots-group** — "Bots" group for standing bot threads.
- **sidebar.project-folder** — per-project folders when **Settings → Labs → Boring sidebar (group by project)** is on; "Pin project" / "Unpin project", "Project settings".
- **sidebar.thread-row** — one thread: title, status, PR badge, hover actions. Click opens `/$environmentId/$threadId`. Drop files on it to attach them.
- **sidebar.thread-status** — row status labels: "Working", "Waiting", "Needs you", "Needs action", "Usage limit reached", "Failed", "Woke", "Unsent draft".
- **sidebar.thread-hover-actions** — "Settle", "Un-settle", "Wake" buttons; press and drag to apply to a range.
- **sidebar.draft-row** — unsent draft; "Discard draft" (with Undo).
- **sidebar.thread-menu** — right-click a thread row:
  "Rename thread", "Pin thread" / "Unpin thread", "Settle thread" / "Un-settle thread",
  "Snooze thread" (presets and "Custom…"), "Wake thread now", "Mark unread",
  "Regenerate title", "Auto-settle behavior" ("Follow settings", "Never"), "Route to inbox"
  ("Kameron", "Jeff", "Agents / neither founder"), "Make standing bot…" / "Make ordinary thread",
  "Edit bot persona…", "Share with guest", "Turn into project", "Copy path", "Copy thread ID",
  "Move up" / "Move down", "Archive thread", "Delete".
- **sidebar.thread-switch** — previous / next thread in list order. `thread.previous` (`mod+shift+[`), `thread.next` (`mod+shift+]`).
- **sidebar.thread-jump** — open the Nth listed thread. `thread.jump.<n>` (`mod+1`…`mod+9`, desktop only by default).
- **sidebar.pin-shortcut** — pin or unpin the current thread. `thread.pin` (`mod+shift+p`).
- **sidebar.settle-shortcut** — settle the current thread. `thread.settle` (`mod+shift+s`).
- **sidebar.undo** — "Undo" toast after pin, settle, snooze, archive or discard. `thread.undo` (`mod+z` outside text fields).
- **sidebar.update-pill** — "Update available" / "Check for updates" pill and "Update release notes"; provider update pill.
- **sidebar.footer** — "Settings", "Usage" and "Pull requests" links.

## Thread view

### Header

Code: apps/web/src/components/chat/ChatHeader.tsx

- **thread.breadcrumb** — "Thread breadcrumb": project and thread title; click the title to rename ("Thread title").
- **thread.lineage** — "Lineage" / "Related threads": "Parent thread", "Parent agent", "Subagent", "Side chats", "Fork", "Merge back to source conversation"; "More thread actions" opens the rest.
- **thread.project-actions** — "Project actions" / "Project scripts": run a project script, "Add action". Each script is `script.<id>.run` ("Run Script: …").
- **thread.open-in-editor** — "Open in editor" with "Choose editor". `editor.openFavorite` (`mod+o`).
- **thread.git-actions** — "Git actions": "Commit", "Push", "Publish repository", "Initialize Git", "Git action options".
- **thread.copy-reference** — copy the PR link, or the thread as a chip. "Pull Request: Copy Link or Thread", `thread.copyReference` (`mod+shift+c`).
- **thread.copy-pr-number** — copy `#123`. `pullRequest.copyNumber` (`mod+shift+k`).
- **thread.find** — "Find in thread" bar with "Previous match" / "Next match", "Show only messages from". `chat.find` (`mod+f`).
- **thread.regenerate-title** — new title from the conversation. `thread.regenerateTitle` (no default).

### Timeline

Code: apps/web/src/components/chat/MessagesTimeline.tsx

- **timeline.user-message** — your messages, with sender line and "Copy message".
- **timeline.assistant-reply** — agent replies with markdown, code blocks, math, Mermaid, file and thread links.
- **timeline.work-group** — collapsed tool calls and commands; "Show more" / "Show less".
- **timeline.approval** — "Command approval", "File change approval", "File read approval", "Permission request": "Approve", "Decline", "Always allow this session", "More approval options".
- **timeline.user-input** — agent questions: "Type your answer", "Previous question" / "Next question", "Submit answer" (one question) or "Submit answers".
- **timeline.proposed-plan** — "Proposed plan" card: "Expand plan" / "Collapse plan", "Plan actions", save to workspace.
- **timeline.minimap** — turn navigator: "Previous turn" / "Next turn".
- **timeline.background-work** — "Background work" details for subagents and monitors.
- **timeline.html-render** — HTML render dialog for agent-rendered pages.
- **timeline.selection-toolbar** — select reply text to quote or comment it into the composer.

### Banners

- **thread.banners** — provider status, errors, usage limits, server update and "Resume thread" banners above the composer.

## Composer

Code: apps/web/src/components/chat/ChatComposer.tsx

- **composer.editor** — prompt box ("Ask anything..."). `@` mentions "Files and folders" and threads; `/` opens "Commands" and "Skills".
- **composer.send** — "Send message". Enter or `mod+Enter` per **Settings → Chat → Send shortcut**.
- **composer.follow-up** — while a turn runs: "Queue message" or "Steer message" per **Follow-up behavior**. Opposite action: "Composer: Opposite Queue or Steer Action", `composer.sendAlternate` (`mod+enter`).
- **composer.send-background** — start the thread and open another draft. "Composer: Start in Background", `composer.sendBackground` (`mod+enter` in a new thread, `mod+alt+enter`).
- **composer.send-and-new** — send and open a fresh new-thread composer. "Composer: Send and Start New Thread", `composer.sendAndNewThread` (`mod+alt+enter`).
- **composer.stop** — "Stop generation" / "Interrupt". `thread.stop` (no default).
- **composer.queue** — queued messages: "Edit queued message", "Remove queued message". Send first as steer: "Queue: Send First Queued Message", `thread.steerQueuedMessage` (`mod+shift+enter`). Edit last: "Queue: Edit Last Queued Message", `thread.editQueuedMessage` (`alt+arrowup`).
- **composer.stash** — park the draft and restore later from "Stashed prompts". `composer.stash` (`mod+s`).
- **composer.attachments** — attach images and files by paste, drop or picker.
- **composer.dictation** — "Start voice input" / "Finish voice input" / "Cancel voice input". "Composer: Start or Finish Dictation", `composer.dictation` (`mod+shift+d`).
- **composer.model-picker** — "Choose model" (Shift-click for "Choose models" across providers). `modelPicker.toggle` (`mod+shift+m`); switch provider `modelPicker.previousProvider` (`mod+shift+arrowup`) / `modelPicker.nextProvider` (`mod+shift+arrowdown`); pick the Nth model `modelPicker.jump.<n>` (`mod+1`…`mod+9`).
- **composer.effort** — "Effort" / "Reasoning effort" picker. `composer.effort` (`mod+shift+e`); step with `composer.increaseEffort` / `composer.decreaseEffort` (no default).
- **composer.permissions** — "Permissions" mode picker. `composer.mode` (`mod+shift+a`).
- **composer.host** — "Run on" machine picker for a new thread, including "Auto balance" and "Add to another machine". `composer.host` (`mod+shift+h`); step to next machine `composer.cycleHost` (no default).
- **composer.workspace** — "Workspace" picker: "Current checkout", "New worktree", previous worktree. `composer.workspace` (`mod+shift+x`); reuse previous worktree `composer.previousWorktree` (`mod+shift+l`).
- **composer.branch** — "Branch" picker; "Copy branch name". `composer.branch` (`mod+shift+g`).
- **composer.more-controls** — "More composer controls" overflow on narrow widths.
- **composer.compaction** — "Compact and send" / "Skip compaction and send this message" when context is long.
- **composer.draft-hero** — new-thread heading with project picker and "No project".

## Right panel

Code: apps/web/src/rightPanelStore.ts

Tabs sit in the "Workspace panel". "Add panel surface" / "Open a surface" (`rightPanel.new`, `mod+t` while open) adds a tab. Tab menu: "Rename", "Close", "Close others", "Close to the right", "Close all", "Mute tab".

- **panel.maximize** — "Maximize panel" / "Restore panel size". `rightPanel.toggleMaximized` (no default).
- **panel.close** — close the active tab. `rightPanel.close` (`mod+w`).
- **panel.reopen** — "Reopen Closed Tab". `view.reopenClosed` (`mod+shift+t`).
- **panel.diff** — "Diff" tab: "Uncommitted", "Latest turn", per-turn and commit changes; "Split diff view" / "Stacked diff view", "Hide whitespace changes", "Show file tree", "Expand all files". `diff.toggle` (`mod+d`).
- **panel.files** — "Files" tab: "File explorer" and file preview (code, images, PDF, Office, archives); "Add to chat". Quick open: "File picker" / "Go to file", `filePicker.toggle` (`mod+p`). Content search: "Search project contents", `projectSearch.toggle` (`mod+shift+f`).
- **panel.browser** — "Browser" preview tab: "Search or enter URL", "Back", "Forward", "Refresh", "Annotate preview", "Capture screenshot", recording, "Float preview over chat", "Pop into separate window", "Open in system browser". Keys: `preview.toggle` (`mod+shift+j`), `preview.refresh` (`mod+r`), "Preview: Focus URL" `preview.focusUrl` (`mod+l`), `preview.zoomIn` (`mod+=`), `preview.zoomOut` (`mod+-`), `preview.resetZoom` (`mod+0`), "Preview: Find on Page" `preview.find` (`mod+f`).
- **panel.device** — "Device" tab: watch an iOS Simulator or Android Emulator; "Device host".
- **panel.terminal** — "Terminal" tab version of a terminal.
- **panel.pull-request** — "Pull request" tab for the thread's PR, with a Code tab of its diff.
- **panel.pull-requests** — "Pull requests" tab: "Linked pull requests".
- **panel.side-chat** — "Side chat": a side conversation about the thread; "Close side chat", "Delete side chat".

## Thread details panel

Code: apps/web/src/components/chat/ThreadDetailsPanel.tsx

- **details.summary** — "Thread details": branch, workspace, PR rows, usage.
- **details.automations** — "Automations" for the thread; "Manage scheduled tasks".
- **details.servers** — "Servers" the thread started; stop them.
- **details.version-control** — "Version Control" status.

## Terminal drawer

Code: apps/web/src/components/ThreadTerminalDrawer.tsx

- **terminal.drawer** — per-thread shells. `terminal.toggle` (`mod+j`).
- **terminal.new** — "New Terminal". `terminal.new` (`mod+n` in a terminal).
- **terminal.split** — "Split Terminal Horizontally" `terminal.split` (`mod+d` in a terminal); "Split Terminal Vertically" `terminal.splitVertical` (`mod+shift+d` in a terminal). Layout: "Single", "Side by side", "Stacked".
- **terminal.close** — "Close Terminal". `terminal.close` (`mod+w` in a terminal).
- **terminal.context-menu** — "Copy", "Paste", "Select all", "Add to chat", "Jump to latest".

## Command palette and pickers

Code: apps/web/src/components/CommandPalette.tsx

- **palette.open** — "Command palette": search commands, projects and threads; start with `>` for actions only. `commandPalette.toggle` (`mod+k`).
- **palette.new-thread-in** — "New thread in..." a chosen project, or "No project".
- **palette.add-project** — "Add project" / "New project": "Add existing project" ("Browse a folder on disk"), "Clone from a remote URL" ("Git URL"), "Start a new Git repository from a name", "Open WSL folder".
- **palette.thread-actions** — "Copy thread", "Copy prompt link", "Copy prompt link with repo and model", "Share with guest", "Link pull request to thread", "Show linked pull requests", "Restart agent session".
- **palette.navigation** — "Open settings", "Open usage", "Open pull requests", "Project settings", "Connect an environment", "Triage an issue".
- **palette.theme** — "Change theme" `theme.select` (`mod+alt+a`); "Change appearance" (Light / Dark / System) `appearance.cycle` (`mod+alt+shift+a`); "Toggle theme editor" `themeEditor.toggle` (`mod+alt+shift+t`).

## Top-level pages

- **page.home** — `/`. Empty state with recent work, or the no-projects hero ("Add project").
- **page.thread** — `/$environmentId/$threadId`. One thread on one environment.
- **page.draft** — `/draft/$draftId`. An unsent new thread.
- **page.new-thread-link** — `/new`. Opens a prompt link as a new draft ("Opening the link...", "This link is open", "Could not open the link"); may clone the repo first ("Check out").
- **page.thread-link** — `/threads/$environmentId/$threadId`. Shareable thread link that redirects to the thread.
- **page.project-link** — `/projects/$projectKey`. Project link that redirects to that project's settings.
- **page.pull-requests** — `/pull-requests`. "Pull requests" across servers: filters "Authored", "Reviewing", "Blocked on me", "Open", "Merged", "Closed"; "Sort pull requests". Opened from the sidebar or "Open pull requests".
- **page.usage** — `/usage`. "Usage" for cost, tokens and limits. `usage.open` (`mod+u`). On the page: "Cost" `usage.cost` (`c`), "Tokens" `usage.tokens` (`t`), "Limits" `usage.limits` (`l`); "Usage period" `usage.period.day` (`mod+shift+1`), `usage.period.week` (`mod+shift+2`), `usage.period.month` (`mod+shift+3`), `usage.period.quarter` (`mod+shift+4`); "Refresh usage".

## Settings

Code: apps/web/src/components/settings/

Open with "Settings" in the sidebar or "Open settings". `/settings` opens the default section. The left nav has "Search settings" and these sections, in order.

Preferences:

- **settings.general** — `/settings/general`, "General": startup, new threads, "Working section", update checks, background activity.
- **settings.appearance** — `/settings/appearance`, "Appearance": "Color scheme", "Themes", "Contrast", "Glass opacity", fonts, "Chat width".
- **settings.chat** — `/settings/chat`, "Chat": "Send shortcut", "Follow-up behavior", "Rich text composer", "Tool calls in chat", "Response streaming".
- **settings.diffs** — `/settings/diffs`, "Diffs & pull requests": "Diff layout", "Hide whitespace changes", "Default merge method", "Open pull requests in T3 Code".
- **settings.keybindings** — `/settings/keybindings`, "Keybindings": every command with its default, grouped "Navigation", "Threads", "Composer", "Terminal", "Preview & diff", "Appearance", "Project scripts", "Other".
- **settings.voice** — `/settings/voice`, "Voice": "Transcribe with", "Microphone", "Dictation shortcut", "Dictionary", "Test microphone".
- **settings.snap-shot** — `/settings/snap-shot`, "SnapShots": "Capture shortcut", "Capture sound", "Include app text".

Agents:

- **settings.providers** — `/settings/providers`, "Providers": agent installs, accounts, "Usage providers", "Text generators".
- **settings.threads** — `/settings/threads`, "Threads": "Auto-settle inactive threads", "Auto-settle merged threads", "Keep threads with a PR", "Thread notifications", "Thread title instructions".
- **settings.browser** — `/settings/browser`, "Browser": "Browser profiles", "Agent browser access", default viewport, zoom and appearance, "Open links in".
- **settings.devices** — `/settings/devices`, "Devices": "Device sources", "Agents can use devices", "Local simulators".
- **settings.scheduled-tasks** — `/settings/scheduled-tasks`, "Scheduled tasks": recurring and one-off agent runs.

Code:

- **settings.projects** — `/settings/projects`, "Projects": "Project overview", "Default model", "Permissions", "Actions", per-project overrides.
- **settings.source-control** — `/settings/source-control`, "Source control": "Git fetch interval", "Automatically pull", "Commit and pull request writing", "Review guides (beta)".
- **settings.worktrees** — `/settings/worktrees`, "Worktrees": "Worktree location", "Worktree cleanup", "Worktree branch naming".

Connections:

- **settings.connections** — `/settings/connections`, "Environments": "This machine", "Linked environments", "Network access", "Tailscale HTTPS", "T3 Connect", "Load balancing".
- **settings.access** — `/settings/access`, "Sharing & access": paired devices, "Guest links", "Require approval for new devices".
- **settings.secrets** — `/settings/secrets`, "Secrets" (only when secrets are enabled).

More:

- **settings.maintenance** — `/settings/maintenance`, "Maintenance": "Artifacts and logs", storage cleanup, diagnostics.
- **settings.diagnostics** — `/settings/diagnostics`, "Diagnostics"; shown under Maintenance in the nav.
- **settings.labs** — `/settings/labs`, "Labs": experiments such as "Boring sidebar (group by project)".
- **settings.about** — `/settings/about`, "About": "Version", "Update track", "t3 command", "Mobile app", "Welcome page", "Privacy policy".
- **settings.open-source-licenses** — `/settings/open-source-licenses`, "Open source licenses"; shown under About in the nav.
- **settings.archived** — `/settings/archived`, "Archive": archived threads and projects; unarchive.

Old links that redirect:

- **settings.legacy-beta** — `/settings/beta` now goes to Labs.
- **settings.legacy-integrations** — `/settings/integrations` now goes to Browser.
- **settings.legacy-storage** — `/settings/storage` now goes to Maintenance.

## Onboarding, pairing and connect pages

- **onboard.welcome** — `/welcome`, "Welcome": "Set up an agent" (Codex, Claude Code), "Import projects and their threads", "Set up T3 Connect", mobile app pointer.
- **onboard.pair** — `/pair`, "Pair with this environment": "Paste a one-time token or pairing secret".
- **onboard.connect** — `/connect`, "Authorization request", "Connecting your terminal": approves a `t3` CLI sign-in through T3 Connect.
- **onboard.connect-agent** — `/connect-agent`, "Agent sign-in", "Connect <client>": lets an outside agent connect. Reached from the code made by "Use T3 Code in another app (MCP)".
- **onboard.approve-agent** — `/approve-agent`, "Agent sign-in": "Choose what it may do", "Read only", "Continue", "Deny".
- **onboard.guest** — `/guest`, guest view of a shared thread: "Message", "Attach files", "Send", "Waiting for approval", "This link has ended".

## Desktop-only shell

Code: apps/desktop/src/

- **desktop.app-menu** — native menus "File", "Edit", "View", Window, Help; "Settings...", "Check for Updates...", "Close Window", "Reload", "Force Reload", "Toggle Developer Tools", "Actual Size", "Zoom In", "Zoom Out".
- **desktop.context-menu** — "Copy Link", "Copy Image", "Copy Email Address", "Paste as Text", spelling suggestions.
- **desktop.auto-update** — update download and install from the sidebar pill and "Check for Updates...".
- **desktop.backend-picker** — where the bundled server runs: "This machine", "WSL", "SSH", "Remote environment".
- **desktop.preview-window** — popped-out and floating preview windows ("Open separate preview window").
- **desktop.snap-shot** — global SnapShot capture shortcut.
- **desktop.thread-jumps** — `thread.jump.<n>` defaults apply only on desktop.

## Mobile app

Code: apps/mobile/src/features/

- **mobile.home** — thread list: "Search threads", "Filter threads by project", "Filter threads by environment", "All projects", "All environments", "Reset thread filters".
- **mobile.navigation** — tablet sidebar and tabs: "Home", "Pull requests", "Settings", "New chat", "Edit navigation tabs", "Hide sidebar".
- **mobile.thread** — thread and composer: "Ask anything", "Add attachment", approvals ("Allow once", "Allow session"), "Arrange threads…", "Auto-settle behavior", "Branches & worktrees".
- **mobile.voice-input** — "Start dictation", "Finish dictation", "Cancel dictation".
- **mobile.review** — "Review changes": "Changed files", "Uncommitted", "Latest turn", "Add Comment", "Back to chat".
- **mobile.files** — "Files": browse, preview, "Copy path", "Add to chat".
- **mobile.terminal** — "Terminal": "Open new terminal", "Attach output", "Text size", "Show keyboard".
- **mobile.browser** — "Browser" tabs: "Enter a URL", "Back", "Forward", "Hard reload", "Clear cookies".
- **mobile.devices** — "Devices": "View device", "Rotate device", "Shut down device".
- **mobile.pull-requests** — "Pull requests": filters ("All PRs", "All states", "All checks"), "Approve", "Add review comment", "Changed files".
- **mobile.projects** — "Add project": "Add existing project", "Clone project", "Create project".
- **mobile.connection** — "Environments": "Add environment", "Pairing code", QR scan, "Reconnect environment", device "Approve" / "Deny".
- **mobile.cloud** — T3 Connect: "Set up T3 Connect", "Managed tunnel", "Deregister".
- **mobile.usage** — "Usage": "Cost", "Limits", "Past 7 days", "Past 30 days", "By model".
- **mobile.archive** — "Archived threads": "Search archived threads", "Unarchive".
- **mobile.settings** — "Settings": "Appearance", "Agents", "Actions", "About", provider accounts.
- **mobile.keyboard-palette** — iPad hardware keyboard palette: "New thread in…", "Go to file", "Open terminal", "Review changes", "Copy PR link or thread".
- **mobile.prompt-links** — "Prompt from a link": "Use without project", "Keep mine", "Replace".
- **mobile.sharing** — share sheet import into a thread: "Retry import", "Cancel import".
- **mobile.triage** — "Triage": start an issue triage thread.
- **mobile.notifications** — "Agent alerts" and "Agent work in progress" (Live Activity).
- **mobile.updates** — "Update ready": "Install Now", "Later".
- **mobile.diagnostics** — "Diagnostics": "Crash reports", "Copy crash report".

## Unverified

- "New thread in this worktree" (branch toolbar) is in docs/user/thread-sidebar.md but the exact string was not found in source; left out of the entries.
- "or start without a project" is from docs; not found as a literal (probably split across markup); left out.
- **layout.history** trackpad swipe is from component names, not a visible label.
- **sidebar.footer** link placement ("Settings", "Usage", "Pull requests") is inferred from sidebar strings, not traced to one footer component.
- Snooze preset labels and "Wake thread now" vs "Wake thread": both strings exist; which one shows where was not traced.
- "Window" and "Help" desktop menus come from Electron menu roles, so the label is Electron's, not a string in source.
- **desktop.backend-picker** labels come from desktop menu/backend lists; where they show was not traced.
- **palette.navigation** "Open pull requests" may be the PR panel or the page; not traced.
- Settings rows quoted under each section come from the settings search index; a few may sit in a sub-panel or show only on some platforms.
