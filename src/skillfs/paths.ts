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
