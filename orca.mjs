// The `orca` CLI, shared by the plugin worker and the board server.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'

// Failures still print JSON on stdout; surface Orca's own message rather than "Command failed".
export async function orcaJson(args, opts = {}) {
  try {
    return JSON.parse((await promisify(execFile)(ORCA, [...args, '--json'], { maxBuffer: 64 << 20, ...opts })).stdout).result
  } catch (e) {
    let error
    try { error = JSON.parse(e.stdout).error } catch {}
    throw Object.assign(new Error(error?.data?.nextSteps?.[0] ?? error?.message ?? e.message), { code: error?.code })
  }
}
