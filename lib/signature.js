/**
 * Reads a plugin package the way the Loader will see it: which tools it
 * registers, which services it provides, which routes and slots it claims.
 *
 * Static only. Nothing is imported or executed.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const JS_EXT = new Set(['.js', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', 'docs', 'examples', 'coverage'])
const MAX_FILES = 80
const MAX_BYTES = 512 * 1024

const SCHEMA_WORDS = new Set([
  'type', 'description', 'properties', 'required', 'schema', 'parameters', 'items',
  'enum', 'default', 'title', 'additionalproperties', 'oneof', 'anyof', 'const',
])

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/
const PLAIN = /^[a-z][a-z0-9]{1,48}$/

function listJsFiles(dir, out = [], depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listJsFiles(path, out, depth + 1)
    } else if (JS_EXT.has(extname(entry.name))) {
      out.push(path)
    }
  }
  return out
}

function readText(path) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text
  } catch {
    return ''
  }
}

function collect(text, pattern, group = 1) {
  const out = []
  for (const match of text.matchAll(pattern)) {
    const value = match[group]
    if (value) out.push(value)
  }
  return out
}

function quoted(text) {
  return collect(text, /['"]([^'"\n]+)['"]/g)
}

/**
 * Tool names: only files that register tools at all, and only strings that
 * look like tool names (snake_case, or a plain word right next to a call site).
 */
function extractTools(text) {
  if (!/tools\.register|defineTool|registerTool/.test(text)) return []
  const out = []
  for (const match of text.matchAll(/\bname\s*:\s*['"]([a-z][a-z0-9_]{1,48})['"]/g)) {
    const value = match[1]
    if (SCHEMA_WORDS.has(value)) continue
    const near = text.slice(Math.max(0, match.index - 400), match.index)
    if (SNAKE.test(value) || /tools\.register|defineTool|registerTool/.test(near)) out.push(value)
  }
  return out
}

/**
 * Services: `.provide('key')` / `ctx.set('key', ...)`, plus lazy reads the
 * plugin performs itself (`ctx.get('key')`), which are soft dependencies.
 */
function extractServices(text) {
  return [
    ...collect(text, /\.provide\s*\(\s*['"]([A-Za-z][\w@/.-]*)['"]/g),
    ...collect(text, /\bctx\.set\s*\(\s*['"]([A-Za-z][\w@/.-]*)['"]/g),
  ]
}

function extractLazyGets(text) {
  return collect(text, /\bctx\.get\s*\(\s*['"]([A-Za-z][\w@/.-]*)['"]/g)
}

/**
 * Routes the web server keys by (kind, path) and rejects duplicates outright,
 * so both halves of the key have to be read. Only literals are visible here:
 * a path held in a constant is not a claim this check can make.
 */
function extractRoutes(text) {
  const found = []
  const both = [
    /kind:\s*['"](exact|prefix)['"][\s\S]{0,200}?path:\s*['"](\/[^'"]*)['"]/g,
    /path:\s*['"](\/[^'"]*)['"][\s\S]{0,200}?kind:\s*['"](exact|prefix)['"]/g,
  ]
  for (const pattern of both) {
    let match
    while ((match = pattern.exec(text))) {
      const kind = match[1] === 'exact' || match[1] === 'prefix' ? match[1] : match[2]
      const path = match[1].startsWith('/') ? match[1] : match[2]
      found.push(kind + ':' + path)
    }
  }
  for (const path of collect(text, /registerUpgrade\(\s*\{[\s\S]{0,200}?path:\s*['"](\/[^'"]*)['"]/g)) {
    found.push('upgrade:' + path)
  }
  if (/registerFallback\s*\(/.test(text)) found.push('fallback')
  return found
}

function extractSlots(text) {
  return collect(text, /slots\.(?:register|inject)\s*\(\s*['"]([\w.:-]+)['"]/g)
}

function extractPatchIds(patchText) {
  return [
    ...collect(patchText, /^\s*-\s*id:\s*['"]?([\w@/.:-]+)['"]?\s*$/gm),
    ...collect(patchText, /^\s+id:\s*['"]?([\w@/.:-]+)['"]?\s*$/gm),
  ]
}

/**
 * Rows a patch adds versus rows it only edits. A patch that names an existing
 * id without `insert` overrides that row, so it is not claiming the row.
 */
function patchClaims(patchText) {
  const inserts = new Set()
  const overrides = new Set()
  let insertIndent = null
  for (const line of patchText.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.replace(/^\s+/, '').length
    const trimmed = line.trim()
    if (insertIndent !== null && indent <= insertIndent) insertIndent = null
    if (/^-?\s*insert:\s*$/.test(trimmed)) {
      insertIndent = indent
      continue
    }
    const id = /^-?\s*id:\s*['"]?([\w@/.:-]+)['"]?\s*$/.exec(trimmed)
    if (!id) continue
    if (insertIndent !== null && indent > insertIndent) inserts.add(id[1])
    else overrides.add(id[1])
  }
  return { inserts: [...inserts], overrides: [...overrides] }
}

function extractPatchNames(patchText) {
  return collect(patchText, /^\s*-?\s*name:\s*['"]?(@?[\w@/.:-]+)['"]?\s*$/gm)
}

function patchRowCount(patchText) {
  return extractPatchIds(patchText).length
}

/**
 * @param {string} dir package directory
 * @returns {object} signature used for collision checks
 */
export function scanPackage(dir) {
  const manifestPath = join(dir, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    manifest = null
  }

  const files = listJsFiles(dir)
  const texts = files.map((file) => ({ file, text: readText(file) }))

  const tools = new Set()
  const services = new Set()
  const lazyGets = new Set()
  const routes = new Set()
  const slots = new Set()

  for (const { text } of texts) {
    for (const name of extractTools(text)) tools.add(name)
    for (const name of extractServices(text)) services.add(name)
    for (const name of extractLazyGets(text)) lazyGets.add(name)
    for (const route of extractRoutes(text)) routes.add(route)
    for (const slot of extractSlots(text)) slots.add(slot)
  }

  let patchIds = []
  let patchNames = []
  let patchInserts = []
  let patchOverrides = []
  const patchPath = manifest?.dsh?.bundle?.patch
  if (patchPath && existsSync(join(dir, patchPath))) {
    const patchText = readText(join(dir, patchPath))
    const claims = patchClaims(patchText)
    patchIds = [...new Set(extractPatchIds(patchText))]
    patchNames = [...new Set(extractPatchNames(patchText))]
    patchInserts = claims.inserts
    patchOverrides = claims.overrides
  }

  return {
    name: manifest?.name ?? dir,
    version: manifest?.version ?? '',
    dir,
    manifest,
    isPlugin: Boolean(manifest?.dsh?.bundle || manifest?.dsh?.client || patchIds.length),
    tools: [...tools], // ui-copy-ignore
    services: [...services], // ui-copy-ignore
    lazyGets: [...lazyGets], // ui-copy-ignore
    routes: [...routes], // ui-copy-ignore
    slots: [...slots], // ui-copy-ignore
    patchIds,
    patchInserts, // ui-copy-ignore
    patchOverrides, // ui-copy-ignore
    patchNames,
    peerDeps: manifest?.peerDependencies ?? {},
    clientInject: manifest?.dsh?.client?.inject ?? [],
    filesScanned: files.length,
    truncated: files.length >= MAX_FILES,
    patchRows: patchRowCount(manifest?.dsh?.bundle?.patch ? readText(join(dir, manifest.dsh.bundle.patch)) : ''),
  }
}

export { listJsFiles }
