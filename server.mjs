// Local beads board: serves board.html, proxies a whitelisted set of `bd` subcommands,
// and keeps panel.html (the Orca sidebar snapshot) up to date.
// Run: node server.mjs   (the Orca plugin starts it for you)
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { loadConfig, saveConfig } from './config.mjs'
import { codeVersion } from './version.mjs'
import { orcaJson } from './orca.mjs'

const here = new URL('.', import.meta.url)
const version = codeVersion()
// Unreadable code (mid-pull, or a file this version needs was removed) counts as changed.
const isStale = () => { try { return codeVersion() !== version } catch { return true } }
const ALLOWED = new Set(['ready', 'list', 'show', 'create', 'update', 'close', 'reopen'])
// GUI-launched Orca hands plugins a thin PATH; bd usually lives in one of these.
const PATH = `${process.env.PATH}:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin`
const expand = (dir) => dir.replace(/^~(?=\/|$)/, homedir())

function bd(dir, args) {
  return new Promise((resolve) => {
    execFile('bd', ['-C', expand(dir), ...args, '--json'], { env: { ...process.env, PATH }, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) return resolve([400, { error: (stderr || err.message).trim() }])
      try {
        resolve([200, stdout.trim() ? JSON.parse(stdout) : null])
      } catch {
        resolve([200, { output: stdout }])
      }
    })
  })
}

async function addProject({ dir, name }) {
  if (typeof dir !== 'string' || !dir.trim()) return [400, { error: 'Enter a folder inside a beads project' }]
  // `bd where` walks up to the .beads directory, so any folder inside the project works.
  const [status, where] = await bd(dir.trim(), ['where'])
  if (status !== 200) return [400, { error: where.error }]
  const config = loadConfig()
  name = (typeof name === 'string' && name.trim()) || where.prefix
  if (config.projects[name]) return [400, { error: `A project named "${name}" already exists` }]
  config.projects[name] = dirname(where.path)
  saveConfig(config)
  return [200, { name }]
}

// The board opened from a worktree asks which project to show: the configured one containing
// that folder, added on the spot if it's a beads project that isn't configured yet.
async function resolveProject({ dir }) {
  if (typeof dir !== 'string' || !dir.trim()) return [400, { error: 'missing folder' }]
  const [status, where] = await bd(dir.trim(), ['where'])
  const { projects } = loadConfig()
  if (status !== 200) {
    // `bd where` only walks up, so a worktree whose project lives in a subfolder (a monorepo
    // service) misses it; fall back to a configured project inside the worktree.
    const root = expand(dir.trim()).replace(/\/+$/, '') + '/'
    return [200, { name: Object.keys(projects).find((n) => expand(projects[n]).startsWith(root)) ?? null }]
  }
  const name = Object.keys(projects).find((n) => projects[n] === dirname(where.path))
  return name ? [200, { name }] : addProject({ dir: dirname(where.path) })
}

function removeProject({ name }) {
  const config = loadConfig()
  delete config.projects[name]
  saveConfig(config)
  return [200, { ok: true }]
}

function runBd({ project, args }) {
  const dir = loadConfig().projects[project]
  if (!dir || !Array.isArray(args) || !ALLOWED.has(args[0]) || !args.every((a) => typeof a === 'string')) {
    return [400, { error: 'unknown project or disallowed bd command' }]
  }
  return bd(dir, args)
}

// Orca worktrees of a project's repo. Cached briefly, since the board and the panel both poll.
let worktreeCache = { at: 0, list: null }
async function projectWorktrees(dir) {
  if (Date.now() - worktreeCache.at > 5000) worktreeCache = { at: Date.now(), list: orcaJson(['worktree', 'list', '--limit', '1000']).then((r) => r.worktrees) }
  const list = await worktreeCache.list
  const repoId = list.find((w) => w.path === dir)?.repoId
  return { repoId, worktrees: list.filter((w) => repoId && w.repoId === repoId && !w.isArchived) }
}

// A worktree belongs to a task when its name, branch or comment's first word is the task id
// (Start names it that). Ids nest (bd-1 vs bd-1.2), so match the whole id only.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const worktreeFor = (worktrees, id) => {
  const re = new RegExp(`(^|[^\\w.])${escapeRe(id)}($|[^\\w.])`)
  return worktrees.find((w) => re.test(`${w.displayName} ${w.branch.replace(/^refs\/heads\//, '')} ${w.comment.split(/\s/)[0]}`))
}

// Task id → its worktree. Empty when Orca can't be reached: links are a nicety.
async function linkWorktrees(dir, ids) {
  const { worktrees } = await projectWorktrees(dir).catch(() => ({ worktrees: [] }))
  const links = {}
  for (const id of ids) {
    const w = worktreeFor(worktrees, id)
    if (w) links[id] = { worktreeId: w.id, name: w.displayName }
  }
  return links
}

async function worktreeLinks({ project, ids }) {
  const dir = loadConfig().projects[project]
  if (!dir || !Array.isArray(ids)) return [400, { error: 'unknown project' }]
  return [200, await linkWorktrees(dir, ids.filter((id) => typeof id === 'string'))]
}

// Start: claim the task, then give it its own worktree with an agent working on it.
async function startTask({ project, id }) {
  const { agent, projects } = loadConfig()
  const dir = projects[project]
  if (!dir || typeof id !== 'string') return [400, { error: 'unknown project' }]
  const [status, shown] = await bd(dir, ['show', id])
  if (status !== 200) return [status, shown]
  const issue = shown[0]
  if (issue.status === 'closed') return [400, { error: `${issue.id} is closed` }]
  const { repoId, worktrees } = await projectWorktrees(dir)
  if (!repoId) return [400, { error: `${dir} isn't a repo in Orca yet. Add it in Orca, then try again.` }]
  if (worktreeFor(worktrees, issue.id)) return [400, { error: `${issue.id} already has a worktree` }]
  const [claimed, error] = await bd(dir, ['update', issue.id, '--claim'])
  if (claimed !== 200) return [claimed, error]
  try {
    // The prompt carries only the id: task text can come from collaborators, so the agent reads it through bd.
    await orcaJson([
      'worktree', 'create', '--repo', `id:${repoId}`, '--name', issue.id, '--no-parent',
      '--comment', `${issue.id} ${issue.title}`.slice(0, 200),
      '--agent', agent, '--prompt', `Work on beads issue ${issue.id}. Run \`bd show ${issue.id}\` for the details; it's claimed for you.`,
    ], { timeout: 120_000 })
  } catch (e) {
    // A timeout or an agent that fell back can still leave a worktree behind; keep the claim then.
    worktreeCache.at = 0
    const made = await projectWorktrees(dir).then(({ worktrees }) => worktreeFor(worktrees, issue.id), () => null)
    if (made) return [200, { name: made.displayName, warning: e.message }]
    // Undo the claim made here, so the task goes back to ready.
    if (issue.status === 'open') await bd(dir, ['update', issue.id, '-s', 'open', '-a', ''])
    return [400, { error: `Could not create a worktree for ${issue.id}: ${e.message}` }]
  }
  worktreeCache.at = 0
  const { worktrees: now } = await projectWorktrees(dir)
  return [200, { name: worktreeFor(now, issue.id)?.displayName ?? issue.id }]
}

// Go to a task's worktree by bringing up one of its terminals (Orca creates one with every worktree).
async function focusWorktree({ project, worktreeId }) {
  const dir = loadConfig().projects[project]
  if (!dir) return [400, { error: 'unknown project' }]
  const { worktrees } = await projectWorktrees(dir)
  if (!worktrees.some((w) => w.id === worktreeId)) return [400, { error: 'That worktree is gone' }]
  const { terminals } = await orcaJson(['terminal', 'list', '--worktree', `id:${worktreeId}`])
  const live = terminals.find((t) => t.connected && !t.orphaned)
  if (live) await orcaJson(['terminal', 'switch', '--terminal', live.handle])
  else await orcaJson(['terminal', 'create', '--worktree', `id:${worktreeId}`, '--focus'])
  return [200, { ok: true }]
}

const POSTS = {
  '/api/bd': runBd,
  '/api/start': startTask,
  '/api/worktrees': worktreeLinks,
  '/api/worktrees/focus': focusWorktree, '/api/projects/add': addProject, '/api/projects/resolve': resolveProject, '/api/projects/remove': removeProject,
}
// Requests that leave tasks as they were, so the panel needn't be re-rendered.
const reads = (pathname, body) =>
  pathname === '/api/bd' ? ['ready', 'list', 'show'].includes(body.args?.[0]) : ['/api/worktrees', '/api/worktrees/focus'].includes(pathname)

async function handle(req) {
  // DNS-rebinding guard: only answer requests addressed to loopback.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return [403, { error: 'bad host' }]
  const { pathname } = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && pathname === '/') return [200, readFileSync(new URL('board.html', here)), 'text/html']
  if (req.method === 'GET' && pathname === '/healthz') return [200, { ok: true, version, stale: isStale() }]
  if (req.method === 'GET' && pathname === '/api/projects') return [200, loadConfig().projects]
  // Requiring JSON forces a CORS preflight we never grant, so other sites can't drive bd.
  const post = Object.hasOwn(POSTS, pathname) && POSTS[pathname]
  if (req.method === 'POST' && post && req.headers['content-type'] === 'application/json') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const result = await post(body)
    if (!reads(pathname, body)) writePanel().catch(() => {})
    return result
  }
  return [404, { error: 'not found' }]
}

// The Orca sidebar panel is a sandboxed iframe with no network access, so it can't
// fetch or ask for a refresh. But Orca watches dev plugin folders and reloads the
// panel whenever a file changes, so rewriting panel.html makes it update live.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
// Custom statuses (in_review, in_qa, …) share one color.
const statusClass = (s) => `s-${['open', 'in_progress', 'blocked'].includes(s) ? s : 'other'}`
const row = (i, link) => `<li class="${statusClass(i.status)}" title="${esc(i.title)} (${esc(i.status)})"><span class="p p${esc(i.priority)}">P${esc(i.priority)}</span><span class="t">${esc(i.title)}</span><span class="id">${esc(i.id)}${i.assignee ? ` · ${esc(i.assignee)}` : ''}${link ? ` · ⎇ ${esc(link.name)}` : ''}</span></li>`
const group = (label, status, items, max, links = {}) =>
  Array.isArray(items)
    ? `<h3 class="${statusClass(status)}">${label} <span>${items.length}</span></h3><ul>${items.slice(0, max).map((i) => row(i, links[i.id])).join('')}</ul>${items.length > max ? `<p class="more">+${items.length - max} more</p>` : ''}`
    : `<p class="err">${esc(items?.error ?? 'bd failed')}</p>`

let lastSections = null
async function writePanel() {
  const projects = Object.entries(loadConfig().projects)
  const sections = projects.length
    ? (await Promise.all(projects.map(async ([name, dir]) => {
        const [[, active], [, ready]] = await Promise.all([bd(dir, ['list', '-s', 'in_progress', '-n', '0']), bd(dir, ['ready', '-n', '0'])])
        const links = Array.isArray(active) ? await linkWorktrees(dir, active.map((i) => i.id)) : {}
        // Each task shows once: in progress wins over ready.
        const readyOnly = Array.isArray(ready) ? ready.filter((i) => i.status !== 'in_progress') : ready
        return `<details open><summary>${esc(name)}</summary>${group('In progress', 'in_progress', active, 10, links)}${group('Ready', 'open', readyOnly, 6)}</details>`
      }))).join('')
    : '<p class="more">No beads projects yet. Run "Beads: Open Board" and add one.</p>'
  const template = readFileSync(new URL('panel.template.html', here), 'utf8')
  // Only touch the file when tasks (or the template) changed: every write reloads the panel (and resets scroll).
  if (template + sections === lastSections) return
  lastSections = template + sections
  const html = template
    .replace('<!--SECTIONS-->', sections)
    .replace('<!--UPDATED-->', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
  // Atomic swap so Orca never reads a half-written panel.
  writeFileSync(new URL('.panel.tmp', here), html)
  renameSync(new URL('.panel.tmp', here), new URL('panel.html', here))
}

// ponytail: fixed 15s poll; switch to an event-driven refresh if bd grows a change feed.
const refreshPanel = () => writePanel().catch((e) => console.error('panel refresh failed:', e.message)).finally(() => setTimeout(refreshPanel, 15_000))
refreshPanel()

const { port } = loadConfig()
createServer(async (req, res) => {
  let [status, body, type = 'application/json'] = [500, { error: 'internal error' }]
  try {
    ;[status, body, type = 'application/json'] = await handle(req)
  } catch (e) {
    body = { error: e.message }
  }
  res.writeHead(status, { 'content-type': type })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}).listen(port, '127.0.0.1', () => console.log(`beads board on http://127.0.0.1:${port}`))
