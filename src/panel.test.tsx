// `orca plugin test .` runs this in Node with the runtime Orca uses; the requests stand in for src/worker.ts.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('follows the focused project, and closes a task with a reason', async (t) => {
  const runs: string[][] = []
  const ready = [{ id: 'bd-1', title: 'Ship it', status: 'open', priority: 1, issue_type: 'task' }]
  const host = mockHost({
    requests: {
      'projects.list': { web: '/w', api: '/a' },
      'projects.focused': { name: 'api' },
      'issues.list': ({ project }) => ({ issues: project === 'api' ? ready : [], links: {} }),
      'issues.run': ({ args }) => (runs.push(args), { ok: true }),
    },
  })
  const view = await mount(panel, { host })
  // Unmount even when an assertion fails: the panel's refresh timer would keep Node running.
  t.after(() => view.unmount())
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  assert.equal(view.valueOf({ label: 'Project' }), 'api')

  await view.press({ label: 'Show details' })
  await view.press({ text: 'Close' })
  await view.type({ label: 'Close reason (optional)' }, 'done', { submit: true })
  assert.deepEqual(runs, [['close', 'bd-1', '-r', 'done']])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})
