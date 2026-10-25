import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPackage } from '../lib/signature.js'
import { compare } from '../lib/check.js'
import { render } from '../lib/report.js'
import { checkInstall, apply } from '../index.js'

const PATCH = ['- insert:', '    - id: alpha-memory', '      name: alpha-memory', ''].join('\n')

const ALPHA = {
  manifest: {
    name: 'alpha-memory',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  },
  files: {
    'cordis.patch.yml': PATCH,
    'index.js': [
      "export const inject = ['tools']",
      'export function apply(ctx) {',
      "  ctx.tools.register(defineTool({ name: 'memory_save', description: 'save' }))",
      "  ctx.provide('memoryStore', {})",
      '}',
      '',
    ].join('\n'),
  },
}

const BETA = {
  manifest: {
    name: 'beta-memory',
    version: '2.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@scope/ghost': '^1.0.0' },
  },
  files: {
    'cordis.patch.yml': PATCH,
    'index.js': [
      'export function apply(ctx) {',
      "  ctx.tools.register(defineTool({ name: 'memory_save', description: 'save too' }))",
      "  ctx.provide('memoryStore', {})",
      '}',
      '',
    ].join('\n'),
  },
}

async function fixture(parent, spec) {
  const dir = join(parent, spec.manifest.name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(spec.manifest, null, 2))
  for (const [name, body] of Object.entries(spec.files)) {
    await writeFile(join(dir, name), body)
  }
  return dir
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'install-check-test-'))
  const alpha = await fixture(root, ALPHA)
  const beta = await fixture(root, BETA)
  return { root, alpha, beta }
}

test('reads tools, services and loader rows from source', async () => {
  const { alpha } = await workspace()
  const signature = scanPackage(alpha)
  assert.equal(signature.isPlugin, true)
  assert.deepEqual(signature.tools, ['memory_save'])
  assert.deepEqual(signature.services, ['memoryStore'])
  assert.deepEqual(signature.patchIds, ['alpha-memory'])
})

test('reports the exact keys that collide, plus missing peers', async () => {
  const { alpha, beta } = await workspace()
  const result = compare(scanPackage(beta), [scanPackage(alpha)])
  const kinds = result.findings.map((finding) => finding.kind).sort()
  assert.deepEqual(kinds, ['peer', 'row', 'service', 'tool'])
  assert.equal(result.hard.length, 2)
  const tool = result.findings.find((finding) => finding.kind === 'tool')
  assert.deepEqual(tool.owners, ['alpha-memory'])
})

test('renders two sentences and one suggestion', async () => {
  const { alpha, beta } = await workspace()
  const candidate = scanPackage(beta)
  const result = compare(candidate, [scanPackage(alpha)])
  const text = render(candidate, result)
  assert.match(text.zh, /memory_save/)
  assert.match(text.zh, /建议先停用 alpha-memory/)
  assert.match(text.en, /disable alpha-memory/i)
})

test('install hook asks once when the candidate collides', async () => {
  const { root, alpha, beta } = await workspace()
  const profile = join(root, 'profile')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['alpha-memory'] } } }))
  await cp(alpha, join(profile, 'node_modules', 'alpha-memory'), { recursive: true })

  const decision = await checkInstall(
    { name: 'plugin_manager', arguments: { action: 'install_bundle', target: beta } },
    { profileDir: profile },
  )
  assert.equal(decision.result.findings.length, 4)
  assert.match(decision.text.zh, /alpha-memory/)
})

test('stays out of the way when the target is not a plugin', async () => {
  const { root } = await workspace()
  const plain = join(root, 'plain')
  await mkdir(plain, { recursive: true })
  await writeFile(join(plain, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }))
  const decision = await checkInstall({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: plain } })
  assert.equal(decision, null)
})

test('ignores calls that are not installs', async () => {
  assert.equal(await checkInstall({ name: 'plugin_manager', arguments: { action: 'list_plugins' } }), null)
  assert.equal(await checkInstall({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'x' } }), null)
})

const GAMMA = {
  manifest: {
    name: 'gamma-memory',
    version: '3.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  },
  files: {
    'cordis.patch.yml': ['- insert:', '    - id: gamma-memory', '      name: gamma-memory', ''].join('\n'),
    'index.js': [
      'export function apply(ctx) {',
      "  ctx.tools.register(defineTool({ name: 'memory_save', description: 'same tool, nothing else' }))",
      '}',
      '',
    ].join('\n'),
  },
}

function fakeContext() {
  const handlers = {}
  return {
    handlers,
    on(event, handler) {
      handlers[event] = handler
    },
    use() {},
    effect() {},
  }
}

async function profileWith(alpha) {
  const root = await mkdtemp(join(tmpdir(), 'install-check-hook-'))
  const profile = join(root, 'profile')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['alpha-memory'] } } }))
  await cp(alpha, join(profile, 'node_modules', 'alpha-memory'), { recursive: true })
  return profile
}

async function withProfile(profile, run) {
  const before = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  try {
    return await run()
  } finally {
    if (before === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = before
  }
}

test('asks when the candidate would take over a row or service', async () => {
  const { alpha, beta } = await workspace()
  const profile = await profileWith(alpha)
  const ctx = fakeContext()
  apply(ctx)
  const decision = await withProfile(profile, () =>
    ctx.handlers['tools/pre-execute'](
      { name: 'plugin_manager', arguments: { action: 'install_bundle', target: beta } },
      async () => ({ kind: 'allow' }),
    ),
  )
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /alpha-memory/)
})

test('lets a tool-name overlap install and appends the note', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', arguments: { action: 'install_bundle', target: gamma } }
  const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'installed' }] })

  const before = await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, allow))
  assert.equal(before.kind, 'accept')

  const after = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow),
  )
  assert.equal(after.content.length, 2)
  assert.match(after.content[1].text, /memory_save/)
})
