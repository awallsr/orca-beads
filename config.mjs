// Per-user settings (port + beads projects), kept out of git in config.json.
// The board's Projects form writes it; editing by hand works too.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const file = new URL('config.json', import.meta.url)

export function loadConfig() {
  const c = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { port: c.port ?? 7337, projects: c.projects ?? {} }
}

export const saveConfig = (config) => writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
