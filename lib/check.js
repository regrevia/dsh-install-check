/**
 * Compares one candidate package against the packages already in the profile.
 *
 * Only keys that actually collide are reported, and only when the collision
 * changes what works: two plugins cannot own the same loader row, the same
 * service key, or the same tool name. Routes and slots are additive in this
 * harness, so they are read but never reported.
 */

const HOST_PREFIXES = ['@deepseek-ai/', 'cordis', '@cordisjs/']
const HOST_NAMES = new Set(['react', 'react-dom', 'electron', 'dsh'])

function isHostPackage(name) {
  return HOST_NAMES.has(name) || HOST_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function indexOf(installed, dimension) {
  const index = new Map()
  for (const pkg of installed) {
    for (const key of pkg[dimension] ?? []) {
      if (!index.has(key)) index.set(key, [])
      const owners = index.get(key)
      if (!owners.includes(pkg.name)) owners.push(pkg.name)
    }
  }
  return index
}

/** Night-out rule: one row, one service key, one tool name per layer. */
const COLLISIONS = [
  { dimension: 'patchIds', kind: 'row' },
  { dimension: 'services', kind: 'service' },
  { dimension: 'tools', kind: 'tool' },
]

/**
 * @param {object} candidate from scanPackage()
 * @param {object[]} installed scanned packages already present in the profile
 */
export function compare(candidate, installed) {
  const others = installed.filter((pkg) => pkg.name !== candidate.name)
  const breaks = []

  for (const { dimension, kind } of COLLISIONS) {
    const index = indexOf(others, dimension)
    for (const key of new Set(candidate[dimension] ?? [])) {
      const owners = index.get(key)
      if (owners?.length) breaks.push({ kind, key, owners: [...owners] })
    }
  }

  const installedNames = new Set(others.map((pkg) => pkg.name))
  const missing = []
  for (const [name, range] of Object.entries(candidate.peerDeps ?? {})) {
    if (isHostPackage(name) || installedNames.has(name) || name === candidate.name) continue
    missing.push({ kind: 'peer', key: name, range })
  }

  const findings = [...breaks, ...missing]
  return { ok: findings.length === 0, findings, breaks, missing }
}

/**
 * Which packages provide the service keys the candidate reads lazily.
 * Used for "install A too" suggestions, never for blocking.
 */
export function missingProviders(candidate, installed) {
  const provided = new Set()
  for (const pkg of installed) {
    for (const key of pkg.services ?? []) provided.add(key)
  }
  return (candidate.lazyGets ?? []).filter((key) => !provided.has(key))
}
