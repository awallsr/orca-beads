// `orca plugin check .` renders the panel once per scenario; `orca plugin shot . --scenario sample`
// draws one, which is how the README screenshot is made (with made-up tasks, not anyone's real ones).
import { defineCheck } from 'orca/testing'

const issue = (id: string, priority: number, title: string, extra = {}) => ({ id, priority, title, status: 'open', issue_type: 'task', ...extra })

export default defineCheck({
  // Whatever the real worker finds on this machine.
  live: {},
  sample: {
    requests: {
      'projects.list': { 'web-app': '~/code/web-app', api: '~/code/api' },
      'projects.focused': { name: 'web-app' },
      'issues.list': {
        issues: [
          issue('web-4f2', 0, 'Checkout fails when the cart has a gift card', { issue_type: 'bug', assignee: 'sam' }),
          issue('web-9c1', 1, 'Add dark mode to the settings page', { status: 'in_review', assignee: 'alex' }),
          issue('web-2ab', 2, 'Migrate image uploads to the new storage bucket'),
          issue('web-7d0', 3, 'Onboarding checklist for new workspaces', { issue_type: 'feature' }),
          issue('web-15e', 4, 'Tidy up unused feature flags', { issue_type: 'chore' }),
        ],
        links: { 'web-9c1': { worktreeId: 'wt-1', name: 'web-9c1' } },
      },
    },
  },
})
