/**
 * What version is running, and what does a package say it needs?
 *
 * The version is read from disk, never guessed: the desktop app records it
 * beside its bundled runtime, a CLI install has it in the package the launch
 * script resolves. Read once per process.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

let cached

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function valid(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
}

/** Version recorded next to a runtime the app downloaded, if any. */
function fromRuntimeDir() {
  const root = join(homedir(), '.dsh', 'dsh-runtimes')
  let names
  try {
    names = readdirSync(root)
  } catch {
    return null
  }
  // The primary runtime is the one actually running; others may be leftovers.
  names.sort((a, b) => (a === 'dsh-primary-runtime' ? -1 : b === 'dsh-primary-runtime' ? 1 : 0))
  for (const name of names) {
    const found = valid(readJson(join(root, name, 'runtime.json'))?.desktopVersion)
    if (found) return found
  }
  return null
}

/** The desktop shell manifest, found by walking out of the bundled runtime. */
function fromAppBundle(execPath) {
  const at = execPath.indexOf('.app/')
  if (at < 0) return null
  const resources = join(execPath.slice(0, at + 4), 'Contents', 'Resources', 'package.json')
  return valid(readJson(resources)?.version)
}

/** A package manager style install: the entry script resolves the harness package. */
function fromEntry(entry) {
  let dir = dirname(entry)
  for (let depth = 0; depth < 6; depth += 1) {
    const found = valid(readJson(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))?.version)
    if (found) return found
    dir = dirname(dir)
  }
  return null
}

/** The running harness version, or null when it cannot be established. */
export function shellVersion() {
  if (cached !== undefined) return cached
  const entry = process.argv?.[1]
  cached =
    valid(process.env.DSH_SHELL_VERSION) ??
    (entry ? fromEntry(entry) : null) ??
    fromRuntimeDir() ??
    (process.execPath ? fromAppBundle(process.execPath) : null) ??
    null
  return cached
}

/** The range a package declares it needs, from either spelling of the field. */
export function declaredRange(dir) {
  const manifest = readJson(join(dir, 'package.json'))
  const range = manifest?.dsh?.engines?.dsh ?? manifest?.engines?.dsh
  return typeof range === 'string' && range.trim() ? range.trim() : null
}

/** Test seam. */
export function resetShellVersion() {
  cached = undefined
}
