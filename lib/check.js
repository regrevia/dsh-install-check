/**
 * Compares one candidate package against the packages already in the profile.
 * Findings carry the concrete key that collides, never a guessed category.
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

const DIMENSIONS = [
  { dimension: 'patchIds', kind: 'row', severity: 'hard' },
  { dimension: 'services', kind: 'service', severity: 'hard' },
  { dimension: 'tools', kind: 'tool', severity: 'warn' },
  { dimension: 'routes', kind: 'route', severity: 'warn' },
  { dimension: 'slots', kind: 'slot', severity: 'warn' },
]

/**
 * @param {object} candidate from scanPackage()
 * @param {object[]} installed scanned packages already present in the profile
 */
export function compare(candidate, installed) {
  const others = installed.filter((pkg) => pkg.name !== candidate.name)
  const findings = []

  for (const { dimension, kind, severity } of DIMENSIONS) {
    const index = indexOf(others, dimension)
    for (const key of new Set(candidate[dimension] ?? [])) {
      const owners = index.get(key)
      if (owners?.length) findings.push({ kind, severity, key, owners: [...owners] })
    }
  }

  const installedNames = new Set(others.map((pkg) => pkg.name))
  for (const [name, range] of Object.entries(candidate.peerDeps ?? {})) {
    if (isHostPackage(name) || installedNames.has(name) || name === candidate.name) continue
    findings.push({ kind: 'peer', severity: 'warn', key: name, range, owners: [] })
  }

  const hard = findings.filter((finding) => finding.severity === 'hard')
  const warn = findings.filter((finding) => finding.severity !== 'hard')
  return { ok: findings.length === 0, findings, hard, warn }
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
