import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, name, registerHttpRoutes } = await import('../dist/index.js')

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

test('exports name/apply/registerHttpRoutes', () => {
  assert.equal(name, 'lib-analyzer')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof registerHttpRoutes, 'function')
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

// 捕获 registerHttpRoutes 注册的路由, 并用假 res 调用它 —— 直接测我们自己的 handler
// (原生 node:http req/res), 而不是 Hono 的 Request/Response 适配层。
function captureRoutes(ctx) {
  // The fence asks the composition's `connection` service for a rejection before serving. These
  // helpers are handed a bare object ({} or a deps bag), so that read returned undefined, the fence
  // failed CLOSED with 503 -- correctly -- and the health tests asserted 503 instead of 200. The
  // stub never modelled a host; this makes it model one. The caller's object is preserved, because
  // dsh-busyloop passes { llm } and its providers tests need it.
  const withAdmittingConnection = (base) => {
    const own = base ?? {};
    return {
      ...own,
      get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : own.get?.(name)),
    };
  };
  
  const routes = new Map()
  registerHttpRoutes(withAdmittingConnection(ctx), (kind, path, handler) => { routes.set(path, { kind, handler }) })
  const call = async (path, method = 'GET') => {
    const route = routes.get(path)
    if (!route) throw new Error('no route registered at ' + path)
    const res = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
    await route.handler({ method, url: path }, res)
    return res
  }
  return { routes, call }
}

test('health route is exact /api/analyzer/health and answers 200', async () => {
  const { routes, call } = captureRoutes({})
  assert.equal(routes.get('/api/analyzer/health').kind, 'exact')
  const res = await call('/api/analyzer/health')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(String(res.body))
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-lib-analyzer')
  assert.equal(body.hono, undefined)
})

test('non-GET is rejected with 405 + allow: GET', async () => {
  const { call } = captureRoutes({})
  const res = await call('/api/analyzer/health', 'POST')
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers['allow'], 'GET')
})

test('apply registers on the official ctx.webServer, not the absent ctx.http', () => {
  const registered = []
  let effectLabel = null
  const ctx = cordisCtx({
    webServer: { register: (r) => { registered.push(r); return () => {} } },
    extra: { tools: makeCtx().tools, effect: (fn, label) => { effectLabel = label; fn() } },
  })
  apply(ctx)
  assert.deepEqual(registered.map((r) => r.path), ['/api/analyzer/health'])
  assert.match(String(effectLabel), /analyzer/)
})

// 复刻 cordis 的 ctx 代理: 读一个已注册但**未声明 inject** 的服务时, get 陷阱先抛
// "cannot get property X without inject" —— 可选链 `ctx.webServer?.x` 挡不住。
// 这正是本次迁移踩到的坑: 在 apply 里直接读 ctx.webServer 会让整个插件激活失败。
function cordisCtx({ webServer, extra = {} } = {}) {
  let inInject = false
  const target = {
    ...extra,
    inject: (deps, cb) => {
      if (!deps.includes('webServer') || !webServer) return undefined
      const prev = inInject
      inInject = true
      try { return cb({ webServer, effect: extra.effect }) } finally { inInject = prev }
    },
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'webServer' && !inInject) throw new Error('cannot get property "webServer" without inject')
      return t[prop]
    },
  })
}

test('the cordis trap is real, and apply avoids it by using ctx.inject', () => {
  const ctx = cordisCtx({ webServer: { register: () => () => {} } })
  assert.throws(() => ctx.webServer, /without inject/)
  assert.doesNotThrow(() => apply(ctx))
})

test('apply tolerates a host without webServer (no throw)', () => {
  apply(makeCtx())
  assert.doesNotThrow(() => apply(cordisCtx({ extra: { tools: makeCtx().tools } })))
})
