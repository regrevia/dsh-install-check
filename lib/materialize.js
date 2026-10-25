/**
 * Turns an install target into a directory we can read.
 *
 * Local paths are used in place. Registry specs are packed into a temp folder
 * with npm and unpacked there; nothing is installed into the profile.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 32 * 1024 * 1024

function run(command, args, options) {
  return execFileAsync(command, args, { maxBuffer: MAX_BUFFER, ...options })
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function localPath(target) {
  const plain = target.replace(/^(link|file):/, '')
  const looksLocal = plain.startsWith('/') || plain.startsWith('./') || plain.startsWith('../') || plain.startsWith('~/')
  if (!looksLocal) return null
  const expanded = plain.startsWith('~/') ? join(homedir(), plain.slice(2)) : plain
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/**
 * @param {string} target install target: path, name, name@range, or link:/file: spec
 * @param {{timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>, local: boolean}>}
 */
export async function materialize(target, options = {}) {
  const { timeoutMs = 25000, signal } = options
  const path = localPath(target)
  if (path) {
    if (!existsSync(join(path, 'package.json'))) {
      throw new Error(`${target} 里没有 package.json`)
    }
    return { dir: path, local: true, cleanup: async () => {} }
  }

  const work = await mkdtemp(join(tmpdir(), 'dsh-install-check-'))
  const cleanup = async () => {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }

  try {
    const { stdout } = await run(
      npmBin(),
      ['pack', target, '--pack-destination', work, '--json', '--cache', join(work, '.cache'), '--no-audit', '--no-fund'],
      { cwd: work, timeout: timeoutMs, signal },
    )
    const packed = JSON.parse(stdout)[0]
    if (!packed?.filename) throw new Error(`npm pack 没有给出 ${target} 的包`)
    await run('tar', ['-xzf', join(work, packed.filename), '-C', work], { timeout: timeoutMs, signal })
    const entries = await readdir(work)
    const dir = entries.includes('package') ? join(work, 'package') : work
    return { dir, local: false, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
