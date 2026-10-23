// Orca plugin worker: starts the board server on demand and exposes palette commands.
import { spawn, execFile } from 'node:child_process'
import { openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadConfig } from './config.mjs'

const root = new URL('.', import.meta.url)
const base = () => `http://127.0.0.1:${loadConfig().port}`
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'

const healthy = () => fetch(`${base()}/healthz`).then((r) => r.ok, () => false)

async function ensureServer() {
  if (await healthy()) return
  // Detached so the board outlives this worker (Orca reaps idle workers after 5 min).
  // The worker already runs with ELECTRON_RUN_AS_NODE=1, so execPath behaves as node.
  const log = openSync(join(tmpdir(), 'orca-beads.log'), 'a')
  spawn(process.execPath, [fileURLToPath(new URL('server.mjs', root))], { detached: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await healthy()) return
  }
  throw new Error(`beads board did not start; see ${join(tmpdir(), 'orca-beads.log')}`)
}

export default function activate(orca) {
  // Any agent activity wakes this worker; use it to keep the board + sidebar snapshot running.
  orca.events.on('agent.status.changed', ensureServer)

  orca.commands.register('open-board', async () => {
    try {
      await ensureServer()
      // `--worktree active` resolves from cwd, and this worker runs outside any worktree,
      // so name the focused worktree by branch instead.
      const ctx = await orca.host.call('workspace.readContext')
      if (!ctx) throw new Error('Focus a worktree first')
      await promisify(execFile)(ORCA, ['tab', 'create', '--url', base(), '--worktree', `branch:${ctx.branch}`])
    } catch (e) {
      await orca.host.call('notifications.show', { title: 'Beads: could not open board', body: String(e.message).slice(0, 1000) })
      throw e
    }
  })

  orca.commands.register('ready', async () => {
    await ensureServer()
    // ponytail: notifies for the first configured project; the board has the switcher.
    const project = Object.keys(loadConfig().projects)[0]
    if (!project) {
      await orca.host.call('notifications.show', { title: 'Beads: no projects yet', body: 'Run "Beads: Open Board" and add a beads project.' })
      return
    }
    const res = await fetch(`${base()}/api/bd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, args: ['ready'] }),
    })
    const issues = await res.json()
    if (!res.ok) throw new Error(issues.error)
    await orca.host.call('notifications.show', {
      title: `${issues.length} ready in ${project}`.slice(0, 120),
      body: (issues.slice(0, 8).map((i) => `P${i.priority} ${i.id} ${i.title}`).join('\n') || 'Nothing ready').slice(0, 1000),
    })
  })
}
