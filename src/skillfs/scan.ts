import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { parseFrontmatter, repairFrontmatterFileText } from './frontmatter.ts'
import { auditDescription, auditSkillText, type AuditFinding } from './audit.ts'
import { rootPath } from './paths.ts'
import { errorText } from '../error-text.ts'
import { mapConcurrent } from '../concurrency.ts'
import { dshHome } from '../store.ts'
import { HEX_COLOR_RE, type DiagnosticEntry, type WritableRoot } from '../protocol.ts'

/** One discoverable skill file in a scanned root. */
export interface SkillEntry {
  /** Absolute path of the discovery file (SKILL.md or the flat .md). */
  path: string
  /** Directory serving as the resource base (bundle dir or the root itself). */
  directory: string
  kind: 'directory' | 'flat'
}

/**
 * Scan one skills root for discovery files: directory bundles (SKILL.md)
 * and flat <name>.md files. Hub-disabled files (.disabled) are excluded;
 * dot-prefixed entries (including .trash and .system) are always skipped.
 */
export async function scanRoot(base: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  let names: string[]
  try {
    names = await readdir(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries
    throw error
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const absolute = join(base, name)
    let stats
    try {
      stats = await stat(absolute)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      entries.push({ path: join(absolute, 'SKILL.md'), directory: absolute, kind: 'directory' })
    } else if (name.endsWith('.md') && !name.endsWith('.md.disabled')) {
      entries.push({ path: absolute, directory: base, kind: 'flat' })
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Scan one writable root. */
export function listSkillEntries(root: WritableRoot, home = dshHome()): Promise<SkillEntry[]> {
  return scanRoot(rootPath(root, home))
}

/**
 * Scan one skills root for hub-disabled discovery files: directory bundles
 * renamed to SKILL.md.disabled and flat <name>.md.disabled files. Used by
 * the startup reconcile to rebuild sidecar records that were lost, which
 * would otherwise leave the skill invisible in every view.
 */
export async function scanDisabledRoot(base: string): Promise<string[]> {
  const paths: string[] = []
  let names: string[]
  try {
    names = await readdir(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return paths
    throw error
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const absolute = join(base, name)
    let stats
    try {
      stats = await stat(absolute)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      const candidate = join(absolute, 'SKILL.md.disabled')
      try {
        if ((await stat(candidate)).isFile()) paths.push(candidate)
      } catch {
        // 目录里没有禁用的发现文件，跳过
      }
    } else if (name.endsWith('.md.disabled')) {
      // 扁平形态的禁用文件。根级 `SKILL.md.disabled` 也归这里：`scanRoot` 会把
      // 根级 `SKILL.md` 文件当作一个扁平技能，它的禁用对应物就该被对账到。
      paths.push(absolute)
    }
  }
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** UI metadata from `agents/openai.yaml` beside a directory skill (mirrors codex SkillInterface). */
export interface SkillInterface {
  displayName?: string
  shortDescription?: string
  brandColor?: string
  iconSmall?: string
  iconLarge?: string
  defaultPrompt?: string
}

/** Read UI metadata from `agents/openai.yaml` beside a directory skill (mirrors codex SkillInterface). */
export async function readSkillInterface(directory: string): Promise<SkillInterface | undefined> {
  const yamlPath = join(directory, 'agents', 'openai.yaml')
  let text: string
  try {
    text = await readFile(yamlPath, 'utf8')
  } catch {
    return undefined
  }
  let data: unknown
  try {
    data = load(text)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  const iface = (record.interface ?? record) as Record<string, unknown>
  // codex stores interface under top-level `interface` key, but some templates put display_name at top level; support both.
  const ifaceObj = typeof record.interface === 'object' && record.interface !== null && !Array.isArray(record.interface) ? record.interface as Record<string, unknown> : iface
  const cleanStr = (value: unknown, maxLen: number): string | undefined => {
    if (typeof value !== 'string') return undefined
    const cleaned = value.split(/\s+/).join(' ').trim()
    if (cleaned === '' || cleaned.length > maxLen) return undefined
    return cleaned
  }
  const hexColor = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    // Shared with the settings card and the config route: one definition, so a
    // change to the accepted color format cannot land in only some of them.
    return HEX_COLOR_RE.test(trimmed) ? trimmed : undefined
  }
  const iconPath = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.trim() === '') return undefined
    const trimmed = value.trim().replace(/\\/g, '/')
    if (trimmed.startsWith('/') || trimmed.includes('..')) return undefined
    if (!trimmed.startsWith('assets/')) return undefined
    return trimmed
  }
  const displayName = cleanStr(ifaceObj.display_name, 64)
  const shortDescription = cleanStr(ifaceObj.short_description, 1024)
  const brandColor = hexColor(ifaceObj.brand_color)
  const defaultPrompt = cleanStr(ifaceObj.default_prompt, 1024)
  const iconSmall = iconPath(ifaceObj.icon_small)
  const iconLarge = iconPath(ifaceObj.icon_large)
  const hasAny = displayName !== undefined || shortDescription !== undefined || brandColor !== undefined || iconSmall !== undefined || iconLarge !== undefined || defaultPrompt !== undefined
  if (!hasAny) return undefined
  return { ...(displayName !== undefined ? { displayName } : {}), ...(shortDescription !== undefined ? { shortDescription } : {}), ...(brandColor !== undefined ? { brandColor } : {}), ...(iconSmall !== undefined ? { iconSmall } : {}), ...(iconLarge !== undefined ? { iconLarge } : {}), ...(defaultPrompt !== undefined ? { defaultPrompt } : {}) }
}

/**
 * Walk up from cwd (max 32 levels) for a project marker (.dsh or .git);
 * falls back to cwd itself. The provider roots project skills here.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  for (let depth = 0; depth < 32; depth += 1) {
    const markers = await Promise.allSettled([stat(join(current, '.dsh')), stat(join(current, '.git'))])
    if (markers.some((marker) => marker.status === 'fulfilled')) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(cwd)
}

/**
 * Scan one writable root for files the provider ignores, so the GUI can show
 * why a skill never appears — a missing frontmatter, a name that disagrees
 * with the discovery path, and the like must be visible, not silent. Files the
 * hub itself disabled (`.disabled`) are skipped: they are a toggle state, not
 * a defect.
 */
export async function scanDiagnostics(root: WritableRoot, home = dshHome()): Promise<DiagnosticEntry[]> {
  const entries = await listSkillEntries(root, home)
  // 同一个名字可以由两种发现形态同时占据（目录包 `<name>/SKILL.md` 与扁平
  // `<name>.md`）。注册表只会给出其中一个，另一个静默不可达 —— 必须报出来，
  // 否则面板上完全看不出「技能改了没生效」的原因。分组键同时取「发现路径名」
  // 与「frontmatter 名」：前者是官方 provider 的注册键，后者是本插件 provider
  // 的注册键，两边不一致时至少有一侧会撞上。
  const discovered: Array<{ path: string; keys: string[] }> = []
  // Each entry is read and parsed independently, and the panel polls /catalog
  // every 5 seconds. A serial read would make the response time grow linearly
  // with the skill count — the same reason the per-skill `stat` collection in
  // routes/catalog-data.ts is already parallel. Bounded, not a bare
  // Promise.all: a root can hold hundreds of entries.
  const perEntry = await mapConcurrent(entries, 8, async (entry): Promise<DiagnosticEntry[]> => {
    const found: DiagnosticEntry[] = []
    let text: string
    try {
      text = await readFile(entry.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        found.push({ path: entry.path, root, reason: 'unreadable: ' + (errorText(error)) })
      }
      return found
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) {
      const fixable = repairFrontmatterFileText(text) !== null
      found.push({ path: entry.path, root, reason: parsed.error, ...(fixable ? { fixable: true } : {}) })
      return found
    }
    // 内容审计：文件能被加载，不代表正文干净。隐藏字符与危险命令不会让
    // provider 报错，只会让人「看过却没看见」—— 和发现诊断放在同一块 UI 里，
    // 用 kind 区分（security 条目不可修复，只定位行号）。
    const auditFindings: AuditFinding[] = [
      ...auditSkillText(basename(entry.path), text),
      ...auditDescription(basename(entry.path), parsed.value.description),
    ]
    for (const finding of auditFindings) {
      found.push({
        path: entry.path,
        root,
        reason: (finding.line !== undefined ? `line ${finding.line}: ` : '') + finding.message,
        kind: 'security',
        severity: finding.severity,
      })
    }
    // File was auto-repaired in memory (e.g. unquoted `:`); surface a fixable hint so the user can persist it.
    const repaired = repairFrontmatterFileText(text)
    if (repaired !== null) {
      found.push({ path: entry.path, root, reason: 'frontmatter contains unquoted colon/bracket (auto-repaired in memory; click Fix to persist)', fixable: true })
    }
    const { value } = parsed
    // The provider registers a skill by its discovery path (directory name or
    // flat file name), so a frontmatter name that diverges from the path makes
    // the skill show up under a different identity than its metadata claims.
    const pathName = entry.kind === 'directory' ? basename(entry.directory) : basename(entry.path, '.md')
    discovered.push({ path: entry.path, keys: [...new Set([pathName, value.name])] })
    if (value.name !== pathName) {
      found.push({ path: entry.path, root, reason: `frontmatter name "${value.name}" does not match the discovery path "${pathName}" (the provider registers by path)` })
    }
    // Agents decide to auto-activate a skill from its one-line description, so
    // a too-short description leaves the skill hard to discover automatically.
    if (value.description.length < 10) {
      found.push({ path: entry.path, root, reason: `description is only ${value.description.length} chars; write a one-line description so agents can auto-activate this skill` })
    }
    return found
  })
  // 同名冲突：把每个命中冲突的发现文件各报一条，让用户两边都能看到并选一个处理。
  const owners = new Map<string, string[]>()
  for (const item of discovered) {
    for (const key of item.keys) {
      const list = owners.get(key)
      if (list === undefined) owners.set(key, [item.path])
      else list.push(item.path)
    }
  }
  const collisions: DiagnosticEntry[] = []
  for (const item of discovered) {
    const shared = item.keys.filter((key) => (owners.get(key)?.length ?? 0) > 1)
    if (shared.length === 0) continue
    collisions.push({
      path: item.path,
      root,
      reason: `another skill in this root registers the same name (${shared.map((key) => '"' + key + '"').join(', ')}); the registry keeps only one of them, so this one is unreachable — delete or rename one of the two`,
    })
  }
  // mapConcurrent preserves index order, so flattening keeps the previous
  // per-entry ordering of the diagnostics.
  return [...perEntry.flat(), ...collisions]
}

/**
 * 某个名字在一个 root 下现存的禁用发现文件（两种形态都认），没有则 undefined。
 * 目录包形态优先（`<name>/SKILL.md.disabled`），其次扁平 `<name>.md.disabled`。
 * 单点定义「禁用态在磁盘上长什么样」，避免各处再拼一次路径（issue #16 类）。
 */
export async function disabledOccupancyIn(base: string, name: string): Promise<string | undefined> {
  return (await occupancyOf(base, name)).disabled[0]
}

/** stat 一次给出形态；不存在或不可读时 undefined。 */
async function statKind(path: string): Promise<'file' | 'directory' | undefined> {
  try {
    const info = await stat(path)
    return info.isDirectory() ? 'directory' : 'file'
  } catch {
    return undefined
  }
}

/**
 * 一个名字在某个 root 下的全部磁盘占位。技能名是系统里唯一的身份，但同一个名字
 * 可以被两种形态（目录包 `<name>/SKILL.md` / 扁平 `<name>.md`）× 两种状态
 * （启用 / `.disabled` 改名）占据，而且两种形态可以**同时存在** —— 注册表只会
 * 给出其中一个，另一个静默不可达。所有按名字操作文件的路径都应该从这里取值，
 * 而不是各自拼一次路径（issue #16 类的根因）。
 *
 * 两个数组都按「目录包优先」排序：目录包是 hub 自己写入的形态（导入、创建、
 * 同步都建目录包），冲突时它是更「权威」的那份。
 */
export interface NameOccupancy {
  /** 启用态发现文件（目录包 `<name>/SKILL.md` 在前，扁平 `<name>.md` 在后）。 */
  enabled: string[]
  /** 禁用态发现文件（`<name>/SKILL.md.disabled` 在前，`<name>.md.disabled` 在后）。 */
  disabled: string[]
  /** `<name>/` 存在，但既没有 `SKILL.md` 也没有 `SKILL.md.disabled`（空壳/残留目录）。 */
  bareDir?: string
}

/** 读一个名字在某个 skills root 下的全部占位。只读，不修改磁盘。 */
export async function occupancyOf(base: string, name: string): Promise<NameOccupancy> {
  const bundleDir = join(base, name)
  const bundleSkill = join(bundleDir, 'SKILL.md')
  const bundleDisabled = join(bundleDir, 'SKILL.md.disabled')
  const flatSkill = join(base, name + '.md')
  const flatDisabled = join(base, name + '.md.disabled')
  const [bundleSkillKind, bundleDisabledKind, flatSkillKind, flatDisabledKind, bundleDirKind] = await Promise.all([
    statKind(bundleSkill),
    statKind(bundleDisabled),
    statKind(flatSkill),
    statKind(flatDisabled),
    statKind(bundleDir),
  ])
  const result: NameOccupancy = { enabled: [], disabled: [] }
  if (bundleSkillKind === 'file') result.enabled.push(bundleSkill)
  if (flatSkillKind === 'file') result.enabled.push(flatSkill)
  if (bundleDisabledKind === 'file') result.disabled.push(bundleDisabled)
  if (flatDisabledKind === 'file') result.disabled.push(flatDisabled)
  if (bundleDirKind === 'directory' && bundleSkillKind !== 'file' && bundleDisabledKind !== 'file') result.bareDir = bundleDir
  return result
}
