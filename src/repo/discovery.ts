/**
 * 仓库技能发现：从 GitHub 仓库树推断技能根目录、列出可导入技能、
 * 生成目录清单并做上游差异比对。纯函数为主，便于单测。
 * 从 repo.ts 抽出。
 *
 * 路径语义集中在几个内部函数上：`skillDirPrefix`（技能目录在树里的前缀）、
 * `isRepoTooling`（永不属于技能的仓库基建）、`skillFileAt`（目录内的
 * SKILL.md 路径）。collect / manifest / diff 三处必须共用它们，否则差异
 * 比对会永远报「有更新」。
 */

import { isSkillName } from '@deepseek-ai/dsh-skill'
import { REPO_ROOT_RE } from '../protocol/repo.ts'
import type { RepoRoot, RepoSkillEntry } from '../protocol.ts'
import type { RepoFile, RepoRef, RepoTreeItem } from './types.ts'

/**
 * Sentinel root for a skill whose SKILL.md sits directly at the repository
 * root instead of under a top-level directory. That layout is legal and used
 * upstream (a Claude Code plugin manifest may declare `"skills": ["./"]`),
 * and the empty string is the representation that composes with plain prefix
 * arithmetic: an empty prefix *is* the repo root. Every path helper below
 * special-cases it, because `'' + '/' + name` would produce a bogus absolute
 * `/name` that matches no tree path.
 */
export const REPO_ROOT: RepoRoot = ''

/** True when a root denotes the repo root itself (the repo is the skill dir). */
export function isRepoRoot(root: string): boolean {
  return root === REPO_ROOT
}

/**
 * The tree prefix delimiting a skill directory: empty for the repo-root skill
 * (it owns the whole tree), otherwise `<dir>/`. Single source for collect,
 * manifest, diff and the store's baseline cleanup, so they can never disagree.
 */
export function skillDirPrefix(dir: string): string {
  return isRepoRoot(dir) ? '' : dir + '/'
}

/**
 * A path inside a skill directory, as it appears in the repo tree. Both
 * directions of this mapping matter: repo paths are always '/'-joined (never
 * node:path's OS separator, these are GitHub paths shown in the UI), and the
 * repo-root case must not grow a leading slash.
 */
export function skillPathIn(dir: string, relative: string): string {
  return skillDirPrefix(dir) + relative
}

/** The SKILL.md path inside a skill directory. */
export function skillFileAt(dir: string): string {
  return skillPathIn(dir, 'SKILL.md')
}

/**
 * Top-level dot entries are repo tooling, never part of a skill: `.github/`,
 * `.claude-plugin/`, `.gitignore`. Only the repo-root skill can reach them,
 * since its prefix is empty and would otherwise sweep in the whole repo.
 * Nested skill dirs cannot start with a dot (ROOT_RE), so this is a no-op
 * for them.
 */
function isRepoTooling(path: string): boolean {
  return path.startsWith('.')
}

/** Every tree blob belonging to a skill directory, sorted by path. */
function skillTreeFiles(tree: readonly RepoTreeItem[], dir: string): RepoFile[] {
  const prefix = skillDirPrefix(dir)
  return tree
    .filter((item) => item.type === 'blob' && item.path.startsWith(prefix) && !isRepoTooling(item.path))
    .map((item) => ({ path: item.path, size: typeof item.size === 'number' ? item.size : 0 }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * A repo file's path relative to its skill directory — the path it is written
 * to under the skill's own directory. `dir === ''` means the repo file path
 * *is* the relative path; slicing `dir.length + 1` would eat its first
 * character.
 */
export function relativeToSkillDir(dir: string, path: string): string {
  return isRepoRoot(dir) ? path : path.slice(dir.length + 1)
}

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
  return skillTreeFiles(tree, dir)
}

/**
 * Compute an origin collection name. Multiple roots split by root, one root
 * keeps the repo slug. The repo-root skill's name *is* the repo slug, so it
 * never gets a trailing-slash suffix (`owner/repo/`).
 */
export function originForRoot(repo: string, rootsPresent: ReadonlySet<string>, root: string): string {
  if (rootsPresent.size <= 1) return repo
  return isRepoRoot(root) ? repo : `${repo}/${root}`
}

/** Discover importable skills from a repo tree. Invalid names are ignored. Roots are auto-derived from the top-level directory of each SKILL.md. */
export function discoverRepoEntries(tree: readonly RepoTreeItem[], repo: string, existingNames: ReadonlySet<string> = new Set()): RepoSkillEntry[] {
  const candidates: Array<{ root: RepoRoot; dir: string; name: string; path: string }> = []
  const rootsPresent = new Set<string>()
  // Repo-root layout: `SKILL.md` at the very top of the tree, the whole repo
  // being one skill. The name comes from the repo slug; downloadRepoSkill
  // re-checks it against the frontmatter and rejects a mismatch with a 422,
  // so a wrong guess is reported rather than silently mis-installed.
  const repoName = repo.slice(repo.lastIndexOf('/') + 1)
  if (isSkillName(repoName) && tree.some((item) => item.type === 'blob' && item.path === 'SKILL.md')) {
    rootsPresent.add(REPO_ROOT)
    candidates.push({ root: REPO_ROOT, dir: REPO_ROOT, name: repoName, path: 'SKILL.md' })
  }
  for (const item of tree) {
    if (item.type !== 'blob') continue
    // Any SKILL.md at depth >=2: top segment is the root, last segment is the skill name (may be nested like root/category/name/SKILL.md)
    const slash = item.path.indexOf('/')
    if (slash === -1) continue
    if (!item.path.endsWith('/SKILL.md')) continue
    const root = item.path.slice(0, slash)
    if (!REPO_ROOT_RE.test(root)) continue
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

/**
 * Build a path→size manifest for one skill directory from a repo tree.
 * Shares `skillTreeFiles` with collectRepoSkillFiles: a manifest that
 * disagreed with the collected file set would make every update diff report
 * "changed" forever.
 */
export function skillManifest(tree: readonly RepoTreeItem[], dir: string): Record<string, number> {
  const manifest: Record<string, number> = {}
  for (const file of skillTreeFiles(tree, dir)) manifest[file.path] = file.size
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
 *
 * A repo-root record (root '') has no directory to resolve: its SKILL.md is a
 * bare top-level path, so every nested lookup below would miss and the final
 * fallback would hand back a bogus '/name'. Answer before them — including
 * when the upstream SKILL.md is gone, so diffRemoteSkills reports a deletion
 * instead of hunting for a skill that was never nested.
 */
export function skillDirOf(
  source: { root: string; manifest?: Record<string, number> },
  name: string,
  treePaths?: readonly string[],
): string {
  if (isRepoRoot(source.root)) return REPO_ROOT
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
 * The remote side is read through skillManifest, so the diff compares like
 * with like against the baseline recorded at import time.
 */
export function diffRemoteSkills(
  tree: readonly RepoTreeItem[],
  source: { root: string; skills: readonly string[]; manifest?: Record<string, number> },
): { updated: string[]; deleted: string[] } {
  const treePaths = tree.filter((item) => item.type === 'blob').map((item) => item.path)
  const updated: string[] = []
  const deleted: string[] = []
  const baseline = source.manifest ?? {}
  for (const name of source.skills) {
    const dir = skillDirOf(source, name, treePaths)
    const prefix = skillDirPrefix(dir)
    const remote = skillManifest(tree, dir)
    if (!Object.hasOwn(remote, skillFileAt(dir))) {
      deleted.push(name)
      continue
    }
    const baselineEntries = Object.entries(baseline).filter(([path]) => path.startsWith(prefix))
    if (baselineEntries.length === 0) {
      updated.push(name) // no baseline (migrated/legacy import): treat as changed
      continue
    }
    let differs = baselineEntries.length !== Object.keys(remote).length
    if (!differs) {
      for (const [path, size] of baselineEntries) {
        if (remote[path] !== size) {
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
  const dir = isRepoRoot(root) ? REPO_ROOT : root + '/' + name
  return {
    name,
    dir,
    path: skillFileAt(dir),
    root,
    origin: repo,
    fileCount: 0,
    totalBytes: 0,
    existing: false,
  }
}
