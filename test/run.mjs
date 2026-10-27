import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPackage } from '../lib/signature.js'
import { compare } from '../lib/check.js'
import { render } from '../lib/report.js'
import { scanSkills, findSkillConflicts, skillRoots } from '../lib/skills.js'
import { renderSkills } from '../lib/report.js'
import { scanPackageClient } from '../lib/client.js'
import { renderTakeover } from '../lib/report.js'
import { checkInstall, apply, resetSkillWatch } from '../index.js'

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
  assert.equal(result.breaks.length, 3)
  assert.equal(result.missing.length, 1)
  const tool = result.findings.find((finding) => finding.kind === 'tool')
  assert.deepEqual(tool.owners, ['alpha-memory'])
})

test('says what breaks and what to do about it', async () => {
  const { alpha, beta } = await workspace()
  const candidate = scanPackage(beta)
  const result = compare(candidate, [scanPackage(alpha)])
  const text = render(candidate, result)
  const zh = text.zh.split('\n')
  assert.equal(zh.length, 3)
  assert.match(zh[0], /^冲突：和 alpha-memory 用同一个工具名 memory_save，用同一个服务 memoryStore，装在同一个位置，两个只能留一个。$/)
  assert.match(zh[1], /^两个都想要，先停用 alpha-memory 再重启。$/)
  assert.match(zh[2], /^缺 @scope\/ghost，装上它之前这个插件起不来。$/)
  assert.match(text.en, /^Conflict:/)
  assert.doesNotMatch(text.zh, /模型只会看到一个|都注册工具|服务，后装的会顶掉/)
})

test('reads a colliding target end to end', async () => {
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
  assert.equal(await checkInstall({ name: 'plugin_manager', arguments: { action: 'set_bundle', target: 'x', enabled: false } }), null)
  assert.equal(await checkInstall({ name: 'plugin_manager', arguments: { action: 'remove_bundle', target: 'x' } }), null)
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

function fakeContext(extra = {}) {
  const handlers = {}
  return {
    handlers,
    ...extra,
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

test('never stops the install, notes the takeover afterwards', async () => {
  const { alpha, beta } = await workspace()
  const profile = await profileWith(alpha)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', arguments: { action: 'install_bundle', target: beta } }
  const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'installed' }] })

  const before = await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, allow))
  assert.equal(before.kind, 'accept')

  const after = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow),
  )
  assert.equal(after.content.length, 2)
  assert.match(after.content[1].text, /memoryStore/)
  assert.match(after.content[1].text, /停用 alpha-memory/)
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

async function skillDir(root, folder, frontmatter) {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nbody\n`)
  return dir
}

const WORKBOOK = 'Format and validate a spreadsheet workbook, freeze header rows, add formulas, recalculate cached values'
const WORKBOOK_PDF = 'Format and validate a spreadsheet workbook, freeze header rows, add formulas, recalculate cached values, export to PDF'

test('two skills with one name: one of them never loads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  await skillDir(join(home, '.dsh', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report.')
  await skillDir(join(home, '.agents', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report with charts.')

  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.names.length, 1)
  assert.equal(conflicts.names[0].name, 'weekly-report')
  assert.equal(conflicts.names[0].paths.length, 2)
  const zh = renderSkills(conflicts).zh.split('\n')
  assert.equal(zh.length, 1)
  assert.match(zh[0], /^冲突：两个 skill 都叫 weekly-report，只会生效一个。留一个，或给其中一个改名。$/)
  assert.match(renderSkills(conflicts).en, /^Conflict: two skills are both named weekly-report/)
})

test('two skills that answer the same requests: the model picks wrong', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.agents', 'skills')
  await skillDir(root, 'sheet-edit', `name: sheet-edit\ndescription: ${WORKBOOK}.`)
  await skillDir(root, 'print-sheet', `name: print-sheet\ndescription: ${WORKBOOK_PDF}.`)
  await skillDir(root, 'salsa', 'name: salsa\ndescription: Write dance choreography notes for a salsa rehearsal.')

  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.names.length, 0)
  assert.equal(conflicts.overlaps.length, 1)
  assert.deepEqual([conflicts.overlaps[0].a, conflicts.overlaps[0].b].sort(), ['print-sheet', 'sheet-edit'])
  const zh = renderSkills(conflicts).zh.split('\n')
  assert.equal(zh.length, 1)
  assert.match(zh[0], /^撞车：(sheet-edit|print-sheet) 和 (sheet-edit|print-sheet) 的触发描述几乎一样，模型会挑错。改其中一个的描述，或只留一个。$/)
})

test('two versions of one skill are not a conflict', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.agents', 'skills')
  await skillDir(root, 'tool-stable', `name: tool-stable\ndescription: ${WORKBOOK}.`)
  await skillDir(root, 'tool-next', `name: tool-next\ndescription: ${WORKBOOK_PDF}.`)
  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.overlaps.length, 0)
})

test('distinct skills stay quiet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-skills-'))
  const root = join(home, '.dsh', 'skills')
  await skillDir(root, 'deploy', 'name: deploy\ndescription: Ship the current branch to the staging cluster.')
  await skillDir(root, 'invoice', 'name: invoice\ndescription: Reconcile supplier invoices against the ledger.')
  const conflicts = findSkillConflicts(scanSkills(skillRoots(home)))
  assert.equal(conflicts.names.length, 0)
  assert.equal(conflicts.overlaps.length, 0)
  assert.equal(renderSkills(conflicts).zh, '')
})

test('a dropped skill folder gets one note on the next tool result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'install-check-home-'))
  await skillDir(join(home, '.dsh', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report.')
  await skillDir(home, '.agents-placeholder', 'name: x\ndescription: x')

  const before = process.env.INSTALL_CHECK_HOME
  process.env.INSTALL_CHECK_HOME = home
  resetSkillWatch()
  try {
    const ctx = fakeContext()
    apply(ctx)
    const accept = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'copied' }] })
    const quiet = await ctx.handlers['tools/post-execute']({ name: 'bash', arguments: {} }, { isError: false }, accept)
    assert.equal(quiet.content.length, 1)

    await skillDir(join(home, '.agents', 'skills'), 'weekly-report', 'name: weekly-report\ndescription: Build the weekly revenue report with charts.')
    resetSkillWatch()
    const after = await ctx.handlers['tools/post-execute']({ name: 'bash', arguments: {} }, { isError: false }, accept)
    assert.equal(after.content.length, 2)
    assert.match(after.content[1].text, /两个 skill 都叫 weekly-report/)

    const again = await ctx.handlers['tools/post-execute']({ name: 'bash', arguments: {} }, { isError: false }, accept)
    assert.equal(again.content.length, 1)
  } finally {
    if (before === undefined) delete process.env.INSTALL_CHECK_HOME
    else process.env.INSTALL_CHECK_HOME = before
    resetSkillWatch()
  }
})

async function clientPackage(client) {
  const dir = await mkdtemp(join(tmpdir(), 'install-check-client-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'task-graph-like',
    version: '0.1.0',
    exports: { './client': './client.js' },
    dsh: { client: { inject: [], platform: 'web' } },
  }))
  await writeFile(join(dir, 'client.js'), client)
  return dir
}

test('a plugin that fills a guessed host container is flagged', async () => {
  const dir = await clientPackage([
    "const host = document.querySelector('[class*=\"centerCol\"]') ?? document.body",
    "const css = '.v{position:fixed;inset:0;z-index:200}'",
    'host.appendChild(view)',
    '',
  ].join('\n'))
  const hit = scanPackageClient(dir)
  assert.equal(hit?.pane, 'host')
  assert.match(renderTakeover().zh, /铺满全屏/)
})

test('a plugin that renders into a slot stays quiet', async () => {
  const dir = await clientPackage([
    "const css = '.v{position:absolute;inset:0}'",
    'ctx.slot.register("sidebar.right.pane.tab", () => view)',
    '',
  ].join('\n'))
  assert.equal(scanPackageClient(dir), null)
})

test('a range that excludes this version is a mismatch, not a guess', async () => {
  const { satisfies, versionVerdict } = await import('../lib/compat.js')
  assert.equal(satisfies('0.2.1-rc.3', '>=0.2.0-rc.1'), true)
  assert.equal(satisfies('0.2.1-rc.3', '^0.2.0'), true)
  assert.equal(satisfies('0.2.1-rc.3', '>=0.2.0-rc.2 || >=0.2.1-rc.2'), true)
  assert.equal(versionVerdict('0.2.1-rc.3', '^0.3.0'), 'below')
  assert.equal(versionVerdict('0.9.0', '^0.2.0'), 'above')
  assert.equal(versionVerdict('0.2.1-rc.3', 'workspace:*'), 'unknown')
  assert.equal(versionVerdict('0.2.1-rc.3', 'nightly'), 'unknown')
})

test('a plugin that needs a newer harness is named before the install lands', async () => {
  const { resetShellVersion } = await import('../lib/shell.js')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const needsNew = await fixture(root, {
    manifest: { name: 'needs-new', version: '1.0.0', dsh: { engines: { dsh: '^0.3.0' }, bundle: { patch: './cordis.patch.yml' } } },
    files: {
      'cordis.patch.yml': ['- insert:', '    - id: needs-new', '      name: needs-new', ''].join('\n'),
      'index.js': 'export const inject = []\nexport function apply() {}\n',
    },
  })
  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.1-rc.3'
  resetShellVersion()
  try {
    const checked = await checkInstall(
      { name: 'plugin_manager', arguments: { action: 'install_bundle', target: needsNew } },
      { profileDir: profile },
    )
    assert.match(checked.text.zh, /版本对不上/)
    assert.match(checked.text.zh, /\^0\.3\.0/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
  }
})

test('after a harness update, installed plugins left behind are named once', async () => {
  const { resetShellVersion } = await import('../lib/shell.js')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const alphaManifest = join(profile, 'node_modules', 'alpha-memory', 'package.json')
  const manifest = JSON.parse(await readFile(alphaManifest, 'utf8'))
  manifest.dsh = { ...manifest.dsh, engines: { dsh: '^0.3.0' } }
  await writeFile(alphaManifest, JSON.stringify(manifest))
  await writeFile(join(profile, '.install-check-version.json'), JSON.stringify({ version: '0.2.1-rc.3' }))
  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.9.0'
  resetShellVersion()
  try {
    const ctx = fakeContext()
    apply(ctx)
    const exec = { name: 'some_tool', arguments: {} }
    const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    const after = await withProfile(profile, () =>
      ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow),
    )
    const text = after.content.map((item) => item.text).join('\n')
    assert.match(text, /0\.9\.0/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
  }
})

async function postNote(profile, ctx) {
  return withProfile(profile, async () => {
    const exec = { name: 'some_tool', arguments: {} }
    const allow = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    const decision = await ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, allow)
    return decision.content.map((item) => item.text).join('\n')
  })
}

test('the loader answer splits what broke from what is only waiting', async () => {
  const { inactive } = await import('../lib/loader.js')
  const entries = [
    { options: { name: 'alpha-memory' }, fiber: { state: 3 } },
    { options: { name: 'no-fiber-row' } },
    {
      options: { name: '@scope/waiting' },
      fiber: { state: 0, inject: { sidebarRight: {} }, ctx: { get: () => undefined } },
    },
    { options: { name: 'fine' }, fiber: { state: 0, inject: { tools: {} }, ctx: { get: () => ({}) } } },
    { options: { name: 'healthy' }, fiber: { state: 2 } },
    { options: { name: 'off-by-choice' }, disabled: true },
  ]
  assert.deepEqual(inactive({ loader: { entries: () => entries } }), {
    broken: ['alpha-memory'],
    waiting: ['waiting'],
  })
  assert.equal(inactive({}), null)
})

test('an update names what broke, and says apart what only lost a dependency', async () => {
  const { resetShellVersion } = await import('../lib/shell.js')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  await writeFile(join(profile, '.install-check-version.json'), JSON.stringify({ version: '0.2.1-rc.3' }))
  await mkdir(join(profile, 'node_modules', 'waiting-dep'), { recursive: true })
  await writeFile(
    join(profile, 'node_modules', 'waiting-dep', 'package.json'),
    JSON.stringify({ name: 'waiting-dep', version: '1.0.0' }),
  )
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['alpha-memory', 'waiting-dep'] } } }),
  )

  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.2'
  resetShellVersion()
  try {
    const ctx = fakeContext({
      loader: {
        entries: () => [
          { options: { name: 'alpha-memory' }, fiber: { state: 3 } },
          {
            options: { name: 'waiting-dep' },
            fiber: { state: 0, inject: { sidebarRight: {} }, ctx: { get: () => undefined } },
          },
          { options: { name: 'not-installed' }, fiber: { state: 3 } },
        ],
      },
    })
    apply(ctx)
    const text = await postNote(profile, ctx)
    assert.match(text, /升级后起不来：alpha-memory/)
    assert.match(text, /升级后没接上：waiting-dep/)
    assert.doesNotMatch(text, /not-installed/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('a first sighting still reports what is not running, and an unchanged version stays quiet', async () => {
  const { resetShellVersion } = await import('../lib/shell.js')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)

  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.2'
  resetShellVersion()
  try {
    const ctx = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(ctx)
    assert.match(await postNote(profile, ctx), /升级后起不来：alpha-memory/)

    const quiet = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(quiet)
    assert.equal(await postNote(profile, quiet), 'ok')
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('the official default decision still gets the note', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', token: 'call-1', arguments: { action: 'install_bundle', target: gamma } }
  // The host's own default: accept the original result, no content copied.
  const accept = async () => ({ kind: 'accept' })
  const original = [{ type: 'text', text: 'installed' }]

  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, accept))
  const after = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](exec, { isError: false, content: original }, accept),
  )
  assert.equal(after.content.length, 2)
  assert.equal(after.content[0].text, 'installed')
  assert.match(after.content[1].text, /memory_save/)
})

test('a reminder stays with its own call', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const accept = async () => ({ kind: 'accept' })
  const first = { name: 'plugin_manager', token: 'call-a', arguments: { action: 'install_bundle', target: gamma } }
  // Another tool whose arguments happen to carry the same target.
  const other = { name: 'read_file', token: 'call-b', arguments: { target: gamma } }

  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](first, accept))

  const stray = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](other, { isError: false, content: [] }, accept),
  )
  assert.equal(stray.content, undefined)

  const second = { name: 'plugin_manager', token: 'call-c', arguments: { action: 'install_bundle', target: gamma } }
  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](second, accept))
  const own = await withProfile(profile, () =>
    ctx.handlers['tools/post-execute'](first, { isError: false, content: [] }, accept),
  )
  assert.match(JSON.stringify(own.content), /memory_save/)
})

test('a decision that replaces the value is left alone', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', token: 'call-v', arguments: { action: 'install_bundle', target: 'x' } }
  const replace = async () => ({ kind: 'accept', value: { ok: true } })
  const after = await ctx.handlers['tools/post-execute'](exec, { isError: false, content: [] }, replace)
  assert.deepEqual(after, { kind: 'accept', value: { ok: true } })
})

test('checking a Git target never runs its prepare script', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { existsSync } = await import('node:fs')
  const { materialize } = await import('../lib/materialize.js')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'install-check-git-'))
  const marker = join(root, 'prepare-ran')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'candidate',
      version: '1.0.0',
      scripts: { prepare: "node -e \"require('fs').writeFileSync('prepare-ran','x')\"" },
    }),
  )
  await writeFile(join(root, 'index.js'), 'export const x = 1\n')
  try {
    try {
      await run('git', ['init', '-q'], { cwd: root })
    } catch {
      return // no git on this machine: nothing to prove here
    }
    await run('git', ['add', '-A'], { cwd: root })
    await run('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: root })
    const packed = await materialize(`git+file://${root}`, { timeoutMs: 60000 })
    try {
      assert.equal(existsSync(marker), false, 'the candidate build script ran during a read-only check')
      assert.ok(existsSync(join(packed.dir, 'package.json')), 'the packed candidate could not be read')
    } finally {
      await packed.cleanup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a loader that is still moving is not called broken', async () => {
  const { inactive } = await import('../lib/loader.js')
  const entries = [
    { options: { name: 'coming-up' }, fiber: { state: 1 } },
    { options: { name: 'going-down' }, fiber: { state: 5 } },
    { options: { name: 'no-fiber-row' } },
    { options: { name: 'healthy' }, fiber: { state: 2 } },
  ]
  assert.deepEqual(inactive({ loader: { entries: () => entries } }), { broken: [], waiting: [] })
})

test('a build without a loader does not consume the first sighting', async () => {
  const { existsSync } = await import('node:fs')
  const { resetShellVersion } = await import('../lib/shell.js')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const state = join(profile, '.install-check-version.json')

  const before = process.env.DSH_SHELL_VERSION
  process.env.DSH_SHELL_VERSION = '0.2.2'
  resetShellVersion()
  try {
    const blind = fakeContext()
    apply(blind)
    assert.equal(await postNote(profile, blind), 'ok')
    assert.equal(JSON.parse(await readFile(state, 'utf8')).loader, false, 'an unreadable loader must not count as checked')

    const seeing = fakeContext({
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(seeing)
    assert.match(await postNote(profile, seeing), /升级后起不来：alpha-memory/)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})

test('declared ranges follow the host rules', async () => {
  const { versionVerdict } = await import('../lib/compat.js')
  const cases = [
    ['1.9.0', '~1.2.3', 'above'],
    ['1.3.0', '^1.2', 'ok'],
    ['1.5.4', '1.2 - 1.5', 'ok'],
    ['0.2.1', '^0.3', 'below'],
    ['0.2.1', '^0.2.0', 'ok'],
    ['0.3.0', '^0.2.0', 'above'],
    ['1.2.3', '>=1.0.0 <2', 'ok'],
    ['2.0.0', '>=1.0.0 <2', 'above'],
    ['1.2.4', '1.2.3', 'above'],
    ['1.3.0', '~1.2', 'above'],
    ['0.2.1-rc.3', '^0.2.0', 'ok'],
  ]
  for (const [version, range, want] of cases) {
    assert.equal(versionVerdict(version, range), want, `${version} vs ${range}`)
  }
})

test('a change the host refused gets no advice about it', async () => {
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const gamma = await fixture(root, GAMMA)
  const ctx = fakeContext()
  apply(ctx)
  const exec = { name: 'plugin_manager', token: 'call-refused', arguments: { action: 'install_bundle', target: gamma } }
  const accept = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'failed' }] })
  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](exec, accept))
  const result = { isError: false, content: [{ type: 'text', text: 'failed' }], value: JSON.stringify({ application: 'failed' }) }
  const after = await withProfile(profile, () => ctx.handlers['tools/post-execute'](exec, result, accept))
  assert.deepEqual(after.content, [{ type: 'text', text: 'failed' }])

  const kept = { name: 'plugin_manager', token: 'call-kept', arguments: { action: 'install_bundle', target: gamma } }
  await withProfile(profile, () => ctx.handlers['tools/pre-execute'](kept, accept))
  const applied = { isError: false, content: [{ type: 'text', text: 'installed' }], value: JSON.stringify({ application: 'applied' }) }
  const withNote = await withProfile(profile, () => ctx.handlers['tools/post-execute'](kept, applied, accept))
  assert.equal(withNote.content.length, 2)
  assert.match(withNote.content[1].text, /memory_save/)
})

test('the profile the host launched wins over the environment', async () => {
  const { existsSync } = await import('node:fs')
  const { resetShellVersion } = await import('../lib/shell.js')
  const { root, alpha } = await workspace()
  const profile = await profileWith(alpha)
  const elsewhere = join(root, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })

  const before = process.env.DSH_SHELL_VERSION
  const beforeDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_SHELL_VERSION = '0.2.2'
  process.env.DSH_PROFILE_DIR = elsewhere
  resetShellVersion()
  try {
    const ctx = fakeContext({
      get: (name) => (name === 'profileContext' ? { dir: profile } : undefined),
      loader: { entries: () => [{ options: { name: 'alpha-memory' }, fiber: { state: 3 } }] },
    })
    apply(ctx)
    assert.match(await postNote(profile, ctx), /升级后起不来：alpha-memory/)
    assert.equal(existsSync(join(elsewhere, '.install-check-version.json')), false)
    assert.equal(existsSync(join(profile, '.install-check-version.json')), true)
  } finally {
    if (before === undefined) delete process.env.DSH_SHELL_VERSION
    else process.env.DSH_SHELL_VERSION = before
    if (beforeDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = beforeDir
    resetShellVersion()
    await rm(root, { recursive: true, force: true })
  }
})
