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

/* ── MCP 配置 ───────────────────────────────────────────────────── */
/** 连接器里认的服务器名，也是工具前缀（mcp__remotion-studio__*） */
const MCP_SERVER_NAME = 'remotion-studio'

/** JSON 里统一用正斜杠：Windows 路径不用再写一堆 \\ */
function toPosix(target) {
  return String(target).replace(/\\/g, '/')
}

function isFile(target) {
  try { return fs.statSync(target).isFile() } catch { return false }
}

/**
 * 给连接器管理页粘贴的那段 JSON。
 *
 * 两种接法各有用：
 *  · stdio —— 常驻子进程，第一次调用会自己把本地服务拉起来；改代码要重连才生效
 *  · http  —— 连已经在跑的服务（端点要带 /mcp），不起新进程，服务停了就断
 *
 * 路径都用绝对路径 + 工程内的 tsx，不依赖宿主进程的 cwd
 * （MCP 客户端的启动目录经常不是工程目录）。
 */
function buildMcpConfig() {
  const root = toPosix(projectRoot).replace(/\/+$/, '')
  const tsxCli = `${root}/node_modules/tsx/dist/cli.mjs`
  const proxy = `${root}/server/mcp-proxy.ts`
  const serverUrl = `http://127.0.0.1:${port}`
  const httpUrl = `${serverUrl}/mcp`
  const valid = projectValid()
  return {
    name: MCP_SERVER_NAME,
    serverUrl,
    httpUrl,
    /** stdio 要本地依赖装齐：tsx 和代理入口都得在 */
    stdioReady: valid && isFile(tsxCli) && isFile(proxy),
    /** HTTP 要服务在跑：自己启动的，或外部已经跑着的 */
    httpReady: serverProc !== null || lastHealthy,
    stdio: {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: 'node',
          args: [tsxCli, proxy],
          env: { SERVER_URL: serverUrl },
        },
      },
    },
    http: {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'http', url: httpUrl },
      },
    },
  }
}

/** 从 npm 装的是哪个包；工程仓库单独发布，不随插件走 */
const PROJECT_PACKAGE = process.env.REMOTION_PROJECT_PACKAGE ?? 'remotion-studio-mcp'
/** 下载源：官方 / 国内镜像 / 自定义 */
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
/**
 * 当前下载源：环境变量 → 面板里存过的 → npmmirror。
 * 启动时的静默更新检查也走它，所以必须跟面板共享同一份值（存 settings 里）。
 */
let registry = process.env.DSH_REGISTRY ?? DEFAULT_REGISTRY

/** 插件自身：包名 / 版本 / 仓库地址都从自己的 package.json 读，别写死 */
const PLUGIN_META = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
})()
const PLUGIN_NAME = typeof PLUGIN_META.name === 'string' && PLUGIN_META.name ? PLUGIN_META.name : 'dsh-remotion-launcher'
const PLUGIN_VERSION = typeof PLUGIN_META.version === 'string' ? PLUGIN_META.version : '0.0.0'

/** 仓库地址 → `github:owner/repo`，给「手动重装」的提示用 */
const PLUGIN_REPO_SPEC = (() => {
  const raw = PLUGIN_META.repository
  const url = typeof raw === 'string' ? raw : String((raw && raw.url) || '')
  const found = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(url)
  return found ? `github:${found[1]}/${found[2].replace(/\.git$/i, '')}` : null
})()

/** 拿不到 pluginManager 时的兜底判断：在 node_modules 里当 npm 装的，否则是源码目录 */
const PLUGIN_SOURCE_FALLBACK = PLUGIN_DIR.includes(`${path.sep}node_modules${path.sep}`) ? 'npm' : 'link'

/**
 * 插件是怎么装上的。以 DSH 自己的记录为准（`pluginManager.listBundles()` 的 `source`）：
 *
 *   npm       `dsh-remotion-launcher@^1.0.6`  → 跟 registry 走，能一键热更新
 *   git       `github:you/repo`、git URL      → 必须卸载后重装
 *   link      `link:/path`                    → 源码目录，改源码或卸载重装
 *   local     `file:/path`、本地 tgz          → 同上
 *   tarball   远程 tgz                        → 同上
 *
 * 只有 npm 装的那条路可以「点按钮更新」，其余一律提示手动卸载再装。
 */
let pluginInstall = {
  kind: PLUGIN_SOURCE_FALLBACK,
  spec: null,
  version: PLUGIN_VERSION,
  removable: false,
  managed: false,
}

/** DSH 的插件管理服务；宿主没装（headless 之类）就是 null */
let pluginManager = null
/** 宿主侧是否有 HMR：有才能真正热更新，没有只能「装完重启」 */
let hmrLive = false
/** apply() 存下来的 ctx，用来按需取服务 */
let hostCtx = null

/** 当前工程目录里 package.json 的版本 */
function readProjectVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 问 registry 要某个包的最新版本（`<registry>/<pkg>/latest`，比 `npm view` 轻） */
async function fetchLatestVersion(pkgName, registry) {
  try {
    const base = registry.replace(/\/+$/, '')
    const res = await fetch(`${base}/${encodeURIComponent(pkgName)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

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
    const data = { fabPos, panelPos, port, registry, projectRoot: projectRootOverride }
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
    // 下载源：面板换过就跟着走，启动时的静默更新检查也用它
    if (typeof raw?.registry === 'string' && /^https?:\/\//i.test(raw.registry.trim())) {
      registry = raw.registry.trim()
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
/** 原地更新工程（覆盖代码文件，保留 data/public/out/node_modules） */
let projectUpdate = { status: 'idle', from: null, to: null, startedAt: null, finishedAt: null, error: null }
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

/* ── 原地更新工程 ───────────────────────────────────────────────── */

/** 更新时绝不覆盖的目录：用户数据 + 依赖 + git */
const UPDATE_KEEP = new Set(['data', 'public', 'out', 'node_modules', 'dist', '.git', '.github'])

/**
 * 原地更新：下载新版 → 解压到临时目录 → 覆盖代码文件 → npm install。
 * 不做「整目录替换」，否则用户的 data/（工程、素材、历史）会被一起抹掉。
 */
async function updateProject({ registry }) {
  projectUpdate = {
    status: 'running', from: readProjectVersion(), to: null,
    startedAt: Date.now(), finishedAt: null, error: null,
  }
  const tmp = path.join(STATE_DIR, `update-${Date.now()}`)
  try {
    fs.mkdirSync(tmp, { recursive: true })
    pushLog('install', `▸ 更新工程：下载 ${PROJECT_PACKAGE}@latest（源：${registry}）`)

    const packCode = await runStep('npm pack', 'npm', [
      'pack', `${PROJECT_PACKAGE}@latest`, `--registry=${registry}`, '--pack-destination', tmp,
    ])
    if (packCode !== 0) throw new Error('下载失败（npm pack 非 0 退出）')

    const tgz = fs.readdirSync(tmp).find((file) => file.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack 没有产出 .tgz')

    const work = path.join(tmp, 'x')
    fs.mkdirSync(work, { recursive: true })
    const unpackCode = await runStep('解压', 'tar', [
      '-xzf', path.join(tmp, tgz), '-C', work, '--strip-components=1',
    ])
    if (unpackCode !== 0) throw new Error('解压失败')

    let count = 0
    for (const entry of fs.readdirSync(work, { withFileTypes: true })) {
      if (UPDATE_KEEP.has(entry.name)) continue
      fs.cpSync(path.join(work, entry.name), path.join(projectRoot, entry.name), {
        recursive: true, force: true,
      })
      count += 1
    }
    pushLog('install', `▸ 覆盖 ${count} 项代码文件（data / public / out / node_modules 不动）`)

    projectUpdate.to = readProjectVersion()
    pushLog('install', '▸ 更新依赖（几分钟）')
    const npmCode = await runStep('npm install', 'npm', [
      'install', `--registry=${registry}`, '--no-audit', '--no-fund',
    ], { cwd: projectRoot })
    if (npmCode !== 0) throw new Error('npm install 非 0 退出（依赖可能不完整）')

    projectUpdate = { ...projectUpdate, status: 'success', finishedAt: Date.now(), error: null }
    sys(`工程已更新：${projectUpdate.from ?? '?'} → ${projectUpdate.to ?? '?'}（重启服务后生效）`)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    projectUpdate = { ...projectUpdate, status: 'failed', finishedAt: Date.now(), error: message }
    sys(`更新工程失败：${message}`)
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

/* ── 更新检查（启动静默一次 + 面板手动刷） ─────────────────────── */

/**
 * 语义化版本比较：a 比 b 新返回 true。
 * 只处理 `1.2.3` / `1.2.3-beta.1`，不处理范围（`^`、`~`），因为这里比的是
 * 具体版本：本地 package.json 里读出来的 vs registry 上的 latest。
 */
function isNewerVersion(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const parse = (value) => {
    const [core, pre] = String(value).trim().replace(/^v/i, '').split('-')
    const nums = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre ?? '' }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] > right.nums[i]
  }
  if (left.pre === right.pre) return false
  if (left.pre === '') return true          // 正式版比预发布版新
  if (right.pre === '') return false
  return left.pre > right.pre
}

/** 最新版本检查结果：每次 DSH 启动静默查一次，面板里也能手动刷 */
let update = {
  checkedAt: null,
  registry: null,
  pluginLatest: null,
  projectLatest: null,
  error: null,
}

async function checkUpdates(reg = registry) {
  const base = /^https?:\/\//i.test(String(reg)) ? String(reg) : DEFAULT_REGISTRY
  const [pluginLatest, projectLatest] = await Promise.all([
    fetchLatestVersion(PLUGIN_NAME, base),
    fetchLatestVersion(PROJECT_PACKAGE, base),
  ])
  update = {
    checkedAt: Date.now(),
    registry: base,
    pluginLatest,
    projectLatest,
    error: pluginLatest ? null : '查不到最新版本（网络不通、镜像没同步，或包名不对）',
  }
  return update
}

/** a 是 b 之后的版本，且 b 存在 */
function hasNewer(latest, current) {
  return typeof latest === 'string' && isNewerVersion(latest, current)
}

/* ── 插件自身的安装方式 ─────────────────────────────────────────── */

/** 从 pnpm 记录的 spec 判断安装方式 */
function classifyInstallSource(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return 'unknown'
  if (/\.(?:tgz|tar\.gz)(?:#.*)?$/i.test(text)) return 'tarball'
  if (/^link:/i.test(text)) return 'link'
  if (/^file:/i.test(text)) return 'local'
  if (/^(?:github|gitlab|bitbucket|gist):/i.test(text)) return 'git'
  if (/^git(?:\+[a-z]+)?:\/\//i.test(text) || /^git@[^:]+:/i.test(text)) return 'git'
  if (/^https?:\/\//i.test(text)) return 'git'   // 仓库 URL（tgz 已经在上面拦掉了）
  return 'npm'                                    // `name@range` / `name@tag`
}

/**
 * 读一次「这个插件是怎么装的」。
 *
 * 走 DSH 的 pluginManager.listBundles()：它给的 `source` 就是 `pnpm add` 会用的
 * 那个 spec（`dsh-remotion-launcher@^1.0.6` / `github:you/repo` / `link:/dir`），
 * 比自己猜 node_modules 靠谱 —— GitHub 安装的包同样落在 node_modules 里，
 * 只看路径会全部误判成 npm。
 */
async function refreshPluginInstall() {
  const pm = pluginManager
  if (!pm || typeof pm.listBundles !== 'function') {
    pluginInstall = {
      kind: PLUGIN_SOURCE_FALLBACK, spec: null, version: PLUGIN_VERSION,
      removable: false, managed: false,
    }
    return pluginInstall
  }
  try {
    const bundles = await pm.listBundles()
    const row = Array.isArray(bundles) ? bundles.find((item) => item && item.name === PLUGIN_NAME) : null
    if (!row) {
      pluginInstall = {
        kind: PLUGIN_SOURCE_FALLBACK, spec: null, version: PLUGIN_VERSION,
        removable: false, managed: true,
      }
      return pluginInstall
    }
    pluginInstall = {
      managed: true,
      kind: classifyInstallSource(row.source),
      spec: typeof row.source === 'string' ? row.source : null,
      version: typeof row.version === 'string' ? row.version : PLUGIN_VERSION,
      removable: row.removable === true,
      enabled: row.enabled === true,
    }
  } catch (error) {
    sys(`读取插件安装方式失败：${error && error.message ? error.message : String(error)}`)
  }
  return pluginInstall
}

/** 宿主侧 HMR 是否存在：决定「装完就生效」还是「装完要重启」 */
function refreshHmr() {
  try {
    hmrLive = Boolean(hostCtx && typeof hostCtx.get === 'function' && hostCtx.get('hmr'))
  } catch {
    hmrLive = false
  }
  return hmrLive
}

/** 能不能走面板上的「一键更新」：npm 装的 + 宿主给我卸载权限 */
function canAutoUpdate() {
  return Boolean(pluginManager) && pluginInstall.kind === 'npm' && pluginInstall.removable
}

/** 手动重装时该填什么 spec：优先用用户当初装的那条，其次推回仓库地址 */
function reinstallSpec() {
  if (pluginInstall.kind === 'git' && PLUGIN_REPO_SPEC) return PLUGIN_REPO_SPEC
  if (pluginInstall.kind === 'link' && pluginInstall.spec) return pluginInstall.spec
  if (pluginInstall.kind === 'local' && pluginInstall.spec) return pluginInstall.spec
  if (pluginInstall.kind === 'tarball' && pluginInstall.spec) return pluginInstall.spec
  return PLUGIN_NAME
}

/* ── 插件热更新 ────────────────────────────────────────────────── */

/**
 * 更新进度存在磁盘上，而不是只放在内存里。
 *
 * 原因：HMR 生效时，第一步 removeBundle 就会把这个插件自己卸掉 ——
 * 面板、路由、模块全没了，只有这段 async 函数还活在 Node 里。等 installBundle
 * 把新版装回来，apply() 会在同一个进程里再跑一遍，读这个文件才知道
 * 「刚才那次更新到底成没成」。DSH 中途退出也一样，下次启动能看到结果。
 */
const UPDATE_MARKER_FILE = path.join(STATE_DIR, 'remotion-launcher-update.json')

/** @type {{status:'idle'|'removing'|'installing'|'done'|'failed'|'rolled-back'|'interrupted',
 *          from:string|null,to:string|null,hot:boolean,restartRequired:boolean,
 *          error:string|null,at:number|null,rollback:string|null}} */
let pluginUpdate = {
  status: 'idle', from: null, to: null, hot: false,
  restartRequired: false, error: null, at: null, rollback: null,
}

function savePluginUpdate() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(UPDATE_MARKER_FILE, `${JSON.stringify(pluginUpdate, null, 2)}\n`, 'utf8')
  } catch (error) {
    sys(`记录更新进度失败：${error && error.message ? error.message : String(error)}`)
  }
}

function loadPluginUpdate() {
  try {
    const stat = fs.statSync(UPDATE_MARKER_FILE)
    const raw = JSON.parse(fs.readFileSync(UPDATE_MARKER_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object') return
    const at = Number(raw.at) || stat.mtimeMs
    if (raw.status === 'removing' || raw.status === 'installing') {
      /**
       * 刚写下没多久就当「还在跑」。
       *
       * 热更新时 HMR 会先用新版实例把本插件拉起来，此刻旧实例的 async 函数
       * 还在做 installBundle —— 新版这个 apply() 读到的必然是「installing」。
       * 按时间判：5 分钟内算进行中，超过就当那次更新确实没走完。
       */
      pluginUpdate = Date.now() - at < 5 * 60_000
        ? { ...pluginUpdate, ...raw, at }
        : {
            ...pluginUpdate, ...raw, status: 'interrupted', at,
            error: raw.error ?? '上次更新没有走完（DSH 中途退出？请确认插件还在）',
          }
      return
    }
    if (['done', 'failed', 'rolled-back'].includes(raw.status)) {
      pluginUpdate = { ...pluginUpdate, ...raw, at }
    }
  } catch { /* 没有这个文件是常态 */ }
}

function clearPluginUpdate() {
  pluginUpdate = {
    status: 'idle', from: null, to: null, hot: false,
    restartRequired: false, error: null, at: null, rollback: null,
  }
  try { fs.rmSync(UPDATE_MARKER_FILE, { force: true }) } catch { /* ignore */ }
}

/**
 * 热更新期间，真正把新版装完的是「旧实例」——它被 HMR 停掉了，但那条
 * async 流程还活着，装完会往标记文件里写 done。新实例内存里永远停在
 * installing，所以每次出快照都顺手从磁盘捞一次结果，别让面板一直转圈。
 */
function syncPluginUpdateFromDisk() {
  if (pluginUpdate.status !== 'removing' && pluginUpdate.status !== 'installing') return
  try {
    const raw = JSON.parse(fs.readFileSync(UPDATE_MARKER_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object') return
    if (['done', 'failed', 'rolled-back'].includes(raw.status)) {
      pluginUpdate = { ...pluginUpdate, ...raw }
    }
  } catch { /* 文件还没写出来 / 被删了，保持当前状态 */ }
}

/** 正在跑的更新不允许并发触发 */
function updatingPlugin() {
  return pluginUpdate.status === 'removing' || pluginUpdate.status === 'installing'
}

/** 把 DSH 插件管理的错误码翻成人话，别把 already-installed 直接甩给用户 */
const PM_ERROR_TEXT = {
  'already-installed': 'DSH 里还装着旧版：先到「设置 → 插件」卸载，再重启让它装新版',
  'not-removable': '这个插件不允许从面板卸载（可能是随 DSH 安装包自带的）',
  'bundle-in-use': '插件正在被使用，稍等一下再试',
  'not-bundle': '这个包不是 DSH 插件，检查包名',
  'invalid-spec': '版本号 DSH 不认，检查包名/版本',
  'ambiguous-install': '装出来的包不唯一，检查依赖',
  'incompatible-version': '新版与当前 DSH 版本不兼容',
  'stop-profile': 'DSH 正在停止，稍后再试',
  'operation-error': 'DSH 执行安装时出错，看下方日志',
}

function pmErrorText(code, action) {
  const hint = code ? PM_ERROR_TEXT[code] : null
  return hint ? `${action}失败：${hint}` : `${action}失败${code ? `（${code}）` : '（未知原因）'}`
}

/**
 * 热更新：remove → install，两步都由 DSH 的 pluginManager 做，全程不重启。
 *
 * 为什么必须先 remove：宿主开着 HMR 时，installBundle 对已安装的包会直接
 * 拒绝（already-installed），因为「覆盖一个正在跑的包」会把旧实例留在内存里。
 * 所以顺序得是：卸掉（HMR 会立刻停掉本插件）→ 装新版（HMR 再把新版拉起来）。
 *
 * 失败会尽量自己救回来：卸掉后装不上，就把原来的版本装回去，别让用户
 * 面对一个「插件消失」的界面。
 */
async function runPluginUpdate() {
  const pm = pluginManager
  if (!pm) {
    pluginUpdate = { ...pluginUpdate, status: 'failed', error: '当前 DSH 没有暴露插件管理接口', at: Date.now() }
    savePluginUpdate()
    return
  }

  const from = PLUGIN_VERSION
  if (!update.pluginLatest) await checkUpdates().catch(() => {})
  const to = update.pluginLatest
  if (!hasNewer(to, from)) {
    pluginUpdate = { ...pluginUpdate, status: 'failed', error: '已经是最新版本', from, to: to ?? null, at: Date.now() }
    savePluginUpdate()
    return
  }
  if (pluginInstall.kind !== 'npm') {
    pluginUpdate = {
      ...pluginUpdate, status: 'failed', from, to, at: Date.now(),
      error: '不是 npm 安装的（' + pluginInstall.kind + '），需要手动卸载后重装',
    }
    savePluginUpdate()
    return
  }

  const hot = refreshHmr()
  pluginUpdate = {
    status: hot ? 'removing' : 'installing', from, to, hot,
    restartRequired: !hot, error: null, at: Date.now(), rollback: null,
  }
  savePluginUpdate()
  sys(`▸ 更新启动器 ${from} → ${to}（${hot ? '热更新：先卸载再装回，不重启 DSH' : '当前 DSH 未开 HMR，装完需重启'}）`)

  let removed = false
  try {
    if (hot) {
      const result = await pm.removeBundle(PLUGIN_NAME)
      const gone = result && result.application
      if (!result || gone === 'failed' || gone === 'cancelled') {
        const code = result && result.error && result.error.code
        throw new Error(gone === 'cancelled' ? '卸载旧版被取消，插件没有动' : pmErrorText(code, '卸载旧版'))
      }
      removed = true
      pluginUpdate = { ...pluginUpdate, status: 'installing', at: Date.now() }
      savePluginUpdate()
    }

    const result = await pm.installBundle(`${PLUGIN_NAME}@${to}`, {})
    const applied = result && result.application
    if (!result || applied === 'failed' || applied === 'cancelled') {
      const code = result && result.error && result.error.code
      throw new Error(applied === 'cancelled' ? '安装被取消，插件文件已还原' : pmErrorText(code, '安装'))
    }
    // ChangeResult 不带版本号，装完回读一次，面板上显示的就是真实落盘版本
    const installed = typeof pm.listBundles === 'function'
      ? (await pm.listBundles()).find((item) => item && item.name === PLUGIN_NAME)
      : null
    pluginUpdate = {
      ...pluginUpdate,
      status: 'done',
      to: (installed && typeof installed.version === 'string' && installed.version) || to,
      restartRequired: applied === 'restart-required',
      error: null,
      at: Date.now(),
    }
    savePluginUpdate()
    sys(result.application === 'restart-required'
      ? `启动器已更新到 ${pluginUpdate.to}，重启 DSH 后生效`
      : `启动器已更新到 ${pluginUpdate.to}（热更新完成，没有重启 DSH）`)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    sys(`更新启动器失败：${message}`)
    let rollback = null
    // 已经卸掉了才需要救：把原版本装回去，用户至少还有一个能用的面板
    if (removed) {
      sys(`▸ 尝试回滚到 ${from}`)
      try {
        const back = await pm.installBundle(`${PLUGIN_NAME}@${from}`, {})
        const backOk = back && back.application !== 'failed' && back.application !== 'cancelled'
        rollback = backOk
          ? `已回滚到 ${from}`
          : pmErrorText(back && back.error && back.error.code, '回滚')
      } catch (backError) {
        rollback = `回滚失败：${backError && backError.message ? backError.message : String(backError)}`
      }
      sys(rollback)
    }
    pluginUpdate = {
      ...pluginUpdate,
      status: removed ? (rollback && rollback.startsWith('已回滚') ? 'rolled-back' : 'failed') : 'failed',
      error: message,
      rollback,
      at: Date.now(),
    }
    savePluginUpdate()
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
  syncPluginUpdateFromDisk()
  const since = Number(sinceSeq ?? 0) || 0
  const fresh = logs.filter((entry) => entry.seq > since)
  return {
    projectRoot,
    projectValid: projectValid(),
    projectPackage: PROJECT_PACKAGE,
    projectVersion: readProjectVersion(),
    defaultRegistry: DEFAULT_REGISTRY,
    registry,
    install: { ...install },
    projectUpdate: { ...projectUpdate },
    pluginVersion: PLUGIN_VERSION,
    pluginSource: pluginInstall.kind,
    /** 插件自身的安装情况 + 能不能一键更新 + 走不走热更新 */
    plugin: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      kind: pluginInstall.kind,
      spec: pluginInstall.spec,
      removable: pluginInstall.removable,
      managed: pluginInstall.managed,
      canAutoUpdate: canAutoUpdate(),
      hot: hmrLive,
      manualSpec: reinstallSpec(),
    },
    /** 启动时静默查到的版本（面板顶部横幅用） */
    update: {
      checkedAt: update.checkedAt,
      registry: update.registry,
      latest: update.pluginLatest,
      projectLatest: update.projectLatest,
      hasUpdate: hasNewer(update.pluginLatest, PLUGIN_VERSION),
      projectHasUpdate: hasNewer(update.projectLatest, readProjectVersion()),
      error: update.error,
    },
    pluginUpdate: { ...pluginUpdate },
    /** 连接器里直接粘贴的配置（stdio / http 两种） */
    mcp: buildMcpConfig(),
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
        // 更新进行中时状态存在磁盘上（host 可能刚被 HMR 换过实例），每次读一下
        if (updatingPlugin()) loadPluginUpdate()
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
      const reg = String((body && body.registry) ?? registry).trim()
      if (install.status === 'running') return reply(409, { ok: false, error: '正在下载/安装中，请稍候' })
      if (serverProc) return reply(409, { ok: false, error: '服务运行中，先停止再安装工程' })
      if (!dir) return reply(400, { ok: false, error: '请选择下载目录' })
      if (!path.isAbsolute(dir)) return reply(400, { ok: false, error: '目录要填绝对路径' })
      if (!/^https?:\/\//i.test(reg)) return reply(400, { ok: false, error: '下载源要是 http(s) 地址' })
      // 异步跑，客户端靠轮询 state 看进度
      void installProject({ dir, registry: reg })
      return reply(200, { ok: true, ...snapshot(0) })
    }
    if (action === '/updates' && method === 'GET') {
      const wanted = (url.searchParams.get('registry') || registry).trim()
      if (!/^https?:\/\//i.test(wanted)) {
        return reply(400, { ok: false, error: '下载源要是 http(s) 地址' })
      }
      const latest = await checkUpdates(wanted)
      return reply(200, {
        ok: true,
        registry: wanted,
        checkedAt: latest.checkedAt,
        plugin: {
          name: PLUGIN_NAME,
          current: PLUGIN_VERSION,
          latest: latest.pluginLatest,
          kind: pluginInstall.kind,
          canAutoUpdate: canAutoUpdate(),
          hot: hmrLive,
        },
        project: { name: PROJECT_PACKAGE, current: readProjectVersion(), latest: latest.projectLatest },
        error: latest.error,
      })
    }
    if (action === '/plugin-update' && method === 'POST') {
      if (updatingPlugin()) return reply(409, { ok: false, error: '正在更新启动器，稍等它装完' })
      if (!pluginManager) {
        return reply(409, { ok: false, error: '当前 DSH 没有暴露插件管理接口，请到「设置 → 插件」里更新' })
      }
      await refreshPluginInstall()
      if (pluginInstall.kind !== 'npm') {
        return reply(409, {
          ok: false,
          error: `当前是 ${pluginInstall.kind} 安装，只能手动卸载后重装`,
        })
      }
      if (!pluginInstall.removable) {
        return reply(409, { ok: false, error: 'DSH 不允许直接卸载这个插件（可能随安装包自带），请到「设置 → 插件」处理' })
      }
      if (!update.pluginLatest) await checkUpdates().catch(() => {})
      if (!hasNewer(update.pluginLatest, PLUGIN_VERSION)) {
        return reply(409, { ok: false, error: '已经是最新版本' })
      }
      // 先把响应发回去再动插件：热更新第一步就会把这个面板自己卸掉
      setTimeout(() => { void runPluginUpdate() }, 80)
      return reply(202, { ok: true, ...snapshot(0) })
    }
    if (action === '/plugin-update/ack' && method === 'POST') {
      // 面板把「更新完成 / 失败」看过了，清掉标记，下次不再弹
      clearPluginUpdate()
      return reply(200, { ok: true, pluginUpdate: { ...pluginUpdate } })
    }
    if (action === '/update-project' && method === 'POST') {
      const body = await readJsonBody(req)
      const reg = String((body && body.registry) ?? registry).trim()
      if (!/^https?:\/\//i.test(reg)) return reply(400, { ok: false, error: '下载源要是 http(s) 地址' })
      if (projectUpdate.status === 'running' || install.status === 'running') {
        return reply(409, { ok: false, error: '正在安装/更新工程，请稍候' })
      }
      if (serverProc) return reply(409, { ok: false, error: '服务运行中，先停止再更新工程' })
      if (!projectValid()) return reply(409, { ok: false, error: '还没有工程，先用「安装」' })
      void updateProject({ registry: reg })
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
    if (action === '/registry') {
      if (method === 'GET') return reply(200, { ok: true, registry })
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const next = String((body && body.registry) ?? '').trim()
        if (!/^https?:\/\//i.test(next)) return reply(400, { ok: false, error: '下载源要是 http(s) 地址' })
        registry = next
        persist()
        // 换源之后顺手用新源重查一次，免得面板里还挂着旧源的结果
        await checkUpdates(next).catch(() => {})
        return reply(200, { ok: true, registry, ...snapshot(0) })
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
  hostCtx = ctx
  loadPersisted()
  loadPluginUpdate()
  sys(`按钮位置文件：${SETTINGS_FILE}${fabPos ? `（已恢复 ${fabPos.x},${fabPos.y}）` : '（尚未拖动过）'}`)
  sys(`运行端口：${port}${PORT_FROM_ENV ? '（来自环境变量 REMOTION_PORT）' : '（可在面板中修改）'}`)
  sys(`下载源：${registry}`)

  if (projectValid()) {
    sys(`插件已加载，工程目录：${projectRoot}`)
  } else {
    sys(`插件已加载，但还没找到工程：${projectRoot}`)
    sys(`  可以在面板里「下载项目」：选目录 + 下载源，会自动 npm pack → 解压 → npm install（包名 ${PROJECT_PACKAGE}）。`)
    sys('  也可以手动把工程放到某个目录，然后设 REMOTION_STUDIO_ROOT 指过去。')
  }

  // 上一次更新走到一半（HMR 换实例时也会走到这里）：把结果说清楚
  if (pluginUpdate.status === 'done') {
    sys(`上次更新已完成：${pluginUpdate.from} → ${pluginUpdate.to}${pluginUpdate.restartRequired ? '（需重启 DSH 生效）' : '（热更新）'}`)
  } else if (pluginUpdate.status === 'interrupted') {
    sys(`上次更新没有走完：${pluginUpdate.error ?? ''}`)
  } else if (pluginUpdate.status === 'rolled-back' || pluginUpdate.status === 'failed') {
    sys(`上次更新失败：${pluginUpdate.error ?? ''}${pluginUpdate.rollback ? `（${pluginUpdate.rollback}）` : ''}`)
  }

  /**
   * 按需拿插件管理服务。
   *
   * 不能写进 `inject`：headless / SDK 部署里可能根本没有插件管理，写进 inject
   * 会让整个面板等到天荒地老都不出现。`ctx.inject` 是「有服务就回调」。
   */
  try {
    const register = () => {
      ctx.inject(['pluginManager'], (svcCtx) => {
        try {
          pluginManager = svcCtx.pluginManager ?? null
        } catch {
          pluginManager = null
        }
        refreshHmr()
        void refreshPluginInstall()
        return () => { pluginManager = null; void refreshPluginInstall() }
      })
    }
    if (typeof ctx.inject === 'function') register()
  } catch {
    /* 环境不支持动态注入：保持 null，面板里会提示手动更新 */
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

  /**
   * 启动后静默查一次版本。
   *
   * 延迟 3 秒再发：别和 DSH 自己的启动流程抢网络；查到了也不弹任何东西，
   * 只是把结果放进 state —— 悬浮按钮上出一个小圆点，面板顶部出一行横幅。
   * 查不到（离线 / 镜像是旧的）就安静地留着 error，不打扰用户。
   */
  const silentTimer = setTimeout(() => {
    void (async () => {
      try {
        refreshHmr()
        await refreshPluginInstall()
        const result = await checkUpdates()
        if (hasNewer(result.pluginLatest, PLUGIN_VERSION)) {
          sys(`发现启动器新版本 ${result.pluginLatest}（当前 ${PLUGIN_VERSION}，${pluginInstall.kind} 安装）`)
        }
      } catch {
        /* 静默检查失败不问用户 */
      }
    })()
  }, 3000)
  if (typeof silentTimer.unref === 'function') silentTimer.unref()
  ctx.effect(() => () => clearTimeout(silentTimer), 'dsh-remotion-launcher: update-check')

  // 插件卸载 / DSH 退出时收尸，避免端口被孤儿进程占着
  ctx.effect(() => {
    return () => {
      if (buildProc) killTree(buildProc)
      if (serverProc) killTree(serverProc)
    }
  }, 'dsh-remotion-launcher: cleanup')
}
