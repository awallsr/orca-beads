# orca-beads

An [Orca](https://github.com/stablyai/orca) plugin for [beads](https://github.com/steveyegge/beads) (`bd`) task tracking:

- **Sidebar panel**: in-progress and ready tasks for each of your beads projects, at a glance, updating live.
- **Board**: a full task board in Orca's built-in browser. Switch projects, filter, expand details, claim, close, reopen and create tasks.
- **Commands**: `Beads: Open Board` and `Beads: Show Ready Work` (a notification with your top ready tasks).

<img width="1811" height="1248" alt="Screenshot 2026-10-23 at 2 22 19 p m" src="https://github.com/user-attachments/assets/d7f4dbe5-3a34-48e0-811a-62f7f7ee2be2" />





## Requirements

- Orca 1.4 or later
- `bd` on your machine (looked up on `PATH`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`)

## Install

1. Clone this repo anywhere, e.g. `git clone https://github.com/<you>/orca-beads ~/code/orca-beads`.
2. In Orca, open **Settings → Plugins** and turn on **Plugin system** (it's experimental).
3. Under **Development**, add the folder you cloned into.
4. Click **Review & enable** on Beads and approve its permissions: notifications, agent status events (used to start the board server automatically), and reading the focused worktree's name and branch (used to open the board there).
5. Run **Beads: Open Board** from the command palette, click **Projects**, and paste the path of any folder inside a beads project. Add as many as you like.

To get keyboard shortcuts, bind the two commands in Orca's keyboard shortcut settings, under Plugins.

## How it works

- `server.mjs` is a small local server on `127.0.0.1:7337`. It serves the board, runs whitelisted `bd` commands for it, and rewrites `panel.html` every 15 seconds when tasks change. The plugin starts it on demand and it keeps running in the background; its log is at `$TMPDIR/orca-beads.log`.
- `panel.html` is committed as a placeholder (Orca refuses to enable a plugin whose declared panel file is missing) and the server overwrites it with your tasks. If you work on the plugin, run `git update-index --skip-worktree panel.html` so your tasks never end up in a commit.
- Orca plugin panels are sandboxed with no network access, so the sidebar panel is a static snapshot. Orca reloads dev plugin panels whenever a file in the plugin folder changes, which is what makes the snapshot update live.
- Your project list is saved in `config.json` (git-ignored). You can also set `"port"` there.

## Security

The server binds to loopback only, rejects requests whose `Host` isn't loopback (blocks DNS rebinding), and only accepts JSON POSTs (so other websites can't submit forms to it). It only runs a fixed set of `bd` subcommands against projects you've added.
