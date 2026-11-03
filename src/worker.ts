// The plugin's worker: runs `bd` and the `orca` CLI for the panel. It runs in Node with the
// user's access, which the sandboxed panel doesn't have.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Issue, Link, View } from './protocol'

// GUI-launched Orca hands plugins a thin PATH; bd and Orca's shell command usually live in one of
// these. The macOS app bundle's CLI goes ahead of /usr/local/bin, where Orca's shell command can be a
// symlink the user can't read.
const PATH = `${process.env.PATH}:/Applications/Orca.app/Contents/Resources/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin`
const expand = (dir: string) => dir.replace(/^~(?=\/|$)/, homedir())
const run = promisify(execFile)

const VIEWS: Record<View, string[]> = {
  ready: ['ready', '-n', '0'],
  in_progress: ['list', '-s', 'in_progress', '-n', '0'],
  open: ['list', '-s', 'open', '-n', '0'],
  closed: ['list', '-s', 'closed', '-n', '50'],
}
const WRITES = new Set(['create', 'update', 'close', 'reopen'])

async function bd(dir: string, args: string[]): Promise<any> {
  try {
    const { stdout } = await run('bd', ['-C', expand(dir), ...args, '--json'], { env: { ...process.env, PATH }, maxBuffer: 64 << 20 })
    return stdout.trim() ? JSON.parse(stdout) : null
  } catch (e: any) {
    throw new Error((e.stderr || e.message).trim())
  }
}

// Failures still print JSON on stdout; surface Orca's own message rather than "Command failed".
async function orcaJson(args: string[], opts = {}): Promise<any> {
  try {
    return JSON.parse((await run('orca', [...args, '--json'], { env: { ...process.env, PATH }, maxBuffer: 64 << 20, ...opts })).stdout).result
  } catch (e: any) {
    let error
    try { error = JSON.parse(e.stdout).error } catch {}
    throw new Error(error?.data?.nextSteps?.[0] ?? error?.message ?? e.message)
  }
}

// Orca worktrees of a project's repo. Cached briefly, since the panel asks on every load.
let worktreeCache: { at: number; list: Promise<any[]> | null } = { at: 0, list: null }
async function projectWorktrees(dir: string) {
  if (Date.now() - worktreeCache.at > 5000) worktreeCache = { at: Date.now(), list: orcaJson(['worktree', 'list', '--limit', '1000']).then((r) => r.worktrees) }
  const list = await worktreeCache.list!
  const repoId = list.find((w) => w.path === expand(dir))?.repoId
  return { repoId, worktrees: list.filter((w) => repoId && w.repoId === repoId && !w.isArchived) }
}

// A worktree belongs to a task when its name, branch or comment's first word is the task id
// (Start names it that). Ids nest (bd-1 vs bd-1.2), so match the whole id only.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const worktreeFor = (worktrees: any[], id: string) => {
  const re = new RegExp(`(^|[^\\w.])${escapeRe(id)}($|[^\\w.])`)
  return worktrees.find((w) => re.test(`${w.displayName} ${w.branch.replace(/^refs\/heads\//, '')} ${w.comment.split(/\s/)[0]}`))
}

export default function activate(orca: OrcaWorkerApi): void {
  // Projects used to live in config.json in the plugin folder; carry them over once.
  async function projects(): Promise<Record<string, string>> {
    const stored = (await orca.storage.get('projects')) as Record<string, string> | null
    if (stored) return stored
    const legacy = new URL('../config.json', import.meta.url)
    const imported = existsSync(legacy) ? JSON.parse(readFileSync(legacy, 'utf8')).projects ?? {} : {}
    await orca.storage.set('projects', imported)
    return imported
  }
  async function projectDir(project: string) {
    const dir = (await projects())[project]
    if (!dir) throw new Error(`Unknown project ${project}`)
    return dir
  }
  const changed = (project: string) => orca.panels.post('issues.changed', { project })

  async function addProject(dir: string, name?: string) {
    // `bd where` walks up to the .beads directory, so any folder inside the project works.
    const where = await bd(dir.trim(), ['where'])
    const all = await projects()
    name = name?.trim() || where.prefix
    if (all[name!]) throw new Error(`A project named "${name}" already exists`)
    await orca.storage.set('projects', { ...all, [name!]: dirname(where.path) })
    return { name: name! }
  }

  // `--worktree active` resolves from cwd, and this worker runs outside any worktree, so find the
  // focused worktree's path through one of its terminals.
  async function focusedPath() {
    const ctx = await orca.host.call('workspace.readContext')
    const handle = ctx?.terminals[0]?.id
    const term = handle && (await orcaJson(['terminal', 'show', '--terminal', handle]).catch(() => null))?.terminal
    return (term?.worktreePath as string | undefined) ?? null
  }

  orca.panels.handle('projects.list', () => projects())
  orca.panels.handle('projects.add', ({ dir, name }) => addProject(dir, name))
  orca.panels.handle('projects.remove', async ({ name }) => {
    const { [name]: _, ...rest } = await projects()
    await orca.storage.set('projects', rest)
    return { ok: true as const }
  })

  orca.panels.handle('projects.focused', async () => {
    const path = await focusedPath()
    if (!path) return { name: null }
    const all = await projects()
    const where = await bd(path, ['where']).catch(() => null)
    if (!where) {
      // `bd where` only walks up, so a worktree whose project lives in a subfolder (a monorepo
      // service) misses it; fall back to a configured project inside the worktree.
      const root = path.replace(/\/+$/, '') + '/'
      return { name: Object.keys(all).find((n) => expand(all[n]).startsWith(root)) ?? null }
    }
    const name = Object.keys(all).find((n) => expand(all[n]) === dirname(where.path))
    return name ? { name } : addProject(dirname(where.path))
  })

  orca.panels.handle('issues.list', async ({ project, view }) => {
    const dir = await projectDir(project)
    const issues: Issue[] = (await bd(dir, VIEWS[view])) ?? []
    const links: Record<string, Link> = {}
    if (view !== 'closed') {
      // Links are a nicety: none when Orca can't be reached.
      const { worktrees } = await projectWorktrees(dir).catch(() => ({ worktrees: [] as any[] }))
      for (const i of issues) {
        const w = worktreeFor(worktrees, i.id)
        if (w) links[i.id] = { worktreeId: w.id, name: w.displayName }
      }
    }
    return { issues, links }
  })

  orca.panels.handle('issues.run', async ({ project, args }) => {
    if (!WRITES.has(args[0])) throw new Error(`bd ${args[0]} isn't allowed`)
    await bd(await projectDir(project), args)
    changed(project)
    return { ok: true as const }
  })

  // Start: claim the task, then give it its own worktree with an agent working on it.
  orca.panels.handle('issues.start', async ({ project, id }) => {
    const dir = await projectDir(project)
    const [issue] = await bd(dir, ['show', id])
    if (issue.status === 'closed') throw new Error(`${issue.id} is closed`)
    const { repoId, worktrees } = await projectWorktrees(dir)
    if (!repoId) throw new Error(`${dir} isn't a repo in Orca yet. Add it in Orca, then try again.`)
    if (worktreeFor(worktrees, issue.id)) throw new Error(`${issue.id} already has a worktree`)
    await bd(dir, ['update', issue.id, '--claim'])
    const agent = ((await orca.host.call('settings.get'))?.agent as string) || 'claude'
    try {
      // The prompt carries only the id: task text can come from collaborators, so the agent reads it through bd.
      await orcaJson([
        'worktree', 'create', '--repo', `id:${repoId}`, '--name', issue.id, '--no-parent',
        '--comment', `${issue.id} ${issue.title}`.slice(0, 200),
        '--agent', agent, '--prompt', `Work on beads issue ${issue.id}. Run \`bd show ${issue.id}\` for the details; it's claimed for you.`,
      ], { timeout: 120_000 })
    } catch (e: any) {
      // A timeout or an agent that fell back can still leave a worktree behind; keep the claim then.
      worktreeCache.at = 0
      const made = await projectWorktrees(dir).then(({ worktrees }) => worktreeFor(worktrees, issue.id), () => null)
      if (made) return { name: made.displayName, warning: e.message }
      // Undo the claim made here, so the task goes back to ready.
      if (issue.status === 'open') await bd(dir, ['update', issue.id, '-s', 'open', '-a', ''])
      throw new Error(`Could not create a worktree for ${issue.id}: ${e.message}`)
    } finally {
      changed(project)
    }
    worktreeCache.at = 0
    const { worktrees: now } = await projectWorktrees(dir)
    return { name: worktreeFor(now, issue.id)?.displayName ?? issue.id }
  })

  // Go to a task's worktree by bringing up one of its terminals (Orca creates one with every worktree).
  orca.panels.handle('worktrees.focus', async ({ project, worktreeId }) => {
    const { worktrees } = await projectWorktrees(await projectDir(project))
    if (!worktrees.some((w) => w.id === worktreeId)) throw new Error('That worktree is gone')
    const { terminals } = await orcaJson(['terminal', 'list', '--worktree', `id:${worktreeId}`])
    const live = terminals.find((t: any) => t.connected && !t.orphaned)
    if (live) await orcaJson(['terminal', 'switch', '--terminal', live.handle])
    else await orcaJson(['terminal', 'create', '--worktree', `id:${worktreeId}`, '--focus'])
    return { ok: true as const }
  })

  orca.commands.register('open-panel', () => orcaJson(['plugin', 'open', 'awallsr.beads']))

  orca.commands.register('ready', async () => {
    // ponytail: notifies for the first project; the panel has the switcher.
    const [project] = Object.entries(await projects())
    if (!project) {
      await orca.host.call('notifications.show', { title: 'Beads: no projects yet', body: 'Open the Beads panel and add a beads project.' })
      return
    }
    const issues: Issue[] = await bd(project[1], ['ready'])
    await orca.host.call('notifications.show', {
      title: `${issues.length} ready in ${project[0]}`.slice(0, 120),
      body: (issues.slice(0, 8).map((i) => `P${i.priority} ${i.id} ${i.title}`).join('\n') || 'Nothing ready').slice(0, 1000),
    })
  })
}
