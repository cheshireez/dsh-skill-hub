/**
 * 仓库技能发现：从 GitHub 仓库树推断技能根目录、列出可导入技能、
 * 生成目录清单并做上游差异比对。纯函数为主，便于单测。
 * 从 repo.ts 抽出。
 */

import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { RepoRoot, RepoSkillEntry } from '../protocol.ts'
import type { RepoFile, RepoRef, RepoTreeItem } from './types.ts'

/** Top-level directory pattern for a skill root: visible, non-dot, safe chars. First char must be alphanum. */
const ROOT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** `owner/repo` slug for a parsed reference. */
export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`
}

/**
 * Normalize a GitHub URL or `owner/repo`/`owner/repo@ref` input.
 * Only github.com URLs are accepted in v1.
 */
export function normalizeRepoInput(input: string): RepoRef | null {
  let value = input.trim()
  if (value === '') return null

  let ref: string | undefined
  const urlMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/#?@]+)(?:\/tree\/([^/?#]+))?/.exec(value)
  if (urlMatch !== null) {
    value = `${urlMatch[1]}/${urlMatch[2]}`
    ref = urlMatch[3]
  } else {
    if (/^https?:\/\//.test(value)) return null
    const at = value.indexOf('@')
    if (at !== -1) {
      ref = value.slice(at + 1).trim()
      value = value.slice(0, at).trim()
    }
  }

  value = value.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = value.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1]
  if (owner === '' || repo === '' || owner.includes('..') || repo.includes('..')) return null
  return { owner, repo, ...(ref !== undefined && ref !== '' ? { ref } : {}) }
}

/** Collect every file inside a skill directory, including SKILL.md itself. */
export function collectRepoSkillFiles(tree: readonly RepoTreeItem[], dir: string): RepoFile[] {
  const prefix = dir + '/'
  return tree
    .filter((item) => item.type === 'blob' && item.path.startsWith(prefix))
    .map((item) => ({ path: item.path, size: typeof item.size === 'number' ? item.size : 0 }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** Compute an origin collection name. Multiple roots split by root, one root keeps the repo slug. */
export function originForRoot(repo: string, rootsPresent: ReadonlySet<string>, root: string): string {
  return rootsPresent.size > 1 ? `${repo}/${root}` : repo
}

/** Discover importable skills from a repo tree. Invalid names are ignored. Roots are auto-derived from the top-level directory of each SKILL.md. */
export function discoverRepoEntries(tree: readonly RepoTreeItem[], repo: string, existingNames: ReadonlySet<string> = new Set()): RepoSkillEntry[] {
  const candidates: Array<{ root: RepoRoot; dir: string; name: string; path: string }> = []
  const rootsPresent = new Set<string>()
  for (const item of tree) {
    if (item.type !== 'blob') continue
    // Any SKILL.md at depth >=2: top segment is the root, last segment is the skill name (may be nested like root/category/name/SKILL.md)
    const slash = item.path.indexOf('/')
    if (slash === -1) continue
    if (!item.path.endsWith('/SKILL.md')) continue
    const root = item.path.slice(0, slash)
    if (!ROOT_RE.test(root)) continue
    const dir = item.path.slice(0, -'/SKILL.md'.length)
    // dir must be at least root/name (reject bare root/SKILL.md)
    if (dir === root || dir.length <= root.length + 1) continue
    const name = dir.slice(dir.lastIndexOf('/') + 1)
    if (!isSkillName(name)) continue
    rootsPresent.add(root)
    candidates.push({ root, dir, name, path: item.path })
  }
  return candidates
    .map((candidate) => {
      const files = collectRepoSkillFiles(tree, candidate.dir)
      return {
        name: candidate.name,
        dir: candidate.dir,
        path: candidate.path,
        root: candidate.root,
        origin: originForRoot(repo, rootsPresent, candidate.root),
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        existing: existingNames.has(candidate.name),
      } satisfies RepoSkillEntry
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Build a path→size manifest for one skill directory from a repo tree. */
export function skillManifest(tree: readonly RepoTreeItem[], dir: string): Record<string, number> {
  const prefix = dir + '/'
  const manifest: Record<string, number> = {}
  for (const item of tree) {
    if (item.type === 'blob' && item.path.startsWith(prefix)) {
      manifest[item.path] = typeof item.size === 'number' ? item.size : 0
    }
  }
  return manifest
}

/**
 * The real upstream directory of one tracked skill. Source records keep only
 * the short name and top-level root (e.g. root "skills", name "ask-matt"),
 * but upstream repos may nest skills under category directories
 * (skills/engineering/ask-matt/) or move them between categories. Resolution
 * order: exact match under the top-level root in the upstream tree, then the
 * manifest's recorded blob path, then any same-name skill in the tree, then
 * the flat root/name fallback. Passing the tree paths makes the lookup
 * resilient to incomplete manifests and upstream moves.
 */
export function skillDirOf(
  source: { root: string; manifest?: Record<string, number> },
  name: string,
  treePaths?: readonly string[],
): string {
  if (treePaths !== undefined) {
    const rootPrefix = source.root + '/'
    const found = treePaths.find((path) => path.startsWith(rootPrefix) && path.endsWith('/' + name + '/SKILL.md'))
    if (found !== undefined) return found.slice(0, found.lastIndexOf('/'))
  }
  const manifest = source.manifest ?? {}
  const fromManifest = Object.keys(manifest).find((path) => path.endsWith('/' + name + '/SKILL.md'))
  if (fromManifest !== undefined) return fromManifest.slice(0, fromManifest.lastIndexOf('/'))
  if (treePaths !== undefined) {
    const found = treePaths.find((path) => path.endsWith('/' + name + '/SKILL.md'))
    if (found !== undefined) return found.slice(0, found.lastIndexOf('/'))
  }
  return source.root + '/' + name
}

/**
 * Diff one source record against an upstream tree at treeSha: which tracked
 * skills disappeared (no SKILL.md blob) and which changed (manifest baseline
 * differs, or no baseline exists — treated as changed). Pure over the tree.
 */
export function diffRemoteSkills(
  tree: readonly RepoTreeItem[],
  source: { root: string; skills: readonly string[]; manifest?: Record<string, number> },
): { updated: string[]; deleted: string[] } {
  const blobs = new Map<string, number>()
  for (const item of tree) {
    if (item.type === 'blob') blobs.set(item.path, typeof item.size === 'number' ? item.size : 0)
  }
  const treePaths = [...blobs.keys()]
  const updated: string[] = []
  const deleted: string[] = []
  for (const name of source.skills) {
    const prefix = skillDirOf(source, name, treePaths) + '/'
    const remote = new Map<string, number>()
    for (const [path, size] of blobs) {
      if (path.startsWith(prefix)) remote.set(path, size)
    }
    if (!remote.has(prefix + 'SKILL.md')) {
      deleted.push(name)
      continue
    }
    const baseline = source.manifest ?? {}
    const baselineEntries = Object.entries(baseline).filter(([path]) => path.startsWith(prefix))
    if (baselineEntries.length === 0) {
      updated.push(name) // no baseline (migrated/legacy import): treat as changed
      continue
    }
    let differs = baselineEntries.length !== remote.size
    if (!differs) {
      for (const [path, size] of baselineEntries) {
        if (remote.get(path) !== size) {
          differs = true
          break
        }
      }
    }
    if (differs) updated.push(name)
  }
  return { updated, deleted }
}

/** Minimal RepoSkillEntry for a tracked skill name (sync re-downloads by name). */
export function repoSkillEntry(name: string, root: string, repo: string): RepoSkillEntry {
  return {
    name,
    dir: root + '/' + name,
    path: root + '/' + name + '/SKILL.md',
    root,
    origin: repo,
    fileCount: 0,
    totalBytes: 0,
    existing: false,
  }
}
