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
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { scanPackage } from './lib/signature.js'
import { compare } from './lib/check.js'
import {
  render,
  renderBroken,
  renderSkills,
  renderTakeover,
  renderUnconnected,
  renderVersion,
  renderVersionAudit,
} from './lib/report.js'
import { versionVerdict } from './lib/compat.js'
import { declaredRange, shellVersion } from './lib/shell.js'
import { inactive } from './lib/loader.js'
import { scanPackageClient } from './lib/client.js'
import { materialize } from './lib/materialize.js'
import { fingerprint, findSkillConflicts, scanSkills, skillRoots } from './lib/skills.js'

export const name = 'install-check'
export const inject = ['tools']

const TTL = 30 * 60_000
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

/** Every package directory the live profile would load, including bundle rows. */
function installedDirs(profile) {
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
  return dirs
}

function installedPackages(profile) {
  return installedDirs(profile).map(scanCached)
}

/**
 * A harness update can leave installed plugins behind. Their declared range is
 * read again the first time the version changes, and the loader is asked the
 * same question, so a plugin that silently failed to come up is named too.
 */
async function versionAudit(ctx) {
  const version = shellVersion()
  if (!version) return null
  const profile = profileDir()
  const file = join(profile, '.install-check-version.json')
  let state = null
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    state = null
  }
  const seen = state?.version === version ? state : null
  // The range and the loader are remembered separately: a build that cannot
  // read one of them must not stop the other from being reported later.
  const needRange = !seen?.range
  const needLoader = !seen?.loader
  if (!needRange && !needLoader) return null

  const live = inactive(ctx)
  if (live === null && !needRange) return null

  const dirs = installedDirs(profile)
  const installed = new Set(dirs.map((dir) => basename(dir)))
  const previous = typeof state?.version === 'string' ? state.version : null
  const stale = []
  // A declared range can only be compared once there is a previous version to
  // compare with; the loader needs no baseline, so a first sighting still reports
  // what is not running right now.
  if (needRange && previous) {
    for (const dir of dirs) {
      const range = declaredRange(dir)
      if (!range) continue
      const verdict = versionVerdict(version, range)
      if (verdict === 'below' || verdict === 'above') stale.push(basename(dir))
    }
  }
  const mine = (name) => installed.has(name) && !stale.includes(name)
  const broken = live ? live.broken.filter(mine) : []
  const waiting = live ? live.waiting.filter((name) => mine(name) && !broken.includes(name)) : []

  const lines = []
  if (stale.length) lines.push(renderVersionAudit(stale, version).zh)
  if (broken.length) lines.push(renderBroken(broken).zh)
  if (waiting.length) lines.push(renderUnconnected(waiting).zh)

  try {
    writeFileSync(
      file,
      JSON.stringify({ version, range: true, loader: live !== null, at: new Date().toISOString() }),
    )
  } catch {
    return null
  }
  return lines.length ? lines.join('\n') : null
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

/**
 * One call, one reminder. The host hands each dispatch a distinct token (and a
 * call id); the target is only a fallback for callers that pass neither, since
 * two sessions installing the same spec would otherwise share one entry.
 */
function key(exec) {
  const token = exec?.token ?? exec?.callId
  if (typeof token === 'string' && token) return token
  if (typeof token === 'symbol') return token
  const target = exec?.arguments?.target
  return typeof target === 'string' && target.trim() ? `target:${target.trim()}` : null
}

/** Entries whose call never came back must not pile up. */
function sweep(now) {
  for (const [k, held] of pending) {
    if (now - held.at > TTL) pending.delete(k)
  }
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
    // No shared name, no missing dependency — and still able to eat the window.
    const takeover = scanPackageClient(dir)
    const version = shellVersion()
    const range = version ? declaredRange(dir) : null
    const verdict = range ? versionVerdict(version, range) : 'unknown'
    const zh = []
    const en = []
    if (!result.ok) {
      const note = render(candidate, result)
      zh.push(note.zh)
      en.push(note.en)
    }
    if (verdict === 'below' || verdict === 'above') {
      const note = renderVersion(verdict, version, range)
      zh.push(note.zh)
      en.push(note.en)
    }
    if (takeover) {
      const risk = renderTakeover()
      zh.push(risk.zh)
      en.push(risk.en)
    }
    if (!zh.length) return null
    return { candidate, result, text: { zh: zh.join('\n'), en: en.join('\n') } }
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
      const slot = key(exec)
      if (slot !== null) {
        sweep(Date.now())
        pending.set(slot, { checked, at: Date.now() })
      }
      return next()
    } catch {
      // A checker that cannot read the target must never touch the install.
      return next()
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const slot = key(exec)
    const held = slot === null ? undefined : pending.get(slot)
    if (slot !== null) pending.delete(slot)

    const decision = await next()
    if (result?.isError || decision?.kind !== 'accept') return decision
    // Replacing the value rebuilds the content, so text cannot ride along.
    if (Object.hasOwn(decision, 'value')) return decision
    const base = Array.isArray(decision.content) ? decision.content : result?.content
    if (!Array.isArray(base)) return decision

    const texts = []
    if (held) texts.push(held.checked.text.zh)
    const note = skillNote()
    if (note) texts.push(note)
    try {
      const audit = await versionAudit(ctx)
      if (audit) texts.push(audit)
    } catch {
      // A version note must never take down a tool result.
    }
    if (!texts.length) return decision

    return {
      ...decision,
      content: [...base, ...texts.map((text) => ({ type: 'text', text }))],
    }
  })
}
