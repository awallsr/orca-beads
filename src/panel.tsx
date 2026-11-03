// The Beads sidebar panel: the whole board. It follows the focused worktree's project, and asks
// src/worker.ts to run bd, since the panel itself is sandboxed.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Input,
  Markdown,
  on,
  plugin,
  Progress,
  read,
  Row,
  Select,
  set,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  update,
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
/** Loads in flight; the bar under the tabs shows while any is. */
const loading = atom(0)
const links = atom<Record<string, Link>>({})
const error = atom('')
const note = atom('')
/** A card asking before it acts: Start confirms, Close takes a reason. */
const pending = atom<{ id: string; kind: 'start' | 'starting' | 'close' } | null>(null)
const reason = atom('')
const draft = atom('draft', { title: '', type: 'task', priority: '2', description: '' })
const newProject = atom({ dir: '', name: '' })
/** Cards showing their details. */
const expanded = atom<string[]>([])
/** The form open above the tabs, from the toolbar. */
const panel = atom<'new' | 'projects' | null>(null)

async function run(fn: () => Promise<unknown>) {
  set(error, '')
  try {
    await fn()
  } catch (e: any) {
    set(error, e?.message ?? String(e))
  }
}

// `quiet` for background refreshes: the bar would make the list jump every 15 seconds.
async function load(quiet = false) {
  const name = read(project)
  if (!name) return set(issues, null)
  const bar = quiet ? 0 : 1
  update(loading, (n) => n + bar)
  try {
    const answer = await plugin.request('issues.list', { project: name, view: read(view) })
    // A slow answer for a project or view the person has since left is dropped.
    if (name !== read(project)) return
    set(issues, answer.issues)
    set(links, answer.links)
  } finally {
    update(loading, (n) => n - bar)
  }
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
  ctx.subscriptions.push(plugin.on('issues.changed', (e) => { if (e.project === read(project)) void run(() => load(true)) }))
  // ponytail: polling; bd has no change feed. Skipped while a card asks something, so it isn't redrawn under the person.
  const timer = setInterval(() => { if (read(ctx.visible) && !read(pending)) void run(() => load(true)) }, 15_000)
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
}

// Collapsed, a card shows only the way to its worktree; expanded, every action.
function actions(i: Issue, open: boolean) {
  const closed = i.status === 'closed'
  const ask = read(pending)
  if (ask?.id === i.id && ask.kind === 'starting') return <Text muted>Creating worktree…</Text>
  if (ask?.id === i.id && ask.kind === 'start') return (
    <Stack gap="xs">
      <Text>Claim it and start an agent in a new worktree?</Text>
      <Row gap="xs">
        <Button variant="solid" tone="accent" onPress={() => start(i.id)}>Start</Button>
        <Button variant="ghost" onPress={() => set(pending, null)}>Cancel</Button>
      </Row>
    </Stack>
  )
  if (ask?.id === i.id && ask.kind === 'close') return (
    <Stack gap="xs">
      <Input label="Close reason (optional)" value={read(reason)} onChange={(v) => set(reason, v)} onSubmit={() => closeIssue(i.id)} />
      <Row gap="xs">
        <Button variant="solid" onPress={() => closeIssue(i.id)}>Close</Button>
        <Button variant="ghost" onPress={() => set(pending, null)}>Cancel</Button>
      </Row>
    </Stack>
  )
  const link = read(links)[i.id]
  return (
    <Row gap="xs" wrap>
      {link ? <Button icon="branch" variant="outline" onPress={() => run(() => plugin.request('worktrees.focus', { project: read(project), worktreeId: link.worktreeId }))}>{link.name}</Button> : null}
      {open && !closed && !link ? <Button icon="play" variant="solid" tone="accent" onPress={() => set(pending, { id: i.id, kind: 'start' })}>Start</Button> : null}
      {open && !closed && i.status !== 'in_progress' ? <Button variant="outline" onPress={() => bd('update', i.id, '--claim')}>Claim</Button> : null}
      {open && !closed ? <Button variant="outline" onPress={() => set(pending, { id: i.id, kind: 'close' })}>Close</Button> : null}
      {open && closed ? <Button variant="outline" onPress={() => bd('reopen', i.id)}>Reopen</Button> : null}
    </Row>
  )
}

// Most to least urgent; P4 stays neutral.
const PRIORITY_TONES = ['danger', 'warning', 'accent', 'success', 'neutral'] as const
const STATUS_TONES: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = { in_progress: 'warning', blocked: 'danger', closed: 'success' }

function IssueCard({ issue: i }: { issue: Issue }) {
  const link = read(links)[i.id]
  const open = read(expanded).includes(i.id)
  const toggle = () => update(expanded, (ids) => (ids.includes(i.id) ? ids.filter((id) => id !== i.id) : [...ids, i.id]))
  const details = ([['Description', i.description], ['Design', i.design], ['Acceptance', i.acceptance_criteria], ['Notes', i.notes]] as const)
    .filter(([, text]) => text)
    .map(([label, text]) => `**${label}**\n\n${text}`)
    .join('\n\n')
  // The tab already says open; any other status (in_review, in_qa, …) gets its own badge.
  const status = i.status === read(view) || (i.status === 'open' && read(view) === 'ready') ? null : i.status
  return (
    <Card>
      <Stack gap="xs">
        <Row gap="xs" justify="between" align="start">
          <Stack gap="xs">
            <Row gap="xs" wrap>
              <Badge tone={PRIORITY_TONES[i.priority] ?? 'neutral'}>P{i.priority}</Badge>
              {i.issue_type !== 'task' ? <Badge>{i.issue_type}</Badge> : null}
              {status ? <Badge tone={STATUS_TONES[status] ?? 'accent'}>{status.replaceAll('_', ' ')}</Badge> : null}
            </Row>
            <Text weight="medium">{i.title}</Text>
            <Text muted size="xs">{i.id}{i.assignee ? ` · ${i.assignee}` : ''}</Text>
          </Stack>
          <IconButton icon={open ? 'collapse' : 'expand'} label={open ? 'Hide details' : 'Show details'} variant="ghost" size="sm" onPress={toggle} />
        </Row>
        {/* Actions before details: a long description would push them out of view. */}
        {open || link || read(pending)?.id === i.id ? actions(i, open) : null}
        {open && details ? <Markdown content={details.slice(0, 60_000)} /> : null}
      </Stack>
    </Card>
  )
}

const EMPTY: Record<View, [string, string]> = {
  ready: ['Nothing ready', 'Every open task is blocked, claimed or done.'],
  in_progress: ['Nothing in progress', 'Start or claim a ready task and it shows here.'],
  open: ['No open tasks', 'Create one with the + button.'],
  closed: ['Nothing closed yet', 'Closed tasks show here, newest 50.'],
}

function IssueList() {
  const list = read(issues)
  if (!list) return <Skeleton shape="block" label="Loading tasks" />
  const q = read(filter).toLowerCase()
  const shown = list.filter((i) => !q || `${i.id} ${i.title} ${i.assignee ?? ''}`.toLowerCase().includes(q))
  if (!list.length) return <EmptyState title={EMPTY[read(view)][0]} description={EMPTY[read(view)][1]} icon="check" />
  return (
    <Stack gap="sm">
      {list.length > 5 || q ? <Input label="Filter" labelHidden type="search" placeholder={`Filter ${list.length} tasks…`} value={q} onChange={(v) => set(filter, v)} /> : null}
      {shown.length ? shown.map((i) => <IssueCard key={i.id} issue={i} />) : <Text muted>No task matches “{read(filter)}”.</Text>}
    </Stack>
  )
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
    set(panel, null)
    await load()
  })
  return (
    <Card title="New task">
      <Stack gap="xs">
        <Input label="Title" value={d.title} onChange={(title) => edit({ title })} onSubmit={create} />
        <Row gap="xs">
          <Select label="Type" value={d.type} options={TYPES.map((t) => ({ value: t, label: t }))} onChange={(type) => edit({ type })} />
          <Select label="Priority" value={d.priority} options={[0, 1, 2, 3, 4].map((p) => ({ value: String(p), label: `P${p}` }))} onChange={(priority) => edit({ priority })} />
        </Row>
        <Textarea label="Description (optional)" rows={3} value={d.description} onChange={(description) => edit({ description })} onSubmit={create} />
        <Row gap="xs">
          <Button variant="solid" tone="accent" onPress={create}>Create</Button>
          <Button variant="ghost" onPress={() => set(panel, null)}>Cancel</Button>
        </Row>
      </Stack>
    </Card>
  )
}

function Projects() {
  const all = read(projects)
  const p = read(newProject)
  const add = () => run(async () => {
    const { name } = await plugin.request('projects.add', { dir: p.dir, name: p.name || undefined })
    set(newProject, { dir: '', name: '' })
    set(panel, null)
    await loadProjects(name)
  })
  return (
    <Card title="Projects" description="Focusing a worktree of a beads project adds it. To add one by hand, paste any folder inside it; the name defaults to its issue prefix.">
      <Stack gap="sm">
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
        <Row gap="xs">
          <Button variant="solid" tone="accent" onPress={add}>Add project</Button>
          {Object.keys(all).length ? <Button variant="ghost" onPress={() => set(panel, null)}>Done</Button> : null}
        </Row>
      </Stack>
    </Card>
  )
}

const togglePanel = (name: 'new' | 'projects') => update(panel, (open) => (open === name ? null : name))

export default function Panel() {
  const names = Object.keys(read(projects))
  if (!names.length) return (
    <Stack gap="sm">
      {read(error) ? <Callout tone="danger">{read(error)}</Callout> : null}
      <EmptyState
        title="No beads projects yet"
        description="Focus a worktree of a repo that uses beads (it has a .beads folder; run bd init if not), or add one below."
        icon="database"
      />
      <Projects />
    </Stack>
  )
  return (
    <Stack gap="sm">
      <Row gap="xs" justify="between">
        <Select label="Project" labelHidden value={read(project)} options={names.map((n) => ({ value: n, label: n }))} onChange={choose} />
        <Row gap="none">
          <IconButton icon="add" label="New task" variant={read(panel) === 'new' ? 'solid' : 'ghost'} onPress={() => togglePanel('new')} />
          <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={() => run(load)} />
          <IconButton icon="settings" label="Projects" variant={read(panel) === 'projects' ? 'solid' : 'ghost'} onPress={() => togglePanel('projects')} />
        </Row>
      </Row>
      {read(error) ? <Callout tone="danger">{read(error)}</Callout> : null}
      {read(note) ? <Callout tone="accent">{read(note)}</Callout> : null}
      {read(panel) === 'new' ? <NewTask /> : null}
      {read(panel) === 'projects' ? <Projects /> : null}
      <Tabs label="Tasks" value={read(view)} onChange={(v) => run(() => { set(view, v as View); set(issues, null); set(filter, ''); return load() })}>
        {VIEWS.map(([value, label]) => (
          <Tab key={value} value={value} label={label}>
            {read(view) === value ? (
              <Stack gap="sm">
                {read(loading) ? <Progress label="Loading tasks" labelHidden /> : null}
                <IssueList />
              </Stack>
            ) : null}
          </Tab>
        ))}
      </Tabs>
    </Stack>
  )
}
