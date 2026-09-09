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

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { dump } from 'js-yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parseFrontmatter, repairFrontmatterFileText } from './skillfs/frontmatter.ts'
import { rootOfPath, rootPath } from './skillfs/paths.ts'
import { dshHome } from './store.ts'
import type { TrashEntry, WritableRoot } from './protocol.ts'

// Barrel: the frontmatter parser, the writable-root path helpers and the
// discovery scanner live under ./skillfs/ and are re-exported here unchanged.
export * from './skillfs/frontmatter.ts'
export * from './skillfs/paths.ts'
export * from './skillfs/scan.ts'

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
  const safeDescription = description.trim() === '' ? 'New dsh skill created from the skill hub.' : description.trim()
  const body = [
    '---',
    // dump() emits a quoted string when plain text would parse as a number,
    // mapping, or other non-string YAML (the official parser requires strings).
    'name: ' + dump(name).trim(),
    'description: ' + dump(safeDescription).trim(),
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

/**
 * Move a skill (directory bundle or flat .md file) into the root's trash.
 * The skill stays recoverable: the source is renamed into
 * <root>/.trash/<name>-<timestamp>. A directory bundle is addressed by its
 * SKILL.md path and moved as a whole directory.
 * @returns the trashed path plus the original path that was moved.
 */
export async function trashSkill(sourcePath: string): Promise<{ path: string; source: string }> {
  const source = basename(sourcePath) === 'SKILL.md' ? dirname(sourcePath) : sourcePath
  const trashDir = join(dirname(source), '.trash')
  await mkdir(trashDir, { recursive: true })
  const target = join(trashDir, basename(source) + '-' + Date.now())
  await rename(source, target)
  return { path: target, source }
}

/** Restore a trashed skill (directory or flat file) to its original location. */
export async function restoreSkill(entry: TrashEntry, home = dshHome()): Promise<string> {
  if (basename(dirname(entry.path)) !== '.trash') {
    throw new TypeError('not a trashed skill path: ' + entry.path)
  }
  const target = entry.sourcePath ?? join(dirname(dirname(entry.path)), entry.name)
  if (entry.sourcePath !== undefined && rootOfPath(entry.sourcePath, home) === undefined) {
    throw new TypeError('not a hub writable skill path: ' + entry.sourcePath)
  }
  await rename(entry.path, target)
  return target
}

/** Permanently delete one trashed skill (directory or flat file). */
export async function clearTrash(entry: TrashEntry, home = dshHome()): Promise<string> {
  if (basename(dirname(entry.path)) !== '.trash' || rootOfPath(dirname(dirname(entry.path)), home) === undefined) {
    throw new TypeError('not a hub trashed skill path: ' + entry.path)
  }
  await rm(entry.path, { recursive: true, force: true })
  return entry.path
}

/** Classify a skill file path: 'directory' (SKILL.md), 'flat' (<name>.md), or undefined. */
function skillFileKind(path: string): 'directory' | 'flat' | undefined {
  if (basename(path) === 'SKILL.md') return 'directory'
  if (path.endsWith('.md')) return 'flat'
  return undefined
}

/** Repair one file on disk when its frontmatter is auto-fixable. Returns the new text. */
export async function fixDiagnosticFile(path: string, home = dshHome()): Promise<string> {
  const root = rootOfPath(path, home)
  if (root === undefined) throw new TypeError('not a hub writable skill path: ' + path)
  const text = await readFile(path, 'utf8')
  const repairedText = repairFrontmatterFileText(text)
  if (repairedText === null) throw new TypeError('diagnostic is not auto-fixable: ' + path)
  // Validate the repaired text parses as a legal skill (prevents writing a still-broken file).
  const parsed = parseFrontmatter(repairedText)
  if ('error' in parsed) throw new TypeError('repaired frontmatter still invalid: ' + parsed.error)
  await writeFile(path, repairedText, 'utf8')
  return path
}
