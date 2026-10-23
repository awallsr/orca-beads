// Local beads board: serves board.html, proxies a whitelisted set of `bd` subcommands,
// and keeps panel.html (the Orca sidebar snapshot) up to date.
// Run: node server.mjs   (the Orca plugin starts it for you)
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { loadConfig, saveConfig } from './config.mjs'

const here = new URL('.', import.meta.url)
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

const POSTS = { '/api/bd': runBd, '/api/projects/add': addProject, '/api/projects/remove': removeProject }

async function handle(req) {
  // DNS-rebinding guard: only answer requests addressed to loopback.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return [403, { error: 'bad host' }]
  if (req.method === 'GET' && req.url === '/') return [200, readFileSync(new URL('board.html', here)), 'text/html']
  if (req.method === 'GET' && req.url === '/healthz') return [200, { ok: true }]
  if (req.method === 'GET' && req.url === '/api/projects') return [200, loadConfig().projects]
  // Requiring JSON forces a CORS preflight we never grant, so other sites can't drive bd.
  const post = POSTS[req.url]
  if (req.method === 'POST' && post && req.headers['content-type'] === 'application/json') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const result = await post(body)
    if (req.url !== '/api/bd' || !['ready', 'list', 'show'].includes(body.args?.[0])) writePanel().catch(() => {})
    return result
  }
  return [404, { error: 'not found' }]
}

// The Orca sidebar panel is a sandboxed iframe with no network access, so it can't
// fetch or ask for a refresh. But Orca watches dev plugin folders and reloads the
// panel whenever a file changes, so rewriting panel.html makes it update live.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const row = (i) => `<li title="${esc(i.title)}"><span class="p p${esc(i.priority)}">P${esc(i.priority)}</span><span class="t">${esc(i.title)}</span><span class="id">${esc(i.id)}${i.assignee ? ` · ${esc(i.assignee)}` : ''}</span></li>`
const group = (label, items, max) =>
  Array.isArray(items)
    ? `<h3>${label} <span>${items.length}</span></h3><ul>${items.slice(0, max).map(row).join('')}</ul>${items.length > max ? `<p class="more">+${items.length - max} more</p>` : ''}`
    : `<p class="err">${esc(items?.error ?? 'bd failed')}</p>`

let lastSections = null
async function writePanel() {
  const projects = Object.entries(loadConfig().projects)
  const sections = projects.length
    ? (await Promise.all(projects.map(async ([name, dir]) => {
        const [[, active], [, ready]] = await Promise.all([bd(dir, ['list', '-s', 'in_progress', '-n', '0']), bd(dir, ['ready', '-n', '0'])])
        return `<details open><summary>${esc(name)}</summary>${group('In progress', active, 10)}${group('Ready', ready, 6)}</details>`
      }))).join('')
    : '<p class="more">No beads projects yet. Run "Beads: Open Board" and add one.</p>'
  // Only touch the file when tasks changed: every write reloads the panel (and resets scroll).
  if (sections === lastSections) return
  lastSections = sections
  const html = readFileSync(new URL('panel.template.html', here), 'utf8')
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
