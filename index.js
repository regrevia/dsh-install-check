/**
 * 插件无忧装 — 装之前看一眼。
 *
 * Purely call-triggered: it only listens for plugin_manager's install calls.
 * It never guesses intent from what the user said.
 *
 * The profile applies changes at restart, so the note that arrives with the
 * install result still lands before the plugin is live. That is why this
 * never stops an install: asking first would only cost a round trip, and
 * where approvals are unavailable an ask degrades into a refusal.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scanPackage } from './lib/signature.js'
import { compare } from './lib/check.js'
import { render, renderSkills } from './lib/report.js'
import { materialize } from './lib/materialize.js'
import { fingerprint, findSkillConflicts, scanSkills, skillRoots } from './lib/skills.js'

export const name = 'install-check'
export const inject = ['tools']

const TTL = 60_000
const SKILL_TTL = 3_000
const scanCache = new Map()
const pending = new Map()

/** Skills arrive as files, so they are noticed on the first tool call after the change. */
const skillState = { checkedAt: 0, seen: null, told: new Set() }

function skillNote() {
  const now = Date.now()
  if (now - skillState.checkedAt < SKILL_TTL) return null
  skillState.checkedAt = now

  const roots = skillRoots()
  const print = fingerprint(roots)
  if (print === skillState.seen) return null
  skillState.seen = print

  const conflicts = findSkillConflicts(scanSkills(roots))
  const names = conflicts.names.filter((hit) => !skillState.told.has(`name:${hit.name}`))
  const overlaps = conflicts.overlaps.filter((hit) => !skillState.told.has(`overlap:${hit.a}|${hit.b}`))
  if (!names.length && !overlaps.length) return null

  for (const hit of names) skillState.told.add(`name:${hit.name}`)
  for (const hit of overlaps) skillState.told.add(`overlap:${hit.a}|${hit.b}`)
  return renderSkills({ names, overlaps }).zh
}

function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) return explicit
  const profile = process.env.DSH_PROFILE
  if (profile) return join(homedir(), '.dsh', 'profiles', profile)
  return join(homedir(), '.dsh', 'profiles', 'desktop')
}

function scanCached(dir) {
  const hit = scanCache.get(dir)
  if (hit && Date.now() - hit.at < TTL) return hit.signature
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

function key(exec) {
  const target = exec?.arguments?.target
  return typeof target === 'string' ? target.trim() : ''
}

/** Test seam: forget what has been reported so a fixture home can be checked. */
export function resetSkillWatch() {
  skillState.checkedAt = 0
  skillState.seen = null
  skillState.told.clear()
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

    const result = compare(candidate, installedPackages(profile))
    if (result.ok) return null
    return { candidate, result, text: render(candidate, result) }
  } finally {
    await cleanup()
  }
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== 'plugin_manager') return next()
    try {
      const checked = await checkInstall(exec)
      if (!checked) return next()
      pending.set(key(exec), { checked, at: Date.now() })
      return next()
    } catch {
      // A checker that cannot read the target must never touch the install.
      return next()
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const held = pending.get(key(exec))
    if (held) pending.delete(key(exec))

    const decision = await next()
    if (result?.isError || decision?.kind !== 'accept' || !decision.content) return decision

    const texts = []
    if (held && Date.now() - held.at <= TTL) texts.push(held.checked.text.zh)
    const note = skillNote()
    if (note) texts.push(note)
    if (!texts.length) return decision

    return {
      ...decision,
      content: [...decision.content, ...texts.map((text) => ({ type: 'text', text }))],
    }
  })
}
