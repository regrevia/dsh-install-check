/**
 * Measures real collision rates for a category of market packages.
 *
 *   node scripts/scan-market.mjs names.txt [out.json]
 *
 * One package name per line. Prints a compact summary and writes the full
 * per-package signature for inspection.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { materialize } from '../lib/materialize.js'
import { scanPackage } from '../lib/signature.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/scan-market.mjs <names.txt> [out.json]')
  process.exit(1)
}

const names = readFileSync(file, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))

const results = []
const queue = [...names]
const started = Date.now()

async function worker() {
  while (queue.length) {
    const name = queue.shift()
    try {
      const { dir, cleanup } = await materialize(name, { timeoutMs: 60000 })
      try {
        const signature = scanPackage(dir)
        results.push({
          name,
          ok: true,
          isPlugin: signature.isPlugin,
          tools: signature.tools,
          services: signature.services,
          routes: signature.routes,
          slots: signature.slots,
          peers: Object.keys(signature.peerDeps ?? {}),
        })
      } finally {
        await cleanup()
      }
    } catch (error) {
      results.push({ name, ok: false, error: String(error?.message ?? error).slice(0, 140) })
    }
    if (results.length % 5 === 0) console.error(`[${results.length}/${names.length}] ${(Date.now() - started) / 1000}s`)
  }
}

await Promise.all(Array.from({ length: 4 }, worker))

const plugins = results.filter((result) => result.ok && result.isPlugin)

function collisions(dimension) {
  const index = new Map()
  for (const plugin of plugins) {
    for (const key of plugin[dimension] ?? []) {
      if (!index.has(key)) index.set(key, [])
      index.get(key).push(plugin.name)
    }
  }
  return [...index]
    .filter(([, owners]) => owners.length > 1)
    .map(([key, owners]) => ({ key, owners }))
    .sort((a, b) => b.owners.length - a.owners.length)
}

const report = {
  scanned: names.length,
  plugins: plugins.length,
  notPlugins: results.filter((result) => result.ok && !result.isPlugin).map((result) => result.name),
  failed: results.filter((result) => !result.ok),
  collisions: {
    tools: collisions('tools'),
    services: collisions('services'),
    routes: collisions('routes'),
    slots: collisions('slots'),
  },
  packages: plugins,
}

const dest = process.argv[3] ?? 'scan-result.json'
writeFileSync(dest, JSON.stringify(report, null, 2))

const hit = new Set(
  Object.values(report.collisions)
    .flat()
    .flatMap((collision) => collision.owners),
)

console.log(
  JSON.stringify(
    {
      scanned: report.scanned,
      plugins: report.plugins,
      notPlugins: report.notPlugins.length,
      failed: report.failed.length,
      collidingPackages: hit.size,
      collisions: Object.fromEntries(
        Object.entries(report.collisions).map(([dimension, list]) => [dimension, list.length]),
      ),
      seconds: Math.round((Date.now() - started) / 1000),
    },
    null,
    2,
  ),
)
