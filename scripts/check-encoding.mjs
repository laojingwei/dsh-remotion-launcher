/**
 * 一次性验证：PowerShell 的 stdout 在设置 OutputEncoding 后，能否把中文路径
 * 原样交给 Node（不再变成 Remotion??????????）。
 * 不用真弹窗，只测编码链路。
 */
import { spawn } from 'node:child_process'

const target = 'D:\\dsh\\Remotion动画工程项目'

function run(setEncoding) {
  const lines = []
  if (setEncoding) {
    lines.push('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8')
    lines.push('$OutputEncoding = [System.Text.Encoding]::UTF8')
  }
  lines.push(`Write-Output '${target}'`)
  const script = lines.join('; ')

  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('exit', () => resolve(out.replace(/^\uFEFF/, '').trim()))
  })
}

const withFix = await run(true)
const without = await run(false)

console.log('期望值     :', target)
console.log('未设编码   :', without, without === target ? '✓' : '✗ 乱码')
console.log('设了 UTF8  :', withFix, withFix === target ? '✓' : '✗ 乱码')
process.exitCode = withFix === target ? 0 : 1
