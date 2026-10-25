/**
 * 插件无忧装 — 装之前看一眼。
 *
 * Hooks the install call itself, so nothing extra has to be asked first:
 * the model says "install X", this reads X, and answers with one sentence and
 * one suggestion. Nothing is ever silently changed.
 *
 * Two moments:
 *  - before install: a real takeover (same loader row or service key) asks
 *    once; overlapping tools/routes/peers never stop the install.
 *  - after install: the same findings are appended to the result, so the
 *    model tells the user right away even when approvals are unavailable.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scanPackage } from './lib/signature.js'
import { compare } from './lib/check.js'
import { render } from './lib/report.js'
import { materialize } from './lib/materialize.js'

export const name = 'install-check'
export const inject = ['tools']

const CACHE_TTL = 60_000
const scanCache = new Map()
const pending = new Map()

function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) return explicit
  const profile = process.env.DSH_PROFILE
  if (profile) return join(homedir(), '.dsh', 'profiles', profile)
  return join(homedir(), '.dsh', 'profiles', 'desktop')
}

function scanCached(dir) {
  const hit = scanCache.get(dir)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.signature
  const signature = scanPackage(dir)
  scanCache.set(dir, { at: Date.now(), signature })
  return signature
}

function patchNames(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const patch = manifest?.dsh?.bundle?.patch
    if (!patch) return []
    const text = readFileSync(join(dir, patch), 'utf8')
    return [...text.matchAll(/^\s*-?\s*name:\s*['"]?(@?[\w@/.:-]+)['"]?\s*$/gm)].map((match) => match[1])
  } catch {
    return []
  }
}

/** Every package the live profile would load, including rows a bundle inserts. */
function installedPackages(profile) {
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const seen = new Set()
  const dirs = []
  const add = (packageName) => {
    if (!packageName || seen.has(packageName)) return
    const dir = join(profile, 'node_modules', packageName)
    if (!existsSync(join(dir, 'package.json'))) return
    seen.add(packageName)
    dirs.push(dir)
  }

  for (const bundle of bundles) {
    const dir = join(profile, 'node_modules', bundle)
    add(bundle)
    for (const name of patchNames(dir)) add(name)
  }
  return dirs.map(scanCached)
}

function parseArgs(exec) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return null
  const install = args.action === 'install_bundle'
  const enable = args.action === 'set_bundle' && args.enabled === true
  if (!install && !enable) return null
  const target = typeof args.target === 'string' ? args.target.trim() : ''
  return target ? { target, enable } : null
}

export async function checkInstall(exec, options = {}) {
  if (exec?.name !== 'plugin_manager') return null
  const call = parseArgs(exec)
  if (!call) return null

  const profile = options.profileDir ?? profileDir()
  const { dir, cleanup } = await materialize(call.target, {
    timeoutMs: options.timeoutMs ?? 20000,
    signal: exec?.signal,
  })

  try {
    const candidate = scanPackage(dir)
    // plugin_manager rejects non-plugin specs on its own; don't add noise.
    if (!candidate.isPlugin) return null

    const installed = installedPackages(profile)
    const result = compare(candidate, installed)
    if (result.ok) return null
    return { candidate, result, text: render(candidate, result) }
  } finally {
    await cleanup()
  }
}

function key(exec) {
  const target = exec?.arguments?.target
  return typeof target === 'string' ? target.trim() : ''
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== 'plugin_manager') return next()
    try {
      const checked = await checkInstall(exec)
      if (!checked) return next()

      if (checked.result.hard.length === 0) {
        pending.set(key(exec), { checked, at: Date.now() })
        return next()
      }
      return {
        kind: 'ask',
        reason: checked.text.zh,
        displayReason: { en: checked.text.en, zh: checked.text.zh, 'zh-CN': checked.text.zh },
      }
    } catch {
      // A checker that cannot read the target must never block an install.
      return next()
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const held = pending.get(key(exec))
    if (!held) return next()
    pending.delete(key(exec))

    const decision = await next()
    if (result?.isError || decision?.kind !== 'accept' || !decision.content) return decision
    if (Date.now() - held.at > CACHE_TTL) return decision

    return {
      ...decision,
      content: [...decision.content, { type: 'text', text: held.checked.text.zh }],
    }
  })
}
