# orca-beads

An [Orca](https://github.com/stablyai/orca) plugin for [beads](https://github.com/steveyegge/beads) (`bd`) task tracking:

- **Sidebar panel**: the whole board, in Orca's right sidebar. It shows the project of the worktree you're focused on, and switches when you move. Ready, In progress, Open and Closed tabs; filter, expand details, claim, close, reopen and create tasks. In-progress tasks show the worktree working on them.
- **Start**: one click on a task claims it and creates an Orca worktree named after it, with an agent already working on it. The task's card then links to that worktree.
- **Commands**: `Beads: Show Panel` and `Beads: Show Ready Work` (a notification with your top ready tasks).

<img width="1811" height="1248" alt="Screenshot 2026-10-23 at 2 22 19 p m" src="https://github.com/user-attachments/assets/d7f4dbe5-3a34-48e0-811a-62f7f7ee2be2" />





## Requirements

- Orca 1.4.247 or later
- `bd` on your machine (looked up on `PATH`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`)

## Install

1. Clone this repo anywhere, e.g. `git clone https://github.com/<you>/orca-beads ~/code/orca-beads`.
2. In Orca, open **Settings → Plugins** and turn on **Plugin system** (it's experimental).
3. Under **Development**, add the folder you cloned into.
4. Click **Review & enable** on Beads and approve its permissions: notifications, reading the focused worktree's name, branch and terminals (used to show its project), and its own storage and settings.
5. Open the **Beads** panel in the right sidebar and focus a worktree of a beads project: the panel adds that project the first time. To add others, open **Projects** in the panel and paste the path of any folder inside a beads project.

To get keyboard shortcuts, bind the two commands in Orca's keyboard shortcut settings, under Plugins.

## How it works

- `src/panel.tsx` is a [components panel](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-declarative-ui.md): sandboxed, so it asks the plugin's worker, `src/worker.ts`, to run `bd` and the `orca` CLI for it. `src/protocol.ts` types what they say to each other. Orca transpiles both on load; there's no build step, and saving a file reloads it.
- The panel follows the focused worktree: it shows the beads project containing it (git worktrees of a repo share its project), or a configured project inside it, for monorepos whose `.beads` lives in a subfolder. It refreshes every 15 seconds while visible, and right away after a change from any open panel.
- **Start** runs `orca worktree create` in the project's Orca repo (so the project must be added to Orca), named after the task id and with an agent prompted to `bd show` it. If the worktree can't be created, the claim is undone. A task is linked to any worktree of its repo whose name, branch or comment begins with the task id, so worktrees you make by hand link up too if you name them that way. The button with the worktree's name on a card switches Orca to it.
- Your project list is kept in the plugin's own Orca storage, outside this folder (a `config.json` from older versions is imported once). Which agent Start launches is the **Agent for Start** setting under Beads in Orca's Settings (default `claude`; any id `orca agent launch --agent` accepts).
- `orca plugin test .` runs `src/panel.test.tsx`; `orca plugin check .` renders the panel with the real worker.
