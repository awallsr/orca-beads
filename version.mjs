// Fingerprint of the board server's code. The server compares the one it started with against the
// files on disk, so the plugin can replace a server still running older code (e.g. after a git pull).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function codeVersion() {
  const hash = createHash('sha1')
  for (const file of ['server.mjs', 'config.mjs', 'orca.mjs', 'version.mjs']) hash.update(readFileSync(new URL(file, import.meta.url)))
  return hash.digest('hex').slice(0, 12)
}
