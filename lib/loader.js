/**
 * What the loader itself knows about plugins that never came up.
 *
 * The harness runs the same audit at boot and prints the failed entries, but
 * reading the live loader gives the answer at the moment it matters — the first
 * tool result after an update — and does not depend on a log file whose shape
 * is not ours.
 *
 * Two answers, because the fix differs: a fiber that never came up (import or
 * apply threw) waits for its own update; a fiber still waiting on a service is
 * usually missing a dependency, so the fix is to install the dependency.
 *
 * Fiber states are the numbers cordis assigns them: 0 pending, 1 loading,
 * 2 active, 3 failed, 4 disposed. Only `active` counts as up.
 */

const ACTIVE = 2
const PENDING = 0

/** Entry ids are load paths; the package name is what a person recognises. */
function label(entry) {
  const name = entry?.options?.name
  if (typeof name !== 'string' || !name) return null
  const parts = name.split('/')
  return parts[parts.length - 1]
}

function missingServices(fiber) {
  let keys
  try {
    keys = fiber?.inject && typeof fiber.inject === 'object' ? Object.keys(fiber.inject) : []
  } catch {
    return []
  }
  return keys.filter((service) => {
    try {
      return fiber.ctx?.get?.(service) === undefined
    } catch {
      return false
    }
  })
}

/**
 * Installed entries the loader has not brought up, split into those that broke
 * and those still waiting on a service. Null when this build exposes no loader
 * at all — then say nothing rather than guess.
 */
export function inactive(ctx) {
  let entries
  try {
    entries = ctx?.loader?.entries?.()
    if (!entries) return null
    entries = [...entries]
  } catch {
    return null
  }

  const broken = new Set()
  const waiting = new Set()
  for (const entry of entries) {
    try {
      if (entry.disabled) continue
      const name = label(entry)
      if (!name) continue
      const fiber = entry.fiber
      if (!fiber || typeof fiber.state !== 'number') {
        broken.add(name)
        continue
      }
      if (fiber.state === ACTIVE) continue
      if (fiber.state === PENDING) {
        // A pending fiber with nothing missing is still coming up, not broken.
        if (missingServices(fiber).length) waiting.add(name)
        continue
      }
      broken.add(name)
    } catch {
      // One odd entry must not hide the rest.
    }
  }
  return { broken: [...broken], waiting: [...waiting] }
}
