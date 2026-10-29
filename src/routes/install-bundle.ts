/**
 * 技能落盘的唯一入口：把一组「相对路径 + 字节」装成一个技能目录。
 *
 * ZIP 导入、skills.sh 直装、外部 agent 收编都要做同样五件事，而且顺序
 * 不能变：找 SKILL.md → 解析 frontmatter 定名 → 整包审计 → 冲突判定 →
 * 临时目录写入后原子 rename。任何一处顺序错开，就会出现「审计过了但落盘
 * 的是另一份内容」或者「同名占位把目标目录占着导致 ENOTEMPTY」。
 *
 * 抽成一个函数而不是复制三遍：这三条路径原本各写一份，改动时最容易只
 * 改一处 —— 审计规则、上限、冲突语义（启用态跳过 vs 禁用占位让位）必须
 * 对所有入口一致，否则「同一个技能走不同入口得到不同结论」。
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { auditSkillBundle, blockingReason, type AuditFinding } from '../skillfs/audit.ts'
import { occupancyOf, parseFrontmatter } from '../skillfs.ts'
import { errorText } from '../error-text.ts'

/** 一个待落盘的文件。`path` 是技能目录内的相对路径（已规范化）。 */
export interface BundleFile {
  path: string
  size: number
  data: Buffer
}

export interface InstallOutcome {
  status: 'installed' | 'skipped' | 'failed'
  /** 技能名；frontmatter 还没解析出来时退回调用方给的 label。 */
  name: string
  /** 安装前被移入回收站的同名占位（可恢复）。 */
  replaced?: boolean
  /** 落盘成功但带警告的审计发现。 */
  warnings?: AuditFinding[]
  /** `skipped` / `failed` 的原因（人读）。 */
  error?: string
}

export interface InstallSkillBundleOptions {
  /** 目标根（通常是 `~/.dsh/skills`），必须已存在或可创建。 */
  targetRoot: string
  files: readonly BundleFile[]
  /** 解析不出名字时用于报错的标签（包内目录名、上游标识等）。 */
  label: string
  /** 已知的启用态技能名（由调用方一次取好，避免逐条扫盘）。 */
  existing: ReadonlySet<string>
  /** 把同名禁用占位/空壳移入回收站；返回是否真的移了。 */
  retire: (name: string) => Promise<boolean>
}

/**
 * 能当文本读的才送进规则扫描：二进制文件只做体积检查。
 *
 * 含 NUL 或解出替换字符即视为二进制 —— 所有入口共用同一判据，避免同一个
 * 技能走不同导入路径得到不同的审计结论。
 */
export function asAuditText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined
  const text = buffer.toString('utf8')
  return text.includes('\uFFFD') ? undefined : text
}

/**
 * 安装一个技能包。
 * @param options - 目标根、文件、已存在的名字集合、让位回调。
 * @returns 结果与原因；不抛异常（写盘错误也折成 `failed`，让同批其他技能继续）。
 */
export async function installSkillBundle(options: InstallSkillBundleOptions): Promise<InstallOutcome> {
  const { targetRoot, files, label, existing, retire } = options

  // 大小写不敏感地找发现文件：上游包可能写 `skill.md`，落盘时必须用规范名。
  const manifest = files.find((file) => file.path.toLowerCase() === 'skill.md')
  if (manifest === undefined) return { status: 'failed', name: label, error: 'no SKILL.md at the skill root' }

  const parsed = parseFrontmatter(manifest.data.toString('utf8'))
  if ('error' in parsed) return { status: 'failed', name: label, error: 'SKILL.md rejected: ' + parsed.error }
  const name = parsed.value.name

  const findings = auditSkillBundle(
    files.map((file) => {
      const text = asAuditText(file.data)
      return { path: file.path, size: file.size, ...(text !== undefined ? { text } : {}) }
    }),
    parsed.value.description,
  )
  const blocked = blockingReason(findings)
  if (blocked !== undefined) return { status: 'failed', name, error: blocked }

  // 「已存在」的判据是启用态发现文件，不是目录存在 —— 只有禁用占位的目录
  // 照样可以导入，那个占位会先被移入回收站（可恢复）。
  if (existing.has(name)) return { status: 'skipped', name, error: 'a skill with this name already exists' }
  const occupancy = await occupancyOf(targetRoot, name)
  if (occupancy.enabled.length > 0) return { status: 'skipped', name, error: 'a skill with this name already exists' }
  let replaced = false
  if (occupancy.disabled.length > 0 || occupancy.bareDir !== undefined) replaced = await retire(name)

  await mkdir(targetRoot, { recursive: true })
  // 点号前缀：残留的临时目录永远不会被 provider 的发现扫描当成一个技能。
  const tempDir = await mkdtemp(join(targetRoot, '.' + name + '.install-'))
  try {
    for (const file of files) {
      const target = join(tempDir, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.data)
    }
    await rename(tempDir, join(targetRoot, name))
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    return { status: 'failed', name, error: errorText(error) }
  }

  const warnings = findings.filter((finding) => finding.severity === 'warn')
  return { status: 'installed', name, ...(replaced ? { replaced: true } : {}), ...(warnings.length > 0 ? { warnings } : {}) }
}
