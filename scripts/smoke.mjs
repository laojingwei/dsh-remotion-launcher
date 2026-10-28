/**
 * 离线冒烟：不启动 DSH，直接校验插件的两个半区能否被加载。
 * 覆盖过去最容易翻车、且装上去才会暴露的错误：语法、导出契约、非白名单 require。
 *
 * 用法：node scripts/smoke.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'

const root = new URL('..', import.meta.url)
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

/* ── host 半区 ── */
console.log('host 半区：')
const host = await import(new URL('index.js', root).href)
check('默认导出契约（name / inject / apply）', () => {
  if (typeof host.apply !== 'function') throw new Error('apply 不是函数')
  if (!Array.isArray(host.inject)) throw new Error('inject 不是数组')
  if (!host.inject.includes('webServer')) throw new Error('inject 缺 webServer')
  if (!host.name) throw new Error('缺 name')
})
check('路由前缀不与 DSH 连接桥冲突', () => {
  const src = fs.readFileSync(new URL('index.js', root), 'utf8')
  if (src.includes("path: '/api")) throw new Error("路由用了 /api 前缀，DSH 连接桥会占用")
})

/* ── client 半区 ── */
console.log('client 半区：')
const clientSource = fs.readFileSync(new URL('client.js', root), 'utf8')
let captured = null

const ReactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

const sandbox = {
  window: { __ModuleLoader__: { load(bundle) { captured = bundle } } },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('offline')),
}

check('bundle 以 __ModuleLoader__.load 注册', () => {
  vm.runInNewContext(clientSource, vm.createContext(sandbox), { filename: 'client.js' })
  if (!captured) throw new Error('没有调用 __ModuleLoader__.load')
  if (captured.id !== 'dsh-remotion-launcher') throw new Error(`id 不符：${captured.id}`)
  if (typeof captured.factory !== 'function') throw new Error('factory 不是函数')
})

check('factory 只 require 白名单模块并导出 apply/inject', () => {
  const exports = captured.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`require 了非白名单模块：${name}`)
  })
  if (typeof exports.apply !== 'function') throw new Error('缺 apply')
  if (!Array.isArray(exports.inject) || !exports.inject.includes('slots')) throw new Error('缺 inject: slots')
})

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
