import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dshHome } from '../store.ts'
import type { WritableRoot } from '../protocol.ts'

/** Root ids this module may write to. */
export const WRITABLE_ROOTS: readonly WritableRoot[] = ['user-dsh', 'user-agents']

/** Resolve the absolute directory of one writable root. */
export function rootPath(root: WritableRoot, home = dshHome()): string {
  const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  switch (root) {
    case 'user-dsh': return join(home, 'skills')
    case 'user-agents': return join(agentsHome, 'skills')
    default: throw new TypeError('unknown root: ' + String(root))
  }
}

/**
 * 项目级技能的可写目标根：`<projectRoot>/.dsh/skills`。
 *
 * 与 `rootPath` 分开，是因为项目根不是 `WritableRoot` —— 它由工作区推出来，
 * 数量不固定，也不能由前端指定。收编是唯一往这里写的动作；hub 的开关/删除
 * 仍然只对用户级可写根生效（项目技能是宿主认的只读来源）。
 */
export function projectSkillsRoot(projectRoot: string): string {
  return join(resolve(projectRoot), '.dsh', 'skills')
}

/** Root of an absolute skill file path, or undefined when not user-owned. */
export function rootOfPath(path: string, home = dshHome()): WritableRoot | undefined {
  const normalized = resolve(path)
  for (const root of WRITABLE_ROOTS) {
    const base = resolve(rootPath(root, home))
    if (process.platform === 'win32') {
      const n = normalized.toLowerCase()
      const b = base.toLowerCase()
      if (n === b) return root
      if (n.startsWith(b + '/') || n.startsWith(b + '\\') || n.startsWith(b + sep)) return root
      // 兜底：relative 判断（处理盘符、大小写、.. 段，兼容 / 与 \）
      const rel = relative(base, normalized)
      if (rel !== '' && !rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\') && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)) return root
    } else {
      if (normalized === base) return root
      if (normalized.startsWith(base + sep) || normalized.startsWith(base + '/') || normalized.startsWith(base + '\\')) return root
      const rel = relative(base, normalized)
      if (rel !== '' && !rel.startsWith('..' + sep) && !rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\') && rel !== '..' && !isAbsolute(rel)) return root
    }
  }
  return undefined
}

/**
 * 技能包内相对路径的规范化与安全判定：ZIP 导入与 skills.sh 直装共用。
 *
 * 反斜杠先统一成正斜杠 —— Windows 打包工具会写出 `a\b`，在 POSIX 上它会被
 * 当成文件名里的一个字符，于是 `..\..\x` 绕过所有按 `/` 做的检查。
 *
 * 判据是黑名单而不是字符白名单：技能包里的文件名可以是中文、空格、emoji，
 * 把「不是 ASCII」当成不安全会让中文技能整包装不进来（skills.sh 直装踩过）。
 * 真正要挡的只有四类 —— 绝对路径、盘符、`..` 段、NUL。
 * @param raw - 包内声明的路径。
 * @returns 规范化后的相对路径，或拒绝原因（用于拼错误消息）。
 */
export function normalizeBundlePath(raw: string): { path: string } | { error: string } {
  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/')) return { error: 'an absolute path: ' + raw }
  if (/^[A-Za-z]:/.test(unified)) return { error: 'a drive-letter path: ' + raw }
  const parts: string[] = []
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return { error: 'a path traversal segment: ' + raw }
    // NUL 会截断下游的 fs 调用，`%2e%2e` 之类不需要单独处理 —— 这里不解码。
    if (part.includes('\0')) return { error: 'a NUL in a path: ' + raw }
    parts.push(part)
  }
  if (parts.length === 0) return { error: 'an empty path entry' }
  return { path: parts.join('/') }
}
