/**
 * 外部 agent 技能的只读发现与收编。
 *
 * SKILL.md 已经是跨 agent 的事实标准（Claude Code / Codex / Cursor / Gemini CLI
 * 等 45+ 产品读同一份文件），但**发现路径各家不同**。于是「我在 Claude Code 里
 * 调好的技能」在 dsh 里看不见，用户只能手工复制目录。
 *
 * 这里只做两件事：读（列出别处有什么）和复制（把选中的收编到本地可写根）。
 * 外部目录一律**只读**，绝不改写 —— 那是别的 agent 的资产。
 */

import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { parseFrontmatter } from './frontmatter.ts'
import { scanRoot } from './scan.ts'
import { auditSkillBundle, blockingReason, MAX_SKILL_FILES, type AuditBundleFile } from './audit.ts'

/** 一个外部 agent 的技能根。`agent` 是展示用的稳定标识。 */
export interface ForeignRoot {
  agent: string
  /** 绝对路径；不存在时扫描直接返回空。 */
  dir: string
}

/** 一条可收编的外部技能。 */
export interface ForeignSkill {
  /** 技能名（目录名或扁平文件名，与 frontmatter 一致时才算有效）。 */
  name: string
  description: string
  /** 来源 agent 标识。 */
  agent: string
  /** 发现文件绝对路径。 */
  path: string
  /** 资源基目录（目录包本身，或扁平文件的父目录）。 */
  directory: string
  kind: 'directory' | 'flat'
  /** 目标根已有同名技能（不可导入）。 */
  existing: boolean
}

/**
 * 常见 agent 的用户级技能目录。`~/.agents/skills` 不在此列 —— 那是 hub 自己的
 * 可写根（user-agents），重复列会让同一个技能出现两次。
 * 路径取自 vercel-labs/skills 的 agent 注册表，只保留桌面端常见的几个。
 */
export function foreignRoots(userHome: string): ForeignRoot[] {
  return [
    { agent: 'claude-code', dir: join(userHome, '.claude', 'skills') },
    { agent: 'codex', dir: join(userHome, '.codex', 'skills') },
    { agent: 'cursor', dir: join(userHome, '.cursor', 'skills') },
    { agent: 'gemini-cli', dir: join(userHome, '.gemini', 'skills') },
    { agent: 'copilot', dir: join(userHome, '.copilot', 'skills') },
    { agent: 'opencode', dir: join(userHome, '.config', 'opencode', 'skills') },
    { agent: 'goose', dir: join(userHome, '.config', 'goose', 'skills') },
  ]
}

/**
 * 扫描所有外部根。解析不出 frontmatter 的条目直接跳过 —— 它们在任何 agent 里
 * 都不会生效，列出来只会让人以为「导入就好了」。
 */
export async function scanForeignSkills(userHome: string, existing: ReadonlySet<string> = new Set()): Promise<ForeignSkill[]> {
  const found: ForeignSkill[] = []
  for (const root of foreignRoots(userHome)) {
    for (const entry of await scanRoot(root.dir)) {
      let text: string
      try {
        text = await readFile(entry.path, 'utf8')
      } catch {
        continue
      }
      const parsed = parseFrontmatter(text)
      if ('error' in parsed) continue
      const name = entry.kind === 'directory' ? basename(entry.directory) : basename(entry.path, '.md')
      found.push({
        name,
        description: parsed.value.description,
        agent: root.agent,
        path: entry.path,
        directory: entry.directory,
        kind: entry.kind,
        existing: existing.has(name),
      })
    }
  }
  return found.sort((a, b) => (a.name === b.name ? a.agent.localeCompare(b.agent) : a.name.localeCompare(b.name)))
}

interface CollectedFile {
  /** 相对技能目录的路径。 */
  path: string
  absolute: string
  size: number
}

/**
 * 递归列文件。符号链接不跟随（lstat）：一个指向 `~/.ssh` 的链接不该因为
 * 「用户点了导入」就被复制进技能目录。
 */
async function walk(dir: string, base: string, depth: number, out: CollectedFile[]): Promise<void> {
  if (depth > 8 || out.length >= MAX_SKILL_FILES) return
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  names.sort()
  for (const name of names) {
    if (out.length >= MAX_SKILL_FILES) return
    if (name === '.git') continue
    const absolute = join(dir, name)
    let info
    try {
      info = await lstat(absolute)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) await walk(absolute, base, depth + 1, out)
    else if (info.isFile()) out.push({ path: relative(base, absolute), absolute, size: info.size })
  }
}

async function collectForCopy(skill: ForeignSkill): Promise<CollectedFile[]> {
  if (skill.kind === 'flat') {
    const info = await lstat(skill.path)
    return [{ path: basename(skill.path), absolute: skill.path, size: info.size }]
  }
  const out: CollectedFile[] = []
  await walk(skill.directory, skill.directory, 0, out)
  return out
}

/** 文本文件的判定与市场导入一致：无 NUL、解码无替换字符。 */
function asText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined
  const text = buffer.toString('utf8')
  return text.includes('\uFFFD') ? undefined : text
}

/**
 * 把一个外部技能收编到 `targetRoot`（通常是 `~/.dsh/skills`）。
 *
 * 与市场导入同一套闸：体积/数量上限 + 内容审计，命中阻断级直接拒绝；
 * 落盘仍是「临时目录 → 校验 → 原子 rename」，失败不留半成品。
 * 扁平技能统一落成目录包 —— hub 的所有写入路径都建目录包，两种形态并存会
 * 触发同名不可达（issue #16 那一类）。
 */
export async function importForeignSkill(skill: ForeignSkill, targetRoot: string): Promise<string> {
  const collected = await collectForCopy(skill)
  if (collected.length === 0) throw new Error('skill has no files to import')

  const audited: AuditBundleFile[] = []
  const payload: Array<{ relative: string; buffer: Buffer }> = []
  for (const file of collected) {
    const buffer = await readFile(file.absolute)
    const text = asText(buffer)
    audited.push({ path: file.path, size: buffer.length, ...(text !== undefined ? { text } : {}) })
    payload.push({ relative: file.path, buffer })
  }
  const blocked = blockingReason(auditSkillBundle(audited))
  if (blocked !== undefined) throw new Error(blocked)

  await mkdir(targetRoot, { recursive: true })
  const tempDir = await mkdtemp(join(targetRoot, '.' + skill.name + '.foreign-'))
  try {
    for (const file of payload) {
      const target = join(tempDir, file.relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.buffer)
    }
    const discovery = skill.kind === 'flat' ? join(tempDir, basename(skill.path)) : join(tempDir, 'SKILL.md')
    let text: string
    try {
      text = await readFile(discovery, 'utf8')
    } catch {
      throw new Error('imported skill has no SKILL.md')
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) throw new Error('imported skill rejected: ' + parsed.error)
    if (parsed.value.name !== skill.name) {
      throw new Error(`skill declares name "${parsed.value.name}", expected "${skill.name}"`)
    }
    // 扁平技能落成目录包：`<name>.md` → `<name>/SKILL.md`，让两条写入路径归一。
    if (skill.kind === 'flat') {
      await mkdir(join(tempDir, skill.name), { recursive: true })
      await rename(discovery, join(tempDir, skill.name, 'SKILL.md'))
    }
    const targetDir = join(targetRoot, skill.name)
    await rename(skill.kind === 'flat' ? join(tempDir, skill.name) : tempDir, targetDir)
    return join(targetDir, 'SKILL.md')
  } finally {
    // 成功后 tempDir 只剩空壳（目录包被整体移走），失败时里面还有残留；
    // 一条 force 清理覆盖两种情况。
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
