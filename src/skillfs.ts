/**
 * Skill filesystem operations for the writable roots and the hub provider's
 * discovery. Toggling works by renaming the discovery file (SKILL.md inside
 * a directory bundle, or the flat <name>.md) to a .disabled name; the
 * watcher (ours or the preset's official filesystem provider) then updates
 * the live catalog by itself.
 *
 * Frontmatter parsing mirrors @deepseek-ai/dsh-skill-filesystem semantics:
 * required name (kebab-case) + description, optional whenToUse, invocation
 * booleans with the same defaults (modelInvocable defaults true,
 * userInvocable defaults true), legacy keys rejected, and the returned
 * content is the body after the frontmatter block, trimmed.
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { dshHome } from './store.ts'
import type { DiagnosticEntry, WritableRoot } from './protocol.ts'

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
  const normalized = join(path)
  for (const root of WRITABLE_ROOTS) {
    const base = rootPath(root, home)
    if (normalized.startsWith(base + '/') || normalized === base) return root
  }
  return undefined
}

/**
 * Scaffold a directory-bundle skill: <root>/<name>/SKILL.md with a frontmatter
 * template. Refuses non-kebab-case names.
 * @returns the created SKILL.md path.
 */
export async function createSkill(root: WritableRoot, name: string, description: string, home = dshHome()): Promise<string> {
  if (!isSkillName(name)) {
    throw new TypeError('skill name must be kebab-case (lowercase letters, digits, dashes): "' + name + '"')
  }
  const dir = join(rootPath(root, home), name)
  const file = join(dir, 'SKILL.md')
  await mkdir(dir, { recursive: true })
  const body = [
    '---',
    'name: ' + name,
    'description: ' + (description.trim() === '' ? 'New dsh skill created from the skill hub.' : description.trim()),
    '---',
    '',
    '# ' + name,
    '',
    'Describe what this skill does, when the agent should use it, and what output is expected.',
    '',
  ].join('\n')
  await writeFile(file, body, 'utf8')
  return file
}

/**
 * Disable one skill file by renaming it out of discovery shapes. Accepts
 * either the SKILL.md of a directory bundle or a flat .md.
 * @returns the absolute path after renaming.
 */
export async function disableSkill(path: string): Promise<string> {
  const kind = skillFileKind(path)
  if (kind === undefined) {
    throw new TypeError('not a discoverable skill file: ' + path)
  }
  const disabled = path + '.disabled'
  await rename(path, disabled)
  return disabled
}

/** Re-enable a previously disabled file (reverse of disableSkill). */
export async function enableSkill(disabledPath: string): Promise<string> {
  if (!disabledPath.endsWith('.disabled')) {
    throw new TypeError('not a disabled skill file: ' + disabledPath)
  }
  const original = disabledPath.slice(0, -'.disabled'.length)
  await rename(disabledPath, original)
  return original
}

/** Classify a skill file path: 'directory' (SKILL.md), 'flat' (<name>.md), or undefined. */
function skillFileKind(path: string): 'directory' | 'flat' | undefined {
  if (basename(path) === 'SKILL.md') return 'directory'
  if (path.endsWith('.md')) return 'flat'
  return undefined
}

/** One parsed frontmatter outcome (official provider semantics). */
export interface FrontmatterValue {
  name: string
  description: string
  whenToUse?: string
  /** Optional group names the skill declares (frontmatter `sets`). */
  sets?: string[]
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  /** Instruction body after the frontmatter block, trimmed. */
  content: string
}

/**
 * Normalize an optional frontmatter `sets` value into a clean string list.
 * Accepts a single string or a string array; trims, drops empties, and
 * ignores non-string entries. Returns undefined when absent or empty, so a
 * skill without sets stays uncategorized.
 */
export function normalizeSets(raw: unknown): string[] | undefined {
  const items = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : undefined
  if (items === undefined) return undefined
  const sets = items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return sets.length === 0 ? undefined : sets
}

/** Parse a SKILL.md the way the official filesystem provider does. */
export function parseFrontmatter(text: string): { value: FrontmatterValue } | { error: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (match === null) return { error: 'missing YAML frontmatter (--- block)' }
  let data: unknown
  try {
    data = load(match[1])
  } catch (error) {
    return { error: 'invalid YAML frontmatter: ' + (error instanceof Error ? error.message : String(error)) }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'frontmatter must be a YAML mapping' }
  }
  const record = data as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') return { error: 'frontmatter requires a name field' }
  if (!isSkillName(name)) return { error: 'invalid skill name "' + name + '" (must be kebab-case)' }
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  if (description === '') return { error: 'frontmatter requires a description field' }
  const whenToUse = typeof record.whenToUse === 'string' && record.whenToUse.trim() !== '' ? record.whenToUse.trim() : undefined
  const sets = normalizeSets(record.sets)
  if (Object.hasOwn(record, 'disableModelInvocation')) return { error: 'frontmatter field "disableModelInvocation" is unsupported; use "disable-model-invocation"' }
  if (Object.hasOwn(record, 'modelInvocable')) return { error: 'frontmatter field "modelInvocable" is unsupported; use "disable-model-invocation"' }
  if (Object.hasOwn(record, 'userInvocable')) return { error: 'frontmatter field "userInvocable" is unsupported; use "user-invocable"' }
  let invocation: { modelInvocable: boolean; userInvocable: boolean }
  try {
    const disableModel = frontmatterBoolean(record, 'disable-model-invocation')
    const userInvocable = frontmatterBoolean(record, 'user-invocable')
    invocation = { modelInvocable: disableModel !== true, userInvocable: userInvocable !== false }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return { value: { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}), ...(sets !== undefined ? { sets } : {}), invocation, content: (match[2] ?? '').trim() } }
}

/** Official boolean grammar: true/false, 1/0, and the common string spellings. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new TypeError('frontmatter field "' + key + '" must be a boolean')
}

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
 * the .system subdirectory is excluded when skipSystem is set (mirrors the
 * official provider's user-dsh behavior).
 */
export async function scanRoot(base: string, skipSystem: boolean): Promise<SkillEntry[]> {
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
    if (skipSystem && name === '.system') continue
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

/** Scan one writable root (user-dsh skips .system, mirroring the official provider). */
export function listSkillEntries(root: WritableRoot, home = dshHome()): Promise<SkillEntry[]> {
  return scanRoot(rootPath(root, home), root === 'user-dsh')
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
 * show why a skill never appears (the zcode-style diagnostics lesson: a
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
        diagnostics.push({ path: entry.path, root, reason: 'unreadable: ' + (error instanceof Error ? error.message : String(error)) })
      }
      continue
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) diagnostics.push({ path: entry.path, root, reason: parsed.error })
  }
  return diagnostics
}

