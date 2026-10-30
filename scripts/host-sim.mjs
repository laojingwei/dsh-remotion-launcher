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

/* ── 检查更新：走真实 registry，但网络失败也算通过（只断言结构） ── */
const updates = await request('GET', '/remotion-plugin/updates')
check('GET /updates 返回启动器与工程的版本', () => {
  if (updates.status !== 200) throw new Error(`HTTP ${updates.status} ${updates.body}`)
  const body = JSON.parse(updates.body)
  if (!body.plugin || !body.project) throw new Error('缺 plugin / project')
  if (typeof body.plugin.current !== 'string') throw new Error('plugin.current 不是字符串')
  console.log(`      启动器 ${body.plugin.current} → ${body.plugin.latest ?? '（查询失败/离线）'}`)
  console.log(`      工程   ${body.project.current ?? '—'} → ${body.project.latest ?? '（查询失败/离线）'}`)
})

/* ── 下载源：读写 + 校验（换源后用本机死端口，避免真联网） ── */
const regRead = await request('GET', '/remotion-plugin/registry')
check('GET /registry 返回当前下载源', () => {
  if (regRead.status !== 200) throw new Error(`HTTP ${regRead.status} ${regRead.body}`)
  const body = JSON.parse(regRead.body)
  if (!/^https?:\/\//i.test(body.registry ?? '')) throw new Error(`下载源不对：${body.registry}`)
})

const regBad = await request('POST', '/remotion-plugin/registry', JSON.stringify({ registry: 'ftp://x' }))
check('POST /registry 拒绝非 http(s) 源', () => {
  if (regBad.status !== 400) throw new Error(`期望 400，实际 ${regBad.status}`)
})

const regOk = await request('POST', '/remotion-plugin/registry',
  JSON.stringify({ registry: 'http://127.0.0.1:9' }))
check('POST /registry 保存并落盘', () => {
  if (regOk.status !== 200) throw new Error(`HTTP ${regOk.status} ${regOk.body}`)
  const body = JSON.parse(regOk.body)
  if (body.registry !== 'http://127.0.0.1:9') throw new Error(`回显不符：${body.registry}`)
  const onDisk = JSON.parse(fs.readFileSync(path.join(scratch, 'remotion-launcher.json'), 'utf8'))
  if (onDisk.registry !== 'http://127.0.0.1:9') throw new Error(`没落盘：${JSON.stringify(onDisk)}`)
  if (onDisk.fabPos?.x !== 321) throw new Error('写下载源时把按钮位置弄丢了')
})

/* ── 启动器更新：没有插件管理接口时必须明确拒绝，而不是假装在更新 ── */
const updState = await request('GET', '/remotion-plugin/state?since=0')
check('GET /state 带启动器版本/安装方式/更新状态', () => {
  const body = JSON.parse(updState.body)
  for (const key of ['plugin', 'update', 'pluginUpdate', 'registry']) {
    if (!(key in body)) throw new Error(`快照缺字段 ${key}`)
  }
  const plugin = body.plugin
  for (const key of ['name', 'version', 'kind', 'canAutoUpdate', 'hot', 'manualSpec', 'installedVersion', 'pendingRestart']) {
    if (!(key in plugin)) throw new Error(`plugin 缺字段 ${key}`)
  }
  for (const key of ['checkedAt', 'latest', 'hasUpdate', 'error']) {
    if (!(key in body.update)) throw new Error(`update 缺字段 ${key}`)
  }
  if (body.pluginUpdate.status !== 'idle') throw new Error(`初始更新状态应为 idle，实际 ${body.pluginUpdate.status}`)
  /**
   * 落盘版本和运行版本要分开报。假插件管理器给的是同一个版本，
   * 所以这里断言两者一致、且不误报「装了等重启」。
   */
  if (typeof plugin.installedVersion !== 'string') throw new Error('installedVersion 应是字符串')
  if (plugin.pendingRestart) throw new Error('版本一致时不该报待重启')
  console.log(`      启动器 ${plugin.version}（${plugin.kind}）  已安装 ${plugin.installedVersion}  热更新可用：${plugin.hot}`)
  console.log(`      静默检查：${body.update.checkedAt ? new Date(body.update.checkedAt).toLocaleTimeString() : '未检查'}  新版：${body.update.latest ?? '—'}`)
})

check('GET /state 带可直接粘贴的 MCP 配置', () => {
  const body = JSON.parse(updState.body)
  const mcp = body.mcp
  if (!mcp || typeof mcp !== 'object') throw new Error('快照缺 mcp')

  const entry = mcp.stdio?.mcpServers?.['remotion-studio']
  if (!entry) throw new Error('stdio 配置缺 remotion-studio')
  if (entry.command !== 'node') throw new Error(`stdio 命令应为 node，实际 ${entry.command}`)
  if (!Array.isArray(entry.args) || entry.args.length !== 2) throw new Error('stdio 需要两个参数（tsx + 代理）')
  for (const arg of entry.args) {
    if (!path.isAbsolute(arg)) throw new Error(`stdio 参数要绝对路径：${arg}`)
    if (arg.includes('\\')) throw new Error(`JSON 里的路径要用正斜杠：${arg}`)
  }
  if (!entry.args[0].endsWith('/node_modules/tsx/dist/cli.mjs')) throw new Error(`tsx 入口不对：${entry.args[0]}`)
  if (!entry.args[1].endsWith('/server/mcp-proxy.ts')) throw new Error(`代理入口不对：${entry.args[1]}`)

  const http = mcp.http?.mcpServers?.['remotion-studio']
  if (!http) throw new Error('http 配置缺 remotion-studio')
  if (http.type !== 'http') throw new Error(`http.type 应为 http，实际 ${http.type}`)
  if (!/\/mcp$/.test(http.url)) throw new Error(`HTTP 端点要带 /mcp：${http.url}`)
  if (!http.url.includes(`:${body.port}`)) throw new Error(`HTTP 端点端口应与面板一致：${http.url} vs ${body.port}`)
  if (entry.env?.SERVER_URL !== mcp.serverUrl) throw new Error('env.SERVER_URL 与 serverUrl 不一致')

  // stdio 要工程依赖装齐才算就绪；没装就报 false，别给假绿灯
  if (typeof mcp.stdioReady !== 'boolean' || typeof mcp.httpReady !== 'boolean') {
    throw new Error('ready 标记要是布尔')
  }
  console.log(`      stdio 就绪：${mcp.stdioReady}  HTTP 就绪：${mcp.httpReady}  端点：${http.url}`)
})

const noPm = await request('POST', '/remotion-plugin/plugin-update')
check('POST /plugin-update 无插件管理接口时 409 并说清原因', () => {
  if (noPm.status !== 409) throw new Error(`期望 409，实际 ${noPm.status}`)
  const body = JSON.parse(noPm.body)
  if (body.ok !== false) throw new Error('ok 应为 false')
  if (!/插件管理/.test(body.error ?? '')) throw new Error(`错误信息不够具体：${body.error}`)
})

const acked = await request('POST', '/remotion-plugin/plugin-update/ack')
check('POST /plugin-update/ack 清空更新标记', () => {
  if (acked.status !== 200) throw new Error(`HTTP ${acked.status} ${acked.body}`)
  const body = JSON.parse(acked.body)
  if (body.pluginUpdate?.status !== 'idle') throw new Error(`状态没清干净：${JSON.stringify(body.pluginUpdate)}`)
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
