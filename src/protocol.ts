// The panel <-> worker contract: src/panel.tsx asks, src/worker.ts answers.
export {}

export type View = 'ready' | 'in_progress' | 'open' | 'closed'

export interface Issue {
  id: string
  title: string
  status: string
  priority: number
  issue_type: string
  assignee?: string
  description?: string
  design?: string
  acceptance_criteria?: string
  notes?: string
}

/** The Orca worktree working on a task. */
export interface Link {
  worktreeId: string
  name: string
}

declare module 'orca' {
  interface PluginRequests {
    /** Project name → its folder. */
    'projects.list': { output: Record<string, string> }
    /** Adds the beads project containing `dir`; answers its name. */
    'projects.add': { input: { dir: string; name?: string }; output: { name: string } }
    'projects.remove': { input: { name: string }; output: { ok: true } }
    /** The project containing the focused worktree, added on the spot if it's new; null outside one. */
    'projects.focused': { output: { name: string | null } }
    'issues.list': { input: { project: string; view: View }; output: { issues: Issue[]; links: Record<string, Link> } }
    /** create, update, close and reopen. */
    'issues.run': { input: { project: string; args: string[] }; output: { ok: true } }
    /** Claims the task and creates a worktree named after it, with an agent working on it. */
    'issues.start': { input: { project: string; id: string }; output: { name: string; warning?: string } }
    'worktrees.focus': { input: { project: string; worktreeId: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** Posted after a change, so every open panel reloads. */
    'issues.changed': { project: string }
  }
}
