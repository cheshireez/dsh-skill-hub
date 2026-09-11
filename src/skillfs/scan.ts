import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { parseFrontmatter, repairFrontmatterFileText } from './frontmatter.ts'
import { rootPath } from './paths.ts'
import { errorText } from '../error-text.ts'
import { dshHome } from '../store.ts'
import type { DiagnosticEntry, WritableRoot } from '../protocol.ts'

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
    } else if (name.endsWith('.md.disabled') && name !== 'SKILL.md.disabled') {
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
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : undefined
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
 * Scan one writable root for files the provider ignores, so the GUI can
 * show why a skill never appears — a
 * missing frontmatter must be visible, not silent). .disabled files belong
 * to the hub and are skipped.
 */
export async function scanDiagnostics(root: WritableRoot, home = dshHome()): Promise<DiagnosticEntry[]> {
  const diagnostics: DiagnosticEntry[] = []
  for (const entry of await listSkillEntries(root, home)) {
    let text: string
    try {
      text = await readFile(entry.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        diagnostics.push({ path: entry.path, root, reason: 'unreadable: ' + (errorText(error)) })
      }
      continue
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) {
      const fixable = repairFrontmatterFileText(text) !== null
      diagnostics.push({ path: entry.path, root, reason: parsed.error, ...(fixable ? { fixable: true } : {}) })
      continue
    }
    // File was auto-repaired in memory (e.g. unquoted `:`); surface a fixable hint so the user can persist it.
    const repaired = repairFrontmatterFileText(text)
    if (repaired !== null) {
      diagnostics.push({ path: entry.path, root, reason: 'frontmatter contains unquoted colon/bracket (auto-repaired in memory; click Fix to persist)', fixable: true })
    }
    const { value } = parsed
    // The provider registers a skill by its discovery path (directory name or
    // flat file name), so a frontmatter name that diverges from the path makes
    // the skill show up under a different identity than its metadata claims.
    const pathName = entry.kind === 'directory' ? basename(entry.directory) : basename(entry.path, '.md')
    if (value.name !== pathName) {
      diagnostics.push({ path: entry.path, root, reason: `frontmatter name "${value.name}" does not match the discovery path "${pathName}" (the provider registers by path)` })
    }
    // Agents decide to auto-activate a skill from its one-line description, so
    // a too-short description leaves the skill hard to discover automatically.
    if (value.description.length < 10) {
      diagnostics.push({ path: entry.path, root, reason: `description is only ${value.description.length} chars; write a one-line description so agents can auto-activate this skill` })
    }
  }
  return diagnostics
}
