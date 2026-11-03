// The Beads sidebar panel: the whole board. It follows the focused worktree's project, and asks
// src/worker.ts to run bd, since the panel itself is sandboxed.
import {
  atom,
  Button,
  Callout,
  Code,
  Collapsible,
  IconButton,
  Input,
  Markdown,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  type PanelContext,
} from 'orca'
import type { Issue, Link, View } from './protocol'

const VIEWS: [View, string][] = [['ready', 'Ready'], ['in_progress', 'In progress'], ['open', 'Open'], ['closed', 'Closed']]
const TYPES = ['task', 'bug', 'feature', 'chore', 'epic']

const projects = atom<Record<string, string>>({})
const project = atom('project', '', { persist: 'plugin' })
const view = atom<View>('view', 'ready', { persist: 'plugin' })
const filter = atom('')
const issues = atom<Issue[] | null>(null)
const links = atom<Record<string, Link>>({})
const error = atom('')
const note = atom('')
/** A card asking before it acts: Start confirms, Close takes a reason. */
const pending = atom<{ id: string; kind: 'start' | 'starting' | 'close' } | null>(null)
const reason = atom('')
const draft = atom('draft', { title: '', type: 'task', priority: '2', description: '' })
const newProject = atom({ dir: '', name: '' })

async function run(fn: () => Promise<unknown>) {
  set(error, '')
  try {
    await fn()
  } catch (e: any) {
    set(error, e?.message ?? String(e))
  }
}

async function load() {
  const name = read(project)
  if (!name) return set(issues, null)
  const answer = await plugin.request('issues.list', { project: name, view: read(view) })
  // A slow answer for a project or view the person has since left is dropped.
  if (name !== read(project)) return
  set(issues, answer.issues)
  set(links, answer.links)
}

async function loadProjects(want = read(project)) {
  const all = await plugin.request('projects.list')
  set(projects, all)
  const names = Object.keys(all)
  set(project, names.includes(want) ? want : names[0] ?? '')
  await load()
}

const choose = (name: string) => run(() => { set(note, ''); set(project, name); return load() })
const bd = (...args: string[]) => run(async () => { await plugin.request('issues.run', { project: read(project), args }); await load() })

function start(id: string) {
  set(pending, { id, kind: 'starting' })
  return run(async () => {
    try {
      const { name, warning } = await plugin.request('issues.start', { project: read(project), id }, { timeoutMs: 120_000 })
      // Claiming moves it out of Ready, so say where it went.
      set(note, `Started ${id} in worktree ${name}. It's under In progress, with a button that takes you there.${warning ? ` (Orca said: ${warning})` : ''}`)
    } finally {
      set(pending, null)
      await load()
    }
  })
}

function closeIssue(id: string) {
  const why = read(reason).trim()
  set(pending, null)
  set(reason, '')
  return bd(...(why ? ['close', id, '-r', why] : ['close', id]))
}

export function setup(ctx: PanelContext): void {
  void run(loadProjects)
  // Fires once on subscribe, then whenever focus moves: show the focused worktree's project.
  ctx.subscriptions.push(on('workspace.changed', () => run(async () => {
    const { name } = await plugin.request('projects.focused')
    if (name && name !== read(project)) await loadProjects(name)
  })))
  ctx.subscriptions.push(plugin.on('issues.changed', (e) => { if (e.project === read(project)) void run(load) }))
  // ponytail: polling; bd has no change feed. Skipped while a card asks something, so it isn't redrawn under the person.
  const timer = setInterval(() => { if (read(ctx.visible) && !read(pending)) void run(load) }, 15_000)
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
}

function actions(i: Issue) {
  const closed = i.status === 'closed'
  const ask = read(pending)
  if (ask?.id === i.id && ask.kind === 'starting') return <Text muted>Creating worktree…</Text>
  if (ask?.id === i.id && ask.kind === 'start') return (
    <Stack gap="xs">
      <Text>Claim it and start an agent in a new worktree?</Text>
      <Row gap="xs">
        <Button onPress={() => start(i.id)}>Start</Button>
        <Button variant="ghost" onPress={() => set(pending, null)}>Cancel</Button>
      </Row>
    </Stack>
  )
  if (ask?.id === i.id && ask.kind === 'close') return (
    <Stack gap="xs">
      <Input label="Close reason (optional)" value={read(reason)} onChange={(v) => set(reason, v)} onSubmit={() => closeIssue(i.id)} />
      <Row gap="xs">
        <Button onPress={() => closeIssue(i.id)}>Close</Button>
        <Button variant="ghost" onPress={() => set(pending, null)}>Cancel</Button>
      </Row>
    </Stack>
  )
  const link = read(links)[i.id]
  return (
    <Row gap="xs" wrap>
      {link ? <Button icon="branch" onPress={() => run(() => plugin.request('worktrees.focus', { project: read(project), worktreeId: link.worktreeId }))}>{link.name}</Button> : null}
      {!closed && !link ? <Button icon="play" onPress={() => set(pending, { id: i.id, kind: 'start' })}>Start</Button> : null}
      {!closed && i.status !== 'in_progress' ? <Button variant="outline" onPress={() => bd('update', i.id, '--claim')}>Claim</Button> : null}
      {!closed ? <Button variant="outline" onPress={() => set(pending, { id: i.id, kind: 'close' })}>Close</Button> : null}
      {closed ? <Button variant="outline" onPress={() => bd('reopen', i.id)}>Reopen</Button> : null}
    </Row>
  )
}

function IssueCard({ issue: i }: { issue: Issue }) {
  const link = read(links)[i.id]
  const details = ([['Description', i.description], ['Design', i.design], ['Acceptance', i.acceptance_criteria], ['Notes', i.notes]] as const)
    .filter(([, text]) => text)
    .map(([label, text]) => `**${label}**\n\n${text}`)
    .join('\n\n')
  // Custom statuses (in_review, in_qa, …) show in the description; the tabs cover the rest.
  const extra = ['open', 'in_progress', 'closed'].includes(i.status) ? '' : ` · ${i.status.replaceAll('_', ' ')}`
  return (
    <Collapsible
      title={`P${i.priority} · ${i.title}`}
      description={`${i.id} · ${i.issue_type}${extra}${i.assignee ? ` · ${i.assignee}` : ''}${link ? ` · ⎇ ${link.name}` : ''}`}
    >
      <Stack gap="sm">
        {details ? <Markdown content={details.slice(0, 60_000)} /> : null}
        {actions(i)}
      </Stack>
    </Collapsible>
  )
}

function IssueList() {
  const list = read(issues)
  if (!list) return <Text muted>Loading…</Text>
  const q = read(filter).toLowerCase()
  const shown = list.filter((i) => !q || `${i.id} ${i.title} ${i.assignee ?? ''}`.toLowerCase().includes(q))
  if (!shown.length) return <Text muted>Nothing here.</Text>
  return <Stack gap="xs">{shown.map((i) => <IssueCard key={i.id} issue={i} />)}</Stack>
}

function NewTask() {
  const d = read(draft)
  const edit = (patch: Partial<typeof d>) => set(draft, { ...d, ...patch })
  const create = () => run(async () => {
    if (!d.title.trim()) throw new Error('Give the task a title')
    const args = ['create', d.title.trim(), '-t', d.type, '-p', d.priority]
    if (d.description.trim()) args.push('-d', d.description.trim())
    await plugin.request('issues.run', { project: read(project), args })
    set(draft, { ...d, title: '', description: '' })
    await load()
  })
  return (
    <Collapsible title="New task">
      <Stack gap="xs">
        <Input label="Title" value={d.title} onChange={(title) => edit({ title })} onSubmit={create} />
        <Row gap="xs">
          <Select label="Type" value={d.type} options={TYPES.map((t) => ({ value: t, label: t }))} onChange={(type) => edit({ type })} />
          <Select label="Priority" value={d.priority} options={[0, 1, 2, 3, 4].map((p) => ({ value: String(p), label: `P${p}` }))} onChange={(priority) => edit({ priority })} />
        </Row>
        <Textarea label="Description (optional)" rows={3} value={d.description} onChange={(description) => edit({ description })} onSubmit={create} />
        <Button onPress={create}>Create</Button>
      </Stack>
    </Collapsible>
  )
}

function Projects({ open }: { open: boolean }) {
  const all = read(projects)
  const p = read(newProject)
  const add = () => run(async () => {
    const { name } = await plugin.request('projects.add', { dir: p.dir, name: p.name || undefined })
    set(newProject, { dir: '', name: '' })
    await loadProjects(name)
  })
  return (
    <Collapsible title="Projects" description="Any folder inside a beads project; the name defaults to its issue prefix." defaultOpen={open}>
      <Stack gap="xs">
        {Object.entries(all).map(([name, dir]) => (
          <Row key={name} gap="xs" justify="between">
            <Stack gap="none">
              <Text weight="medium">{name}</Text>
              <Text muted size="xs" truncate>{dir}</Text>
            </Stack>
            <IconButton icon="delete" label={`Remove ${name}`} variant="ghost" onPress={() => run(async () => { await plugin.request('projects.remove', { name }); await loadProjects() })} />
          </Row>
        ))}
        <Input label="Project folder" placeholder="~/code/my-repo" value={p.dir} onChange={(dir) => set(newProject, { ...p, dir })} onSubmit={add} />
        <Input label="Name (optional)" value={p.name} onChange={(name) => set(newProject, { ...p, name })} onSubmit={add} />
        <Button onPress={add}>Add project</Button>
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const names = Object.keys(read(projects))
  return (
    <Stack gap="sm">
      {read(error) ? <Callout tone="danger">{read(error)}</Callout> : null}
      {read(note) ? <Callout tone="accent">{read(note)}</Callout> : null}
      {names.length ? (
        <Stack gap="sm">
          <Row gap="xs">
            <Select label="Project" labelHidden value={read(project)} options={names.map((n) => ({ value: n, label: n }))} onChange={choose} />
            <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={() => run(load)} />
          </Row>
          <Tabs label="Tasks" value={read(view)} onChange={(v) => run(() => { set(view, v as View); set(issues, null); return load() })}>
            {VIEWS.map(([value, label]) => (
              <Tab key={value} value={value} label={label}>
                {read(view) === value ? (
                  <Stack gap="sm">
                    <Input label="Filter" labelHidden type="search" placeholder="Filter…" value={read(filter)} onChange={(v) => set(filter, v)} />
                    <IssueList />
                  </Stack>
                ) : null}
              </Tab>
            ))}
          </Tabs>
          <NewTask />
        </Stack>
      ) : (
        <Callout title="Get started">
          <Text>
            Focus a worktree of a repo that uses beads (it has a .beads folder; run <Code>bd init</Code> if not) and its
            project appears here. Or add one below by pasting the path of any folder inside it.
          </Text>
        </Callout>
      )}
      <Projects open={!names.length} />
    </Stack>
  )
}
