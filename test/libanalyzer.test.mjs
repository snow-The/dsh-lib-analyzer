import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, name, createHonoApp } = await import('../dist/index.js')

function makeCtx() {
  const tools = []
  tools.register = (t) => tools.push(t)
  return { tools }
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'libanalyzer-test-'))
  mkdirSync(join(root, 'ref', 'lib'), { recursive: true })
  writeFileSync(join(root, 'ref', 'lib', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'ref', 'lib', 'README.md'), '# lib\n')
  writeFileSync(join(root, 'ref', 'lib', 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
  return root
}

test('exports name/apply/createHonoApp', () => {
  assert.equal(name, 'lib-analyzer')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof createHonoApp, 'function')
})

test('registers four tools', () => {
  const ctx = makeCtx()
  apply(ctx)
  assert.deepEqual(ctx.tools.map((t) => t.name).sort(), ['libreport', 'libscan', 'libsearch', 'libtasks'])
})

test('libscan counts files, kinds and big-file discipline', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const root = makeProject()
  const scan = ctx.tools.find((t) => t.name === 'libscan')
  const r = await scan.execute({ root })
  assert.equal(r.ok, true)
  assert.equal(r.counts.files, 3)
  assert.equal(r.counts.srcFiles, 1)
  assert.equal(r.counts.docFiles, 1)
  assert.equal(r.bigFiles.length, 1)
  assert.ok(r.bigFiles[0].path.endsWith('big.bin'))
  assert.ok(r.bigFileDiscipline.includes('>1MB'))
  rmSync(root, { recursive: true, force: true })
})

test('libscan rejects missing root', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const scan = ctx.tools.find((t) => t.name === 'libscan')
  const r = await scan.execute({ root: join(tmpdir(), 'definitely-missing-' + Date.now()) })
  assert.equal(r.ok, false)
})

test('libtasks reports missing tasks file gracefully', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const tasks = ctx.tools.find((t) => t.name === 'libtasks')
  const r = await tasks.execute({ tasksFile: join(tmpdir(), 'no-tasks-' + Date.now() + '.jsonl') })
  assert.equal(r.ok, false)
  assert.match(r.error, /cannot read tasks file/)
})

test('health endpoint responds 200', async () => {
  const app = createHonoApp({})
  const res = await app.fetch(new Request('http://localhost/api/analyzer/health'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-lib-analyzer')
  assert.equal(body.hono, true)
})
