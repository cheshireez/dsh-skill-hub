/**
 * 外部 agent 技能的只读发现与收编。
 *
 * SKILL.md 已经是跨 agent 的事实标准（Claude Code / Codex / WorkBuddy / Cursor /
 * Gemini CLI 等 45+ 产品读同一份文件），但**发现路径各家不同**。于是「我在别处
 * 调好的技能」在 dsh 里看不见，用户只能手工复制目录。
 *
 * 这里只做两件事：读（列出别处有什么）和复制（把选中的收编到本地可写根）。
 * 外部目录一律**只读**，绝不改写 —— 那是别的 agent 的资产。
 *
 * 两个容易踩的坑：
 * - cc-switch 之类的集中管理会把**同一份技能软链到多个 agent 根**（本机实测
 *   Claude Code / Codex / Gemini CLI / OpenCode 的 56 条里只有约 19 个独立文件）。
 *   发现时按 realpath 合并成一条，其余 agent 名放进 `alsoIn`，否则列表膨胀三四倍、
 *   用户勾重了只会得到一串莫名其妙的 skipped。
 * - WorkBuddy 的市场元数据带指向原安装目录的绝对路径与外链，收编后全部失效，
 *   只在**副本**里剥掉（原文件不动）。
 */

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { ForeignScope } from '../protocol/foreign.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { scanRoot } from './scan.ts'
import { auditSkillBundle, blockingReason, MAX_SKILL_FILES, type AuditBundleFile } from './audit.ts'

/** 一个外部 agent 的技能根。`agent` 是展示用的稳定标识。 */
export interface ForeignRoot {
  agent: string
  /** 绝对路径；不存在时扫描直接返回空。 */
  dir: string
  /** 这是用户级目录还是项目根下的目录。决定收编到哪个可写根。 */
  scope: ForeignScope
  /** `scope === 'project'` 时的项目根绝对路径。 */
  projectRoot?: string
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
  scope: ForeignScope
  /** `scope === 'project'` 时的项目根。 */
  projectRoot?: string
  /** 同一份真实文件也在这些 agent 根里出现（软链集中管理）；按 realpath 合并后保留。 */
  alsoIn?: string[]
}

/** `importForeignSkill` 的落盘结果。 */
export interface ForeignImportOutcome {
  /** 落盘后的 SKILL.md 绝对路径。 */
  path: string
  /** 按安全策略跳过的包内符号链接数；> 0 表示副本可能不完整，需要提示用户。 */
  skippedSymlinks: number
}

/**
 * 常见 agent 的**用户级**技能目录。`~/.agents/skills` 不在此列 —— 那是 hub 自己的
 * 可写根（user-agents），重复列会让同一个技能出现两次。
 * 路径取自 vercel-labs/skills 的 agent 注册表，另补桌面端常见但未收录的 WorkBuddy。
 * 数组顺序也是合并同源软链时的优先级：靠前的 agent 作为主来源保留。
 */
export function foreignRoots(userHome: string): ForeignRoot[] {
  return [
    { agent: 'claude-code', dir: join(userHome, '.claude', 'skills'), scope: 'user' },
    { agent: 'codex', dir: join(userHome, '.codex', 'skills'), scope: 'user' },
    { agent: 'workbuddy', dir: join(userHome, '.workbuddy', 'skills'), scope: 'user' },
    { agent: 'cursor', dir: join(userHome, '.cursor', 'skills'), scope: 'user' },
    { agent: 'gemini-cli', dir: join(userHome, '.gemini', 'skills'), scope: 'user' },
    { agent: 'copilot', dir: join(userHome, '.copilot', 'skills'), scope: 'user' },
    { agent: 'opencode', dir: join(userHome, '.config', 'opencode', 'skills'), scope: 'user' },
    { agent: 'goose', dir: join(userHome, '.config', 'goose', 'skills'), scope: 'user' },
  ]
}

/**
 * 项目根下的外部技能目录。
 *
 * 与用户级是**两份不同的表**：项目里放技能的位置遵循各家的项目约定
 * （`.claude/skills`、`.workbuddy/skills`、…），而不是 `~/.config/opencode/skills`
 * 这种用户配置路径。`.dsh` 与 `.agents` 不在此列 —— 那是 dsh 自己的项目根，
 * 不是「别家的技能」。
 */
const PROJECT_AGENT_DIRS: ReadonlyArray<{ agent: string; dir: string }> = [
  { agent: 'claude-code', dir: '.claude/skills' },
  { agent: 'codex', dir: '.codex/skills' },
  { agent: 'workbuddy', dir: '.workbuddy/skills' },
  { agent: 'cursor', dir: '.cursor/skills' },
  { agent: 'gemini-cli', dir: '.gemini/skills' },
  { agent: 'copilot', dir: '.github/skills' },
  { agent: 'opencode', dir: '.opencode/skills' },
  { agent: 'windsurf', dir: '.windsurf/skills' },
  { agent: 'trae', dir: '.trae/skills' },
  { agent: 'roo', dir: '.roo/skills' },
  { agent: 'codebuddy', dir: '.codebuddy/skills' },
]

/**
 * 按项目根生成外部根。项目根必须由调用方从宿主登记的工作区推出来，
 * 不能由前端传入 —— 否则一个任意绝对路径就能让服务端去扫别人的家目录。
 * @param projectRoots - 已确认存在的项目根绝对路径。
 */
export function foreignProjectRoots(projectRoots: readonly string[]): ForeignRoot[] {
  const out: ForeignRoot[] = []
  for (const root of projectRoots) {
    for (const entry of PROJECT_AGENT_DIRS) {
      out.push({ agent: entry.agent, dir: join(root, entry.dir), scope: 'project', projectRoot: root })
    }
  }
  return out
}

/**
 * 扫描所有外部根。解析不出 frontmatter 的条目直接跳过 —— 它们在任何 agent 里
 * 都不会生效，列出来只会让人以为「导入就好了」。
 *
 * `existing` 只判用户级目标根；要按项目分别判请用 {@link scanForeignRoots}。
 */
export async function scanForeignSkills(userHome: string, existing: ReadonlySet<string> = new Set()): Promise<ForeignSkill[]> {
  return scanForeignRoots(foreignRoots(userHome), (skill) => existing.has(skill.name))
}

/** 发现文件的真实路径；软链解不开时退回原路径（不跟随的条目仍各自独立）。 */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

interface ScannedForeign {
  skill: ForeignSkill
  realPath: string
}

/**
 * 扫描指定的外部根，并按调用方给的判据标记「目标根已有同名」。
 *
 * 判据交出去，是因为**目标根不止一个**：用户级技能收编到 `~/.dsh/skills`，
 * 项目级技能收编到 `<projectRoot>/.dsh/skills`。同一个名字在一个根里占了、
 * 在另一个根里没占，是完全不同的两件事。
 *
 * 同源软链按「真实文件路径 + scope + 项目根」合并：cc-switch 这类集中管理会把
 * 一份技能挂到四五个 agent 目录下，不合并的话列表里同一个名字会连出好几行。
 * 合并只针对**同一份真实文件**，内容不同但同名的技能不会被误并。
 */
export async function scanForeignRoots(roots: readonly ForeignRoot[], isExisting: (skill: ForeignSkill) => boolean | Promise<boolean>): Promise<ForeignSkill[]> {
  const scanned: ScannedForeign[] = []
  for (const root of roots) {
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
      const skill: ForeignSkill = {
        name,
        description: parsed.value.description,
        agent: root.agent,
        path: entry.path,
        directory: entry.directory,
        kind: entry.kind,
        existing: false,
        scope: root.scope,
        ...(root.projectRoot !== undefined ? { projectRoot: root.projectRoot } : {}),
      }
      scanned.push({ skill, realPath: await realPathOf(entry.path) })
    }
  }

  // 按真实文件分组；roots 的遍历顺序决定组内谁当主来源。
  const groups = new Map<string, ScannedForeign[]>()
  for (const item of scanned) {
    const key = [item.realPath, item.skill.scope, item.skill.projectRoot ?? ''].join('\u0000')
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [item])
    else list.push(item)
  }

  const found: ForeignSkill[] = []
  for (const list of groups.values()) {
    const primary = list[0]
    if (primary === undefined) continue
    const alsoIn = [...new Set(list.slice(1).map((item) => item.skill.agent))]
      .filter((agent) => agent !== primary.skill.agent)
      .sort()
    const skill: ForeignSkill = alsoIn.length > 0 ? { ...primary.skill, alsoIn } : { ...primary.skill }
    // 判据可能是磁盘查询（按目标根查同名），所以允许异步。
    skill.existing = await isExisting(skill)
    found.push(skill)
  }
  return found.sort((a, b) => (a.name === b.name ? a.agent.localeCompare(b.agent) : a.name.localeCompare(b.name)))
}

interface CollectedFile {
  /** 相对技能目录的路径。 */
  path: string
  absolute: string
  size: number
}

interface WalkState {
  files: CollectedFile[]
  /** 因安全策略跳过的符号链接数。 */
  skippedSymlinks: number
}

/**
 * 递归列文件。符号链接不跟随（lstat）：一个指向 `~/.ssh` 的链接不该因为
 * 「用户点了导入」就被复制进技能目录。跳过是**有意的**，但要计数回传，
 * 否则副本缺了文件却报成功。
 */
async function walk(dir: string, base: string, depth: number, state: WalkState): Promise<void> {
  if (depth > 8 || state.files.length >= MAX_SKILL_FILES) return
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  names.sort()
  for (const name of names) {
    if (state.files.length >= MAX_SKILL_FILES) return
    if (name === '.git') continue
    const absolute = join(dir, name)
    let info
    try {
      info = await lstat(absolute)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) { state.skippedSymlinks += 1; continue }
    if (info.isDirectory()) await walk(absolute, base, depth + 1, state)
    else if (info.isFile()) state.files.push({ path: relative(base, absolute), absolute, size: info.size })
  }
}

async function collectForCopy(skill: ForeignSkill): Promise<WalkState> {
  if (skill.kind === 'flat') {
    const info = await lstat(skill.path)
    return { files: [{ path: basename(skill.path), absolute: skill.path, size: info.size }], skippedSymlinks: 0 }
  }
  const state: WalkState = { files: [], skippedSymlinks: 0 }
  await walk(skill.directory, skill.directory, 0, state)
  return state
}

/** 文本文件的判定与市场导入一致：无 NUL、解码无替换字符。 */
function asText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined
  const text = buffer.toString('utf8')
  return text.includes('\uFFFD') ? undefined : text
}

/**
 * WorkBuddy 市场元数据里带指向**原安装目录**的绝对路径、外部 CDN 链接和针对
 * 原包算出的内容哈希。收编到 dsh 根目录后这些值全部失效，留着只会误导。
 * 只改副本的字节，原目录一个字节都不动；解析不了就原样复制。
 */
function sanitizeForeignMetadata(relativePath: string, buffer: Buffer): Buffer {
  if (basename(relativePath) !== '_skillhub_meta.json') return buffer
  try {
    const data: unknown = JSON.parse(buffer.toString('utf8'))
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return buffer
    const record = data as Record<string, unknown>
    let changed = false
    for (const key of ['iconLocalPath', 'iconDownloadedFrom', 'iconSource', 'installedContentHash']) {
      if (Object.hasOwn(record, key)) { delete record[key]; changed = true }
    }
    return changed ? Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8') : buffer
  } catch {
    return buffer
  }
}

/**
 * 把一个外部技能收编到 `targetRoot`（通常是 `~/.dsh/skills`）。
 *
 * 与市场导入同一套闸：体积/数量上限 + 内容审计，命中阻断级直接拒绝；
 * 落盘仍是「临时目录 → 校验 → 原子 rename」，失败不留半成品。
 * 扁平技能统一落成目录包 —— hub 的所有写入路径都建目录包，两种形态并存会
 * 触发同名不可达（issue #16 那一类）。
 */
export async function importForeignSkill(skill: ForeignSkill, targetRoot: string): Promise<ForeignImportOutcome> {
  const { files: collected, skippedSymlinks } = await collectForCopy(skill)
  if (collected.length === 0) throw new Error('skill has no files to import')

  const audited: AuditBundleFile[] = []
  const payload: Array<{ relative: string; buffer: Buffer }> = []
  for (const file of collected) {
    const buffer = sanitizeForeignMetadata(file.path, await readFile(file.absolute))
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
    return { path: join(targetDir, 'SKILL.md'), skippedSymlinks }
  } finally {
    // 成功后 tempDir 只剩空壳（目录包被整体移走），失败时里面还有残留；
    // 一条 force 清理覆盖两种情况。
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
