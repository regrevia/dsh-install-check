/**
 * Does the running harness fall inside the range a plugin declares?
 *
 * Only answers true / false / null. null means "the range was not understood",
 * and the caller must stay silent: a wrong "it won't start" is worse than a
 * missed one. Prerelease builds count as ordinary versions, so a nightly like
 * 0.2.1-rc.3 still satisfies `^0.2.0`.
 */
const FULL = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PART = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(text) {
  const match = FULL.exec(String(text ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split('.') : [] }
}

function preCompare(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1
  if (!b.length) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) {
      const diff = Number(left) - Number(right)
      if (diff) return diff < 0 ? -1 : 1
    } else if (leftNum) return -1
    else if (rightNum) return 1
    else if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return preCompare(left.pre, right.pre)
}

function bounds(spec) {
  const match = PART.exec(spec)
  if (!match) return null
  const parts = [match[1], match[2], match[3]].map((part) => (part === undefined || /^[xX*]$/.test(part) ? null : Number(part)))
  const pre = match[4] ? `-${match[4]}` : ''
  const [major, minor, patch] = parts
  if (major === null) return { low: null, high: null }
  if (minor === null) return { low: `${major}.0.0`, high: `${major + 1}.0.0`, highOpen: true }
  if (patch === null) return { low: `${major}.${minor}.0${pre}`, high: `${major}.${minor + 1}.0`, highOpen: true }
  const upperMajor = major === 0 ? (minor === 0 ? `0.0.${patch + 1}` : `0.${minor + 1}.0`) : `${major + 1}.0.0`
  return {
    low: `${major}.${minor}.${patch}${pre}`,
    high: major === 0 && minor === 0 ? `0.0.${patch + 1}` : upperMajor,
    highOpen: true,
  }
}

/** Apply one piece of a range; null when its shape is not recognised. */
function testPiece(piece, version) {
  if (piece === '*' || piece === 'x' || piece === 'X' || piece === '') return true
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(piece)
  if (!match) return null
  const operator = match[1] ?? ''
  const spec = match[2]
  if (!parseVersion(spec)) {
    const range = bounds(spec)
    if (!range) return null
    if (operator === '' || operator === '=' || operator === '^' || operator === '~') {
      const low = range.low === null ? true : compareVersions(version, range.low) >= 0
      const high = range.high === null ? true : range.highOpen ? compareVersions(version, range.high) < 0 : compareVersions(version, range.high) <= 0
      return low && high
    }
    return null
  }
  if (operator === '' || operator === '=') return compareVersions(version, spec) === 0
  const order = compareVersions(version, spec)
  if (operator === '>=') return order >= 0
  if (operator === '>') return order > 0
  if (operator === '<=') return order <= 0
  if (operator === '<') return order < 0
  const range = bounds(spec)
  if (!range || range.high === null) return operator === '~' || operator === '^' ? true : null
  const low = compareVersions(version, range.low)
  const high = range.highOpen ? compareVersions(version, range.high) < 0 : compareVersions(version, range.high) <= 0
  return low >= 0 && high
}

/**
 * true / false / null. `false` only when every alternative in the range was
 * understood and none of them admits the version.
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (!parsed || typeof range !== 'string' || !range.trim()) return null
  let sawUnknown = false
  for (const alternative of range.split('||')) {
    const pieces = alternative.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean)
    const hyphen = /^([\w.*-]+)\s+-\s+([\w.*-]+)$/.exec(alternative.trim())
    if (hyphen) {
      const low = bounds(hyphen[1])
      const high = bounds(hyphen[2])
      if (!low || !high || low.low === null || high.low === null) {
        sawUnknown = true
        continue
      }
      if (compareVersions(version, low.low) >= 0 && compareVersions(version, high.low) <= 0) return true
      continue
    }
    let admitted = true
    for (const piece of pieces) {
      const verdict = testPiece(piece, version)
      if (verdict === null) {
        sawUnknown = true
        admitted = false
        break
      }
      if (!verdict) {
        admitted = false
        break
      }
    }
    if (admitted) return true
  }
  return sawUnknown ? null : false
}

/**
 * 'ok' | 'below' | 'above' | 'unknown'. `below` means the plugin wants a newer
 * harness than this one; `above` means it declared a ceiling this one passed.
 */
export function versionVerdict(version, range) {
  const verdict = satisfies(version, range)
  if (verdict !== false) return verdict === null ? 'unknown' : 'ok'
  const low = minOf(range)
  if (low && compareVersions(version, low) < 0) return 'below'
  return 'above'
}

function minOf(range) {
  let min = null
  for (const piece of String(range).split(/[\s|]+/)) {
    const match = /^(>=|>|=|\^|~)?(v?\d+\.\d+\.\d+[^ ]*)$/.exec(piece)
    if (!match) continue
    const version = parseVersion(match[2])
    if (!version) continue
    if (!min || compareVersions(version, min) < 0) min = version
  }
  return min
}
