/**
 * What the loader itself knows about plugins that never came up.
 *
 * The harness runs the same audit at boot and prints the failed entries, but
 * reading the live loader gives the answer at the moment it matters — the first
 * tool result after an update — and does not depend on a log file whose shape
 * is not ours.
 *
 * Fiber states are the numbers cordis assigns them: 0 pending, 1 loading,
 * 2 active, 3 failed, 4 disposed. Only `active` counts as up, and a fiber
 * waiting on a service the new build no longer provides is exactly the case a
 * declared version range cannot see.
 */

const ACTIVE = 2

/** Entry ids are load paths; the package name is what a person recognises. */
function label(entry) {
  const name = entry?.options?.name
  if (typeof name !== 'string' || !name) return null
  const parts = name.split('/')
  return parts[parts.length - 1]
}

/**
 * Names of entries the loader has not brought up, or null when this build does
 * not expose a loader at all — in that case say nothing rather than guess.
 */
export function notActive(ctx) {
  let entries
  try {
    entries = ctx?.loader?.entries?.()
    if (!entries) return null
    entries = [...entries]
  } catch {
    return null
  }

  const names = new Set()
  for (const entry of entries) {
    try {
      if (entry.disabled) continue
      const name = label(entry)
      if (!name) continue
      const fiber = entry.fiber
      if (!fiber || typeof fiber.state !== 'number') {
        names.add(name)
        continue
      }
      if (fiber.state === ACTIVE) continue
      names.add(name)
    } catch {
      // One odd entry must not hide the rest.
    }
  }
  return [...names]
}
