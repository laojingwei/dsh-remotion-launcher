/**
 * dsh-remotion-launcher —— Host 半部
 *
 * 职责：在 DSH 的 webServer 上挂一组同源路由，让浏览器里的插件面板
 * 能够「构建前端 / 启动服务 / 停止服务 / 看日志」。
 *
 * 设计要点：
 *  · 不碰项目业务代码，只 spawn 两个子进程（vite build、tsx server/index.ts）
 *  · 所有重活都在子进程里，不阻塞 DSH 的 Node 事件循环
 *  · 日志用环形缓冲，面板轮询增量拉取
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 一个目录像不像工程根：要有 package.json 和 server/ */
function looksLikeProject(dir) {
  return fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'server'))
}

/**
 * 工程根探测。
 *
 * 支持三种摆放方式：
 *   ① 插件在工程里      <工程>/dsh-plugin          → 上一级
 *   ② 插件与工程同级    <仓库>/dsh-plugin + <仓库>/remotion-studio
 *   ③ npm 安装          包在 node_modules 里，找不到 → 用 REMOTION_STUDIO_ROOT
 *
 * 用 link: 安装时 Node 会把软链解析成真实路径，所以这里拿到的是源码目录；
 * 用 tarball/npm 安装时拿到的是 node_modules，只能靠环境变量。
 */
function resolveProjectRoot() {
  const fromEnv = process.env.REMOTION_STUDIO_ROOT
  if (fromEnv) return path.resolve(fromEnv)

  const parent = path.join(PLUGIN_DIR, '..')
  const candidates = [
    parent,
    path.join(parent, 'remotion-studio-mcp'),
    path.join(parent, 'remotion-studio'),
    path.join(parent, 'app'),
    path.join(PLUGIN_DIR, '..', '..'),
  ]
  for (const dir of candidates) {
    if (looksLikeProject(dir)) return dir
  }

  // 兜底：扫同级兄弟目录，谁像工程就用谁（工程目录改名了也不怕）
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(parent, entry.name)
      if (dir === PLUGIN_DIR) continue
      if (looksLikeProject(dir)) return dir
    }
  } catch { /* 读不了就退回上一级 */ }

  return parent
}

/**
 * 工程根：可以先探测，也可以在面板里「下载项目」后改成用户选的目录。
 * 用户选过的路径持久化在 settings 里，优先于探测结果。
 */
let projectRootOverride = null
let projectRoot = resolveProjectRoot()

/** 运行端口：环境变量优先，其次面板里保存的值，最后 4380 */
let port = Number(process.env.REMOTION_PORT ?? 4380)
const PORT_FROM_ENV = Number.isFinite(Number(process.env.REMOTION_PORT))
/** 面板展示 / 打开编辑器用 localhost；探活另走 127.0.0.1 */
function baseUrl() { return `http://localhost:${port}` }
function probeUrl() { return `http://127.0.0.1:${port}` }
function projectValid() { return looksLikeProject(projectRoot) }

/** 从 npm 装的是哪个包；工程仓库单独发布，不随插件走 */
const PROJECT_PACKAGE = process.env.REMOTION_PROJECT_PACKAGE ?? 'remotion-studio-mcp'
/** 下载源：官方 / 国内镜像 / 自定义 */
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'

const MAX_LOGS = 600

/**
 * 插件自己的持久化（悬浮按钮位置 + 运行端口）存在 Host 侧，而不是浏览器 localStorage。
 * localStorage 按 origin 隔离，而 DSH 每次重启端口会变（56135 → 61124），
 * origin 一变就丢；存文件才跟端口无关。
 */
const STATE_DIR = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const SETTINGS_FILE = path.join(STATE_DIR, 'remotion-launcher.json')

/** @type {{x:number,y:number}|null} */
let fabPos = null
/** @type {{x:number,y:number}|null} 面板自身位置（拖标题栏移动） */
let panelPos = null

function persist() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const data = { fabPos, panelPos, port, projectRoot: projectRootOverride }
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return true
  } catch (error) {
    sys(`保存插件设置失败：${error && error.message ? error.message : String(error)}`)
    return false
  }
}

function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    // 旧版本直接把这个文件当 {x,y} 存，兼容一下
    const pos = raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? raw : raw?.fabPos
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      fabPos = { x: Math.round(pos.x), y: Math.round(pos.y) }
    }
    if (raw?.panelPos && Number.isFinite(raw.panelPos.x) && Number.isFinite(raw.panelPos.y)) {
      panelPos = { x: Math.round(raw.panelPos.x), y: Math.round(raw.panelPos.y) }
    }
    if (!PORT_FROM_ENV && raw && Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535) {
      port = raw.port
    }
    // 用户在面板里选的工程目录，优先于自动探测。
    // 两个坑都在这拦着：
    //  · 带 U+FFFD 的旧值是被 GBK 编码搞坏的，忽略
    //  · 目录已经不在了 / 不像工程根的旧值也忽略，回退自动探测，免得面板一直显示「未安装」
    if (typeof raw?.projectRoot === 'string' && raw.projectRoot.trim() !== ''
      && !raw.projectRoot.includes('\uFFFD')) {
      const saved = path.resolve(raw.projectRoot)
      if (looksLikeProject(saved)) {
        projectRootOverride = saved
        projectRoot = saved
      }
    }
  } catch { /* 首次运行没有这个文件，正常 */ }
}

function saveFabPos(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  fabPos = { x: Math.round(point.x), y: Math.round(point.y) }
  return persist()
}

function savePanelPos(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  panelPos = { x: Math.round(point.x), y: Math.round(point.y) }
  return persist()
}

function savePort(next) {
  port = next
  return persist()
}

/** @type {{seq:number, at:number, stream:'sys'|'build'|'server', text:string}[]} */
const logs = []
let logSeq = 0

let build = { status: 'idle', startedAt: null, finishedAt: null, code: null }
let server = { status: 'idle', startedAt: null, lastError: null, pid: null }
/** 下载 / 安装工程的进度（npm pack → 解压 → npm install） */
let install = { status: 'idle', dir: null, registry: null, startedAt: null, finishedAt: null, error: null }
let buildProc = null
let serverProc = null
let lastHealthy = false

function pushLog(stream, chunk) {
  const text = String(chunk).replace(/\u001b\[[0-9;]*m/g, '')
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    logs.push({ seq: ++logSeq, at: Date.now(), stream, text: line.slice(0, 2000) })
  }
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
}

function sys(message) {
  pushLog('sys', message)
}

async function probeHealth(timeoutMs = 1200) {
  try {
    const res = await fetch(`${probeUrl()}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 端口是否空闲：能绑定就说明没被别的程序占着。
 * 临时监听再立刻关闭，比解析 netstat 稳，也不引第三方包。
 */
function isPortFree(candidate) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(candidate, '127.0.0.1')
  })
}

async function refreshHealth() {
  lastHealthy = await probeHealth()
  if (lastHealthy && serverProc === null) {
    // 服务在跑但不是本插件起的（上一次 DSH 退出没来得及收尸，或用户手动开的）
    if (server.status !== 'external') {
      server = { status: 'external', startedAt: server.startedAt ?? Date.now(), lastError: null, pid: null }
      sys('检测到已有服务在运行（非本插件启动）')
    }
  }
  return lastHealthy
}

function killTree(proc) {
  if (!proc || proc.killed) return
  const pid = proc.pid
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      // npx 底下还会再起一层 node，只 kill 外层 shell 会留孤儿进程。
      // spawn 时开了 detached，子进程自成进程组，杀 -pid 能带走整组。
      try { process.kill(-pid, 'SIGTERM') } catch { /* 组不存在，退回单进程 */ }
      try { proc.kill('SIGTERM') } catch { /* 已经退出 */ }
    }
  } catch (error) {
    sys(`结束进程失败：${error && error.message ? error.message : String(error)}`)
  }
}

/* ── 下载 / 安装工程 ───────────────────────────────────────────── */

/**
 * 弹系统文件夹选择框（不依赖 DSH 的 directoryPicker 配置）。
 * Windows 用 PowerShell 的 FolderBrowserDialog，macOS 用 osascript，Linux 用 zenity。
 * 同步等待用户点完，返回选中的绝对路径；取消返回 null。
 */
function pickDirectoryNative() {
  return new Promise((resolve) => {
    let cmd
    let args
    if (process.platform === 'win32') {
      const script = [
        // 关键：不设成 UTF-8 的话，PowerShell 会按系统代码页（GBK）写 stdout，
        // 中文路径到 Node 这边就成了 `Remotion����������Ŀ`
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = '选择 Remotion Studio 工程目录'",
        '$d.ShowNewFolderButton = $true',
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
      ].join('; ')
      cmd = 'powershell'
      args = ['-NoProfile', '-STA', '-Command', script]
    } else if (process.platform === 'darwin') {
      cmd = 'osascript'
      args = ['-e', 'POSIX path of (choose folder with prompt "选择 Remotion Studio 工程目录")']
    } else {
      cmd = 'zenity'
      args = ['--file-selection', '--directory', '--title=选择 Remotion Studio 工程目录']
    }

    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (error) {
      sys(`打开目录选择框失败：${error.message}`)
      resolve(null)
      return
    }
    let out = ''
    child.stdout?.on('data', (data) => { out += String(data) })
    child.on('error', (error) => {
      sys(`打开目录选择框失败：${error.message}`)
      resolve(null)
    })
    child.on('exit', (code) => {
      // 去掉可能的 BOM 和换行
      const picked = out.replace(/^\uFEFF/, '').trim()
      if (picked && picked.includes('\uFFFD')) {
        sys('目录选择返回了乱码，请改用「手动粘贴路径」')
        resolve(null)
        return
      }
      resolve(code === 0 && picked ? picked : null)
    })
  })
}

/** 跑一条命令并把输出接到面板日志；返回退出码 */
function runStep(label, cmd, args, options = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { ...options, shell: true, windowsHide: true })
    } catch (error) {
      pushLog('install', `${label} 启动失败：${error.message}`)
      resolve(1)
      return
    }
    child.stdout?.on('data', (data) => pushLog('install', data))
    child.stderr?.on('data', (data) => pushLog('install', data))
    child.on('error', (error) => {
      pushLog('install', `${label} 启动失败：${error.message}`)
      resolve(1)
    })
    child.on('exit', (code) => {
      pushLog('install', `▸ ${label} 结束（exit ${code}）`)
      resolve(code ?? 1)
    })
  })
}

async function installProject({ dir, registry }) {
  install = { status: 'running', dir, registry, startedAt: Date.now(), finishedAt: null, error: null }
  const tmp = path.join(STATE_DIR, `install-${Date.now()}`)
  try {
    fs.mkdirSync(tmp, { recursive: true })
    pushLog('install', `▸ 下载 ${PROJECT_PACKAGE}@latest（源：${registry}）`)

    const packCode = await runStep('npm pack', 'npm', [
      'pack', `${PROJECT_PACKAGE}@latest`, `--registry=${registry}`, '--pack-destination', tmp,
    ])
    if (packCode !== 0) throw new Error('下载失败（npm pack 非 0 退出）')

    const tgz = fs.readdirSync(tmp).find((file) => file.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack 没有产出 .tgz')

    fs.mkdirSync(dir, { recursive: true })
    pushLog('install', `▸ 解压到 ${dir}`)
    const unpackCode = await runStep('解压', 'tar', [
      '-xzf', path.join(tmp, tgz), '-C', dir, '--strip-components=1',
    ])
    if (unpackCode !== 0) throw new Error('解压失败（需要系统里的 tar，Windows 10+ 自带）')

    pushLog('install', '▸ 安装依赖（这一步最慢，几分钟）')
    const npmCode = await runStep('npm install', 'npm', [
      'install', `--registry=${registry}`, '--no-audit', '--no-fund',
    ], { cwd: dir })
    if (npmCode !== 0) throw new Error('npm install 非 0 退出（依赖可能不完整）')

    projectRootOverride = dir
    projectRoot = dir
    persist()
    install = { ...install, status: 'success', finishedAt: Date.now(), error: null }
    sys(`工程已就绪：${dir}`)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    install = { ...install, status: 'failed', finishedAt: Date.now(), error: message }
    sys(`安装失败：${message}`)
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch { /* 临时目录清不掉也不影响 */ }
  }
}

/* ── 构建 ───────────────────────────────────────────────────────── */

function startBuild() {
  if (buildProc) {
    sys('构建已在进行中')
    return false
  }
  build = { status: 'running', startedAt: Date.now(), finishedAt: null, code: null }
  sys('开始构建前端：npx vite build')
  buildProc = spawn('npx', ['vite', 'build'], {
    cwd: projectRoot,
    shell: true,
    windowsHide: true,
    // POSIX 上让它自成进程组，停止时能整组带走；Windows 不需要（用 taskkill /T）
    detached: process.platform !== 'win32',
    env: { ...process.env },
  })
  buildProc.stdout.on('data', (data) => pushLog('build', data))
  buildProc.stderr.on('data', (data) => pushLog('build', data))
  buildProc.on('error', (error) => {
    sys(`构建进程启动失败：${error.message}`)
    build = { status: 'failed', startedAt: build.startedAt, finishedAt: Date.now(), code: -1 }
    buildProc = null
  })
  buildProc.on('exit', (code) => {
    build = {
      status: code === 0 ? 'success' : 'failed',
      startedAt: build.startedAt,
      finishedAt: Date.now(),
      code,
    }
    sys(code === 0 ? '构建完成' : `构建失败（exit ${code}）`)
    buildProc = null
  })
  return true
}

/* ── 服务 ───────────────────────────────────────────────────────── */

async function startServer() {
  if (serverProc) {
    sys('服务进程已存在')
    return false
  }
  if (await probeHealth()) {
    lastHealthy = true
    server = { status: 'external', startedAt: Date.now(), lastError: null, pid: null }
    sys(`端口 ${port} 上已有服务在运行，未重复启动`)
    return false
  }
  if (!(await isPortFree(port))) {
    server = { status: 'failed', startedAt: Date.now(), lastError: `端口 ${port} 被其他程序占用`, pid: null }
    sys(`端口 ${port} 被其他程序占用，请在面板里换一个端口再启动`)
    return false
  }
  server = { status: 'starting', startedAt: Date.now(), lastError: null, pid: null }
  sys(`启动服务：npx tsx server/index.ts（PORT=${port}）`)
  serverProc = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: projectRoot,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PORT: String(port),
      CODEBUDDY_SAFE_DELETE_ENABLED: '0',
    },
  })
  server.pid = serverProc.pid ?? null
  serverProc.stdout.on('data', (data) => pushLog('server', data))
  serverProc.stderr.on('data', (data) => pushLog('server', data))
  serverProc.on('error', (error) => {
    sys(`服务进程启动失败：${error.message}`)
    server = { status: 'failed', startedAt: server.startedAt, lastError: error.message, pid: null }
    serverProc = null
  })
  serverProc.on('exit', (code) => {
    const wasStopping = server.status === 'stopping'
    sys(wasStopping ? '服务已停止' : `服务进程退出（exit ${code}）`)
    // 不论是不是主动停止，退出后状态必须是 stopped —— 之前这里留了
    // "stopping 就不更新" 的分支，配合下面超时兜底的空判断，会永久卡在「停止中…」
    server = {
      status: 'stopped',
      startedAt: server.startedAt,
      lastError: wasStopping || code === 0 ? null : `exit ${code}`,
      pid: null,
    }
    serverProc = null
  })

  // 轮询就绪；最多等 90 秒
  const deadline = Date.now() + 90_000
  const tick = async () => {
    if (serverProc === null) return
    if (await probeHealth()) {
      lastHealthy = true
      if (server.status === 'starting') {
        server.status = 'running'
        sys(`服务就绪：${baseUrl()}`)
      }
      return
    }
    if (Date.now() > deadline) {
      server.lastError = '启动超时（90s 内 /api/health 未就绪）'
      sys(server.lastError)
      return
    }
    setTimeout(tick, 600)
  }
  setTimeout(tick, 400)
  return true
}

function stopServer() {
  if (!serverProc) {
    sys('没有由本插件启动的服务在运行')
    return false
  }
  server.status = 'stopping'
  sys('正在停止服务')
  killTree(serverProc)
  // 兜底：正常路径由 exit 回调恢复状态；这里只处理"进程赖着不走"的情况，
  // 4 秒后仍停在 stopping 就强制清空，避免按钮永久卡在「停止中…」
  setTimeout(() => {
    if (server.status !== 'stopping') return
    if (serverProc) killTree(serverProc)
    serverProc = null
    server = { status: 'stopped', startedAt: server.startedAt, lastError: null, pid: null }
    sys('停止超时，已强制清理进程状态（进程可能仍在后台，必要时用任务管理器结束）')
  }, 4000)
  return true
}

function snapshot(sinceSeq) {
  const since = Number(sinceSeq ?? 0) || 0
  const fresh = logs.filter((entry) => entry.seq > since)
  return {
    projectRoot,
    projectValid: projectValid(),
    projectPackage: PROJECT_PACKAGE,
    defaultRegistry: DEFAULT_REGISTRY,
    install: { ...install },
    port,
    url: baseUrl(),
    healthy: lastHealthy,
    build: { ...build },
    server: { ...server, running: serverProc !== null },
    fabPos,
    panelPos,
    logSeq,
    logs: fresh.length > 0 ? fresh : [],
  }
}

/** 读 POST 的 JSON body；畸形或过大都按空对象处理，避免拖拽上报拖垮路由。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) break
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/* ── HTTP 路由 ──────────────────────────────────────────────────── */

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname.replace(/\/+$/, '')
  const method = (req.method ?? 'GET').toUpperCase()
  const action = pathname.slice('/remotion-plugin'.length) || '/'

  const reply = (code, body) => {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  try {
    if (action === '/' || action === '/state') {
      if (method === 'GET') {
        await refreshHealth()
        return reply(200, snapshot(url.searchParams.get('since')))
      }
    }
    if (action === '/build' && method === 'POST') {
      if (!projectValid()) return reply(409, { ok: false, error: '还没有工程，先在上方「下载项目」' })
      if (install.status === 'running') return reply(409, { ok: false, error: '正在下载/安装工程，先等它完成' })
      // 与面板保持一致：服务在跑时不允许构建
      if (serverProc) return reply(409, { ok: false, error: '服务运行中，先停止再构建' })
      const started = startBuild()
      return reply(200, { ok: started, ...snapshot(0) })
    }
    if (action === '/start' && method === 'POST') {
      if (!projectValid()) return reply(409, { ok: false, error: '还没有工程，先在上方「下载项目」' })
      if (install.status === 'running') return reply(409, { ok: false, error: '正在下载/安装工程，先等它完成' })
      // 构建期间 dist 正在重写，这时起服务容易读到半份前端，直接拒绝
      if (buildProc) return reply(409, { ok: false, error: '正在构建前端，等构建完成再启动服务' })
      const started = await startServer()
      return reply(200, { ok: started, ...snapshot(0) })
    }
    if (action === '/pick-dir' && method === 'POST') {
      // 面板上「选择」按钮的兜底：直接弹系统文件夹选择框，不依赖 DSH 的 directoryPicker
      const dir = await pickDirectoryNative()
      return reply(200, { ok: Boolean(dir), dir })
    }
    if (action === '/use-project' && method === 'POST') {
      // 换成本机已有的工程目录：不下载，只校验 + 记住
      const body = await readJsonBody(req)
      const dir = String((body && body.dir) ?? '').trim()
      if (!dir) return reply(400, { ok: false, error: '请选择工程目录' })
      if (!path.isAbsolute(dir)) return reply(400, { ok: false, error: '目录要填绝对路径' })
      if (install.status === 'running') return reply(409, { ok: false, error: '正在下载/安装中，请稍候' })
      if (serverProc) return reply(409, { ok: false, error: '服务运行中，先停止再切换工程' })
      if (!looksLikeProject(dir)) {
        return reply(400, { ok: false, error: '这个目录里没有 package.json 和 server/，不像工程根' })
      }
      projectRootOverride = dir
      projectRoot = dir
      persist()
      // 换了工程，旧的状态（构建/服务）不再适用
      build = { status: 'idle', startedAt: null, finishedAt: null, code: null }
      server = { status: 'idle', startedAt: null, lastError: null, pid: null }
      sys(`工程目录已切换：${dir}`)
      return reply(200, { ok: true, ...snapshot(0) })
    }
    if (action === '/install-project' && method === 'POST') {
      const body = await readJsonBody(req)
      const dir = String((body && body.dir) ?? '').trim()
      const registry = String((body && body.registry) ?? DEFAULT_REGISTRY).trim()
      if (install.status === 'running') return reply(409, { ok: false, error: '正在下载/安装中，请稍候' })
      if (serverProc) return reply(409, { ok: false, error: '服务运行中，先停止再安装工程' })
      if (!dir) return reply(400, { ok: false, error: '请选择下载目录' })
      if (!path.isAbsolute(dir)) return reply(400, { ok: false, error: '目录要填绝对路径' })
      if (!/^https?:\/\//i.test(registry)) return reply(400, { ok: false, error: '下载源要是 http(s) 地址' })
      // 异步跑，客户端靠轮询 state 看进度
      void installProject({ dir, registry })
      return reply(200, { ok: true, ...snapshot(0) })
    }
    if (action === '/stop' && method === 'POST') {
      const stopped = stopServer()
      return reply(200, { ok: stopped, ...snapshot(0) })
    }
    if (action === '/reset' && method === 'POST') {
      // 自救出口：状态卡死（比如停止超时）时只清状态，不动进程表以外的任何东西
      if (buildProc) killTree(buildProc)
      buildProc = null
      serverProc = null
      build = { status: 'idle', startedAt: null, finishedAt: null, code: null }
      server = { status: 'idle', startedAt: null, lastError: null, pid: null }
      sys('已重置插件状态（若有残留进程，端口被占时启动会提示）')
      return reply(200, { ok: true, ...snapshot(0) })
    }
    if (action === '/logs' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      return reply(200, { logSeq, logs: logs.filter((entry) => entry.seq > since) })
    }
    if (action === '/pos') {
      if (method === 'GET') return reply(200, { ok: true, fabPos })
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (!body || !Number.isFinite(body.x) || !Number.isFinite(body.y)) {
          return reply(400, { ok: false, error: '需要 { x: number, y: number }' })
        }
        const saved = saveFabPos({ x: body.x, y: body.y })
        return reply(200, { ok: saved, fabPos })
      }
    }
    if (action === '/panel-pos') {
      if (method === 'GET') return reply(200, { ok: true, panelPos })
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (!body || !Number.isFinite(body.x) || !Number.isFinite(body.y)) {
          return reply(400, { ok: false, error: '需要 { x: number, y: number }' })
        }
        const saved = savePanelPos({ x: body.x, y: body.y })
        return reply(200, { ok: saved, panelPos })
      }
    }
    if (action === '/port') {
      if (method === 'GET') return reply(200, { ok: true, port })
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const next = Number(body && body.port)
        if (!Number.isInteger(next) || next < 1024 || next > 65535) {
          return reply(400, { ok: false, error: '端口必须是 1024–65535 之间的整数' })
        }
        if (serverProc) {
          return reply(409, { ok: false, error: '服务正在运行，请先停止再改端口' })
        }
        if (next !== port && !(await isPortFree(next))) {
          return reply(409, { ok: false, error: `端口 ${next} 已被其他程序占用，换一个` })
        }
        savePort(next)
        sys(`运行端口已改为 ${next}`)
        return reply(200, { ok: true, port })
      }
    }
    return reply(404, { error: `未知接口：${method} ${pathname}` })
  } catch (error) {
    sys(`路由处理异常：${error && error.stack ? error.stack : String(error)}`)
    return reply(500, { error: String(error && error.message ? error.message : error) })
  }
}

/* ── 插件入口 ───────────────────────────────────────────────────── */

export const name = 'dsh-remotion-launcher'

export const inject = ['webServer']

export function apply(ctx) {
  loadPersisted()
  sys(`按钮位置文件：${SETTINGS_FILE}${fabPos ? `（已恢复 ${fabPos.x},${fabPos.y}）` : '（尚未拖动过）'}`)
  sys(`运行端口：${port}${PORT_FROM_ENV ? '（来自环境变量 REMOTION_PORT）' : '（可在面板中修改）'}`)

  if (projectValid()) {
    sys(`插件已加载，工程目录：${projectRoot}`)
  } else {
    sys(`插件已加载，但还没找到工程：${projectRoot}`)
    sys(`  可以在面板里「下载项目」：选目录 + 下载源，会自动 npm pack → 解压 → npm install（包名 ${PROJECT_PACKAGE}）。`)
    sys('  也可以手动把工程放到某个目录，然后设 REMOTION_STUDIO_ROOT 指过去。')
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/remotion-plugin',
      handler: handle,
    })
    return dispose
  }, 'dsh-remotion-launcher: routes')

  // 启动时探一次：服务是不是已经跑着（上次没关干净 / 用户手动开的）
  refreshHealth().catch(() => {})

  // 插件卸载 / DSH 退出时收尸，避免端口被孤儿进程占着
  ctx.effect(() => {
    return () => {
      if (buildProc) killTree(buildProc)
      if (serverProc) killTree(serverProc)
    }
  }, 'dsh-remotion-launcher: cleanup')
}
