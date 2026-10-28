/**
 * host 半区仿真：用假的 cordis Context 调 apply()，验证路由注册、响应形状，
 * 以及悬浮按钮位置的落盘往返。
 *
 * 位置文件会写到临时目录，不碰真实的 DSH_HOME。
 *
 * 用法：node scripts/host-sim.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = path.join(os.tmpdir(), `dsh-remotion-launcher-sim-${process.pid}`)
process.env.DSH_HOME = scratch
fs.rmSync(scratch, { recursive: true, force: true })

const routes = []
const effects = []

const fakeCtx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  effect(fn, label) {
    effects.push(label)
    return fn()
  },
}

const mod = await import(new URL('../index.js', import.meta.url).href)
mod.apply(fakeCtx)

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

console.log('路由注册：')
check('注册了 prefix /remotion-plugin', () => {
  const route = routes.find((r) => r.path === '/remotion-plugin')
  if (!route) throw new Error(`没找到路由，实际：${JSON.stringify(routes.map((r) => r.path))}`)
  if (route.kind !== 'prefix') throw new Error(`kind 应为 prefix，实际 ${route.kind}`)
  if (typeof route.handler !== 'function') throw new Error('handler 不是函数')
})

check('effect 带标签（HMR 安全）', () => {
  if (effects.length === 0) throw new Error('没有用 ctx.effect 包裹')
})

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
      end(value) { resolve({ status: this.statusCode, headers: this.headers, body: String(value ?? '') }) },
    }
    Promise.resolve(routes[0].handler(makeReq(method, url, body), res)).then(() => {
      setTimeout(() => resolve({ status: 0, body: '<no response>' }), 80)
    })
  })
}

console.log('接口行为：')
const state = await request('GET', '/remotion-plugin/state?since=0')
check('GET /state 返回 200 与完整快照', () => {
  if (state.status !== 200) throw new Error(`HTTP ${state.status} ${state.body}`)
  const body = JSON.parse(state.body)
  for (const key of ['projectRoot', 'port', 'url', 'build', 'server', 'logs']) {
    if (!(key in body)) throw new Error(`快照缺字段 ${key}`)
  }
  if (typeof body.port !== 'number') throw new Error('port 不是数字')
  console.log(`      工程：${body.projectRoot}`)
  console.log(`      端口：${body.port}  健康：${body.healthy}`)
})

const saved = await request('POST', '/remotion-plugin/pos', JSON.stringify({ x: 321, y: 234 }))
check('POST /pos 落盘并回显', async () => {
  if (saved.status !== 200) throw new Error(`HTTP ${saved.status} ${saved.body}`)
  const body = JSON.parse(saved.body)
  if (!body.ok) throw new Error('保存失败')
  if (body.fabPos?.x !== 321 || body.fabPos?.y !== 234) throw new Error(`回显不符：${JSON.stringify(body.fabPos)}`)
  const file = path.join(scratch, 'remotion-launcher.json')
  if (!fs.existsSync(file)) throw new Error('位置文件没有写出来')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  const pos = onDisk.fabPos ?? onDisk
  if (pos.x !== 321 || pos.y !== 234) throw new Error(`文件内容不符：${JSON.stringify(onDisk)}`)
})

const after = await request('GET', '/remotion-plugin/state?since=0')
check('GET /state 带回 fabPos（刷新后能恢复位置）', () => {
  const body = JSON.parse(after.body)
  if (body.fabPos?.x !== 321 || body.fabPos?.y !== 234) throw new Error(`fabPos 不符：${JSON.stringify(body.fabPos)}`)
})

const panelSaved = await request('POST', '/remotion-plugin/panel-pos', JSON.stringify({ x: 140, y: 260 }))
check('POST /panel-pos 落盘并回显（面板拖动）', () => {
  if (panelSaved.status !== 200) throw new Error(`HTTP ${panelSaved.status} ${panelSaved.body}`)
  const body = JSON.parse(panelSaved.body)
  if (body.panelPos?.x !== 140 || body.panelPos?.y !== 260) throw new Error(`回显不符：${JSON.stringify(body.panelPos)}`)
  const onDisk = JSON.parse(fs.readFileSync(path.join(scratch, 'remotion-launcher.json'), 'utf8'))
  if (onDisk.panelPos?.x !== 140) throw new Error(`文件里没有 panelPos：${JSON.stringify(onDisk)}`)
  if (onDisk.fabPos?.x !== 321) throw new Error('写面板位置时把按钮位置弄丢了')
})

const panelState = await request('GET', '/remotion-plugin/state?since=0')
check('GET /state 带回 panelPos', () => {
  const body = JSON.parse(panelState.body)
  if (body.panelPos?.x !== 140 || body.panelPos?.y !== 260) throw new Error(`panelPos 不符：${JSON.stringify(body.panelPos)}`)
})

const bad = await request('POST', '/remotion-plugin/pos', JSON.stringify({ x: 'nope' }))
check('POST /pos 畸形入参返回 400', () => {
  if (bad.status !== 400) throw new Error(`期望 400，实际 ${bad.status}`)
})

const portState = await request('GET', '/remotion-plugin/state?since=0')
const currentPort = JSON.parse(portState.body).port

const badPort = await request('POST', '/remotion-plugin/port', JSON.stringify({ port: 80 }))
check('POST /port 拒绝越界端口', () => {
  if (badPort.status !== 400) throw new Error(`期望 400，实际 ${badPort.status}`)
})

const okPort = await request('POST', '/remotion-plugin/port', JSON.stringify({ port: 4399 }))
check('POST /port 保存成功并回显', () => {
  if (okPort.status !== 200) throw new Error(`HTTP ${okPort.status} ${okPort.body}`)
  const body = JSON.parse(okPort.body)
  if (body.port !== 4399) throw new Error(`回显端口不符：${body.port}`)
  const file = path.join(scratch, 'remotion-launcher.json')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (onDisk.port !== 4399) throw new Error(`端口没落盘：${JSON.stringify(onDisk)}`)
})

const readBack = await request('GET', '/remotion-plugin/state?since=0')
check('GET /state 返回新端口与新 URL', () => {
  const body = JSON.parse(readBack.body)
  if (body.port !== 4399) throw new Error(`端口不符：${body.port}`)
  if (!body.url.endsWith(':4399')) throw new Error(`URL 不符：${body.url}`)
})

// 还原，避免影响后续断言
await request('POST', '/remotion-plugin/port', JSON.stringify({ port: currentPort }))

/* ── 下载项目：只测参数校验，不真的去 npm install ── */
const noDir = await request('POST', '/remotion-plugin/install-project', JSON.stringify({ dir: '' }))
check('POST /install-project 缺目录返回 400', () => {
  if (noDir.status !== 400) throw new Error(`期望 400，实际 ${noDir.status}`)
})

const relDir = await request('POST', '/remotion-plugin/install-project', JSON.stringify({ dir: 'relative/path' }))
check('POST /install-project 相对路径返回 400', () => {
  if (relDir.status !== 400) throw new Error(`期望 400，实际 ${relDir.status}`)
})

const badRegistry = await request('POST', '/remotion-plugin/install-project',
  JSON.stringify({ dir: path.join(scratch, 'proj'), registry: 'ftp://example.com' }))
check('POST /install-project 非 http(s) 源返回 400', () => {
  if (badRegistry.status !== 400) throw new Error(`期望 400，实际 ${badRegistry.status}`)
})

const snapshotFields = await request('GET', '/remotion-plugin/state?since=0')
check('GET /state 带工程/下载相关字段', () => {
  const body = JSON.parse(snapshotFields.body)
  for (const key of ['projectValid', 'projectPackage', 'defaultRegistry', 'install']) {
    if (!(key in body)) throw new Error(`快照缺字段 ${key}`)
  }
  if (typeof body.projectValid !== 'boolean') throw new Error('projectValid 不是布尔')
  console.log(`      工程有效：${body.projectValid}  包名：${body.projectPackage}`)
})

/* ── 换工程目录：只测校验，不真的切 ── */
const useMissing = await request('POST', '/remotion-plugin/use-project', JSON.stringify({ dir: '' }))
check('POST /use-project 缺目录返回 400', () => {
  if (useMissing.status !== 400) throw new Error(`期望 400，实际 ${useMissing.status}`)
})

const useRelative = await request('POST', '/remotion-plugin/use-project', JSON.stringify({ dir: 'some/where' }))
check('POST /use-project 相对路径返回 400', () => {
  if (useRelative.status !== 400) throw new Error(`期望 400，实际 ${useRelative.status}`)
})

const useNotProject = await request('POST', '/remotion-plugin/use-project',
  JSON.stringify({ dir: path.join(scratch, 'not-a-project') }))
check('POST /use-project 非工程目录返回 400 且说清原因', () => {
  if (useNotProject.status !== 400) throw new Error(`期望 400，实际 ${useNotProject.status}`)
  const body = JSON.parse(useNotProject.body)
  if (!/package\.json/.test(body.error ?? '')) throw new Error(`错误信息不够具体：${body.error}`)
})

const missing = await request('GET', '/remotion-plugin/nope')
check('未知接口返回 404 JSON', () => {
  if (missing.status !== 404) throw new Error(`期望 404，实际 ${missing.status}`)
  JSON.parse(missing.body)
})

fs.rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
