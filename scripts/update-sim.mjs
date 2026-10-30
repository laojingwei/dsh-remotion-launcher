/**
 * 更新流程仿真：假的 pluginManager + 本地假 registry，验证
 *
 *   1. npm 安装 → 点更新：先 remove 再 install，全程不重启（HMR 存在）
 *   2. Git/GitHub 安装 → 点更新：明确拒绝，提示手动卸载重装
 *   3. 装新版失败 → 自动回滚到原版本，状态落在 rolled-back
 *   4. 没有 HMR → 不卸载，直接装，结果标 restart-required
 *
 * 不联网、不碰真实 DSH：registry 是本机 http server，DSH_HOME 是临时目录。
 *
 * 用法：node scripts/update-sim.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const scratch = path.join(os.tmpdir(), `dsh-remotion-launcher-update-${process.pid}`)
process.env.DSH_HOME = scratch
fs.rmSync(scratch, { recursive: true, force: true })

/* ── 本地假 registry：只认 /<pkg>/latest ── */
const LATEST = '9.9.9'
const registry = http.createServer((req, res) => {
  const match = /^\/(.+)\/latest$/.exec(req.url ?? '')
  if (!match) {
    res.writeHead(404).end('{}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ name: decodeURIComponent(match[1]), version: LATEST }))
})
await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve))
const registryUrl = `http://127.0.0.1:${registry.address().port}`
process.env.DSH_REGISTRY = registryUrl

/* ── 假插件管理器 ── */
const calls = []
const fakePm = {
  source: 'dsh-remotion-launcher@^1.0.6',
  removable: true,
  version: '1.0.6',
  failInstallOf: null,
  async listBundles() {
    return [{
      name: 'dsh-remotion-launcher',
      source: fakePm.source,
      version: fakePm.version,
      removable: fakePm.removable,
      enabled: true,
    }]
  },
  async removeBundle(name) {
    calls.push(`remove:${name}`)
    return { changed: true, application: 'applied', stage: 'remove', target: name }
  },
  async installBundle(spec) {
    calls.push(`install:${spec}`)
    if (fakePm.failInstallOf && spec.includes(fakePm.failInstallOf)) {
      return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error' } }
    }
    // 真的把包装上：后面 listBundles 回读到的版本要跟着变
    fakePm.version = spec.slice(spec.lastIndexOf('@') + 1)
    return { changed: true, application: 'applied', stage: 'install', target: spec }
  },
}

let hmrPresent = true
const fakeCtx = {
  webServer: {
    register() { return () => {} },
  },
  effect(fn) { return fn() },
  get(name) {
    if (name === 'hmr') return hmrPresent ? { enabled: true } : undefined
    return undefined
  },
  inject(deps, cb) {
    if (Array.isArray(deps) && deps.includes('pluginManager')) cb({ pluginManager: fakePm })
  },
}
const routes = []
fakeCtx.webServer.register = (route) => { routes.push(route); return () => {} }

const mod = await import(new URL('../index.js', import.meta.url).href)
mod.apply(fakeCtx)
await new Promise((resolve) => setTimeout(resolve, 60))

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ✗ ${name}\n    ${error && error.message ? error.message : String(error)}`)
  }
}

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function request(method, url, body) {
  return new Promise((resolve) => {
    const res = {
      writeHead(code, headers) { this.statusCode = code; this.headers = headers },
      end(value) { resolve({ status: this.statusCode, body: String(value ?? '') }) },
    }
    Promise.resolve(routes[0].handler(makeReq(method, url, body), res)).then(() => {
      setTimeout(() => resolve({ status: 0, body: '<no response>' }), 4000)
    })
  })
}

const state = async () => JSON.parse((await request('GET', '/remotion-plugin/state?since=0')).body)

/* ── 1. 来源识别 + npm 热更新 ── */
const before = await state()
check('识别为 npm 安装，允许一键更新且走热更新', () => {
  if (before.plugin.kind !== 'npm') throw new Error(`kind 应为 npm，实际 ${before.plugin.kind}`)
  if (!before.plugin.canAutoUpdate) throw new Error('canAutoUpdate 应为 true')
  if (!before.plugin.hot) throw new Error('hot 应为 true（宿主有 HMR）')
})

const accepted = await request('POST', '/remotion-plugin/plugin-update')
check('POST /plugin-update 返回 202（先回响应再动插件）', () => {
  if (accepted.status !== 202) throw new Error(`期望 202，实际 ${accepted.status} ${accepted.body}`)
})

await new Promise((resolve) => setTimeout(resolve, 500))
const afterUpdate = await state()
check('热更新顺序：先 remove 再 install 到新版本', () => {
  const removeAt = calls.indexOf('remove:dsh-remotion-launcher')
  const installAt = calls.findIndex((c) => c === 'install:dsh-remotion-launcher@9.9.9')
  if (removeAt === -1) throw new Error(`没有调用 removeBundle：${JSON.stringify(calls)}`)
  if (installAt === -1) throw new Error(`没有装 9.9.9：${JSON.stringify(calls)}`)
  if (removeAt > installAt) throw new Error('顺序错了，应该先卸载再装')
})

check('更新结果落到 done，且不需要重启', () => {
  const pu = afterUpdate.pluginUpdate
  if (pu.status !== 'done') throw new Error(`状态应为 done，实际 ${pu.status}（${pu.error ?? ''}）`)
  if (pu.to !== LATEST) throw new Error(`to 应为 ${LATEST}，实际 ${pu.to}`)
  if (pu.restartRequired) throw new Error('热更新不该要求重启')
  console.log(`      ${pu.from} → ${pu.to}　${pu.restartRequired ? '需重启' : '热更新'}`)
})

check('更新标记落盘（DSH 中途退出也能看到结果）', () => {
  const file = path.join(scratch, 'remotion-launcher-update.json')
  if (!fs.existsSync(file)) throw new Error('没有写出标记文件')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw.status !== 'done') throw new Error(`文件里的状态是 ${raw.status}`)
})

const acked = await request('POST', '/remotion-plugin/plugin-update/ack')
check('POST /plugin-update/ack 收起完成提示', () => {
  const pu = JSON.parse(acked.body).pluginUpdate
  if (pu.status !== 'idle') throw new Error(`应为 idle，实际 ${pu.status}`)
})

/* ── 2. 非 npm 安装：只提示手动重装 ── */
fakePm.source = 'github:laojingwei/dsh-remotion-launcher'
calls.length = 0
const gitRejected = await request('POST', '/remotion-plugin/plugin-update')
check('GitHub 安装点更新被拒绝，且说清要手动卸载', () => {
  if (gitRejected.status !== 409) throw new Error(`期望 409，实际 ${gitRejected.status}`)
  const body = JSON.parse(gitRejected.body)
  if (!/手动卸载/.test(body.error ?? '')) throw new Error(`提示不清楚：${body.error}`)
  if (calls.length !== 0) throw new Error(`不该动插件：${JSON.stringify(calls)}`)
})

/* ── 3. 装不上要自己回滚 ── */
fakePm.source = 'dsh-remotion-launcher@^1.0.6'
fakePm.failInstallOf = LATEST
calls.length = 0
await request('POST', '/remotion-plugin/plugin-update')
await new Promise((resolve) => setTimeout(resolve, 500))
const rolled = await state()
check('装新版失败后回滚到原版本', () => {
  const pu = rolled.pluginUpdate
  if (pu.status !== 'rolled-back') throw new Error(`状态应为 rolled-back，实际 ${pu.status}（${pu.error ?? ''}）`)
  if (!/已回滚/.test(pu.rollback ?? '')) throw new Error(`回滚说明不对：${pu.rollback}`)
  // 回滚目标就是这次更新的起点版本，不写死数字：package.json 改版本不该让测试红
  const expected = `install:dsh-remotion-launcher@${pu.from}`
  if (!calls.some((c) => c === expected)) {
    throw new Error(`没有尝试装回原版本 ${pu.from}：${JSON.stringify(calls)}`)
  }
  if (/@undefined$/.test(expected)) throw new Error('回滚目标版本是空的')
  console.log(`      ${pu.error}　${pu.rollback}`)
})

/* ── 4. 没有 HMR：不卸载，装完要求重启 ── */
await request('POST', '/remotion-plugin/plugin-update/ack')
fakePm.failInstallOf = null
hmrPresent = false
calls.length = 0
await request('POST', '/remotion-plugin/plugin-update')
await new Promise((resolve) => setTimeout(resolve, 500))
const noHmr = await state()
check('无 HMR 时不卸载，只装新版并标记需重启', () => {
  if (calls.some((c) => c.startsWith('remove:'))) throw new Error(`不该卸载：${JSON.stringify(calls)}`)
  const pu = noHmr.pluginUpdate
  if (pu.status !== 'done') throw new Error(`状态应为 done，实际 ${pu.status}`)
  if (pu.restartRequired) {
    console.log('      装完提示重启（fake install 返回 applied，真实 DSH 视情况返回 restart-required）')
  }
})

registry.close()
fs.rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
