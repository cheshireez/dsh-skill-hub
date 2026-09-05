/**
 * GitHub repository skill discovery/import helpers.
 *
 * Kept dependency-free and mostly pure so the root/origin rules are easy to
 * test. Roots are auto-derived: any top-level directory that contains a
 * `**\/SKILL.md` (e.g. `skills/**`, `design-templates/**`, `templates/**`,
 * `workflows/**`) is treated as a skill root. No hard-coded allowlist.
 */

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { RepoRoot, RepoSkillEntry } from './protocol.ts'
import { parseFrontmatter } from './skillfs.ts'
import {
  RepoFetchError,
  apiHeaders,
  fetchError,
  fetchJson,
  fetchJsonCached,
  githubAuthHeaders,
  isAbortError,
} from './repo/github-client.ts'

// 后向兼容：老 `from './repo.ts'` 写法继续可用，新代码可直引 github-client。
export { RepoFetchError, clearEtagCache, fetchError, fetchJson, fetchJsonCached, githubAuthHeaders, isAbortError, setGithubToken } from './repo/github-client.ts'

/** Preferred display order for known roots; unknown roots sort alphabetically after these. */
export const REPO_ROOTS: readonly RepoRoot[] = ['skills', 'design-templates']

/** Top-level directory pattern for a skill root: visible, non-dot, safe chars. First char must be alphanum. */
const ROOT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Parsed GitHub repository reference. */
export interface RepoRef {
  owner: string
  repo: string
  /** Explicit branch/tag when supplied; undefined means use the default branch. */
  ref?: string
}

/** One file inside a GitHub repo tree. */
export interface RepoTreeItem {
  path: string
  type: 'blob' | 'tree'
  size?: number
}

/** One file belonging to a skill directory. */
export interface RepoFile {
  path: string
  size: number
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

export async function loadRepoTree(repo: string, ref?: string, fetchImpl: typeof fetch = fetch): Promise<{ ref: string; tree: RepoTreeItem[]; truncated: boolean }> {
  const metaUrl = `https://api.github.com/repos/${repo}`
  const { json: metaJson } = await fetchJsonCached(metaUrl, fetchImpl, 'github repo not found or unavailable')
  let meta: unknown = metaJson
  const record = typeof meta === 'object' && meta !== null ? meta as Record<string, unknown> : {}
  const defaultBranch = typeof record.default_branch === 'string' && record.default_branch !== '' ? record.default_branch : 'main'
  const treeRef = ref !== undefined && ref !== '' ? ref : defaultBranch

  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`
  const { json: payload } = await fetchJsonCached(treeUrl, fetchImpl, 'github tree not found')
  const treeRecord = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const truncated = treeRecord.truncated === true
  const tree = Array.isArray(treeRecord.tree) ? treeRecord.tree as RepoTreeItem[] : []
  // Report the ref the tree was actually fetched at: downloaders must use
  // this exact value so an explicit branch import never mixes trees.
  // When truncated is true GitHub returned a partial tree; callers should
  // surface a warning but still allow the partial discovery (mirrors codex walk_truncated).
  return { ref: treeRef, tree, truncated }
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

/** Run an async worker over items with a bounded concurrency. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Download one GitHub file as a buffer. Tries raw.githubusercontent.com
 * first (no API quota); on any failure falls back to the api.github.com
 * contents endpoint with the raw media type (rate-limited, but reachable
 * from networks that block the raw host).
 */
export async function downloadGitHubFile(repo: string, ref: string, path: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodedPath}`
  let firstError: string | null = null
  let response: Response | null = null
  try {
    response = await fetchImpl(rawUrl, { headers: githubAuthHeaders(), ...(signal !== undefined ? { signal } : {}) })
  } catch (error) {
    if (isAbortError(error)) throw error
    firstError = error instanceof Error ? error.message : String(error)
  }
  if (response === null || !response.ok) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    // Fallback: api.github.com/contents with the raw media type.
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodedPath}`
    try {
      response = await fetchImpl(apiUrl, { headers: { accept: 'application/vnd.github.raw', ...githubAuthHeaders() }, ...(signal !== undefined ? { signal } : {}) })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new RepoFetchError('download failed: ' + (firstError ?? (error instanceof Error ? error.message : String(error))))
    }
  }
  if (response === null || !response.ok) {
    throw fetchError('download failed', response)
  }
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new RepoFetchError('download read failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Download a full skill directory into a temporary dir, validate SKILL.md,
 * then atomically rename it into place. The target root is created when missing.
 * Callers pass a target root and a skill entry plus its collected files.
 */
export async function downloadRepoSkill(
  repo: string,
  ref: string,
  entry: RepoSkillEntry,
  files: readonly RepoFile[],
  targetRoot: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  onProgress?: (bytes: number, file: string) => void,
): Promise<{ targetDir: string; skillPath: string }> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const targetDir = join(targetRoot, entry.name)
  await mkdir(targetRoot, { recursive: true })
  // Dot-prefixed so a leftover temp dir can never surface as a skill in the
  // provider's discovery scan (scanRoot skips dot entries).
  const tempDir = await mkdtemp(join(targetRoot, '.' + entry.name + '.import-'))
  let renamed = false
  try {
    await mapConcurrent(files, 6, async (file) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const relative = file.path.slice(entry.dir.length + 1)
      if (relative === '' || relative.includes('..')) throw new RepoFetchError('unsafe repo path: ' + file.path)
      const target = join(tempDir, relative)
      const buffer = await downloadGitHubFile(repo, ref, file.path, fetchImpl, signal)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
      onProgress?.(buffer.length, relative)
    })

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    let text: string
    try {
      text = await readFile(join(tempDir, 'SKILL.md'), 'utf8')
    } catch {
      throw new RepoFetchError('downloaded skill has no SKILL.md')
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) throw new RepoFetchError('downloaded skill rejected: ' + parsed.error, 422)
    if (parsed.value.name !== entry.name) {
      throw new RepoFetchError('downloaded skill declares name "' + parsed.value.name + '", expected "' + entry.name + '"', 422)
    }

    await rename(tempDir, targetDir)
    renamed = true
    return { targetDir, skillPath: join(targetDir, 'SKILL.md') }
  } catch (error) {
    throw error
  } finally {
    if (!renamed) {
      // 尽力清理临时目录，失败只打日志，不再静默吞掉；finally 保证 abort/异常都能清理
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch (firstError) {
        // 并发 worker 可能仍在写入，稍等 60ms 重试一次
        await new Promise((resolve) => setTimeout(resolve, 60))
        try {
          await rm(tempDir, { recursive: true, force: true })
        } catch (secondError) {
          console.warn(`[skill-hub] cleanup tempDir failed ${tempDir}:`, secondError instanceof Error ? secondError.message : String(secondError), 'first:', firstError instanceof Error ? firstError.message : String(firstError))
        }
      }
    }
  }
}

/**
 * 启动时扫描并清理残留的 `.*.import-*` 临时目录（Issue #3 第4点）。
 * 越积越多的点前缀目录不会显示为 skill，但会占空间，尽早回收。
 */
export async function cleanupLeftoverImportDirs(targetRoot: string): Promise<number> {
  const { readdir, rm: rm2 } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(targetRoot)
  } catch {
    return 0
  }
  let cleaned = 0
  for (const name of names) {
    if (!/^\..*\.import-/.test(name)) continue
    const full = join(targetRoot, name)
    try {
      await rm2(full, { recursive: true, force: true })
      cleaned += 1
    } catch (error) {
      console.warn(`[skill-hub] startup cleanup failed ${full}:`, error instanceof Error ? error.message : String(error))
    }
  }
  if (cleaned > 0) console.warn(`[skill-hub] startup cleaned ${cleaned} leftover import temp dir(s) in ${targetRoot}`)
  return cleaned
}

// ------------------------------------------------------- source tracking

/**
 * The latest non-prerelease release tag of a repo, or undefined when the
 * repo has no releases (GitHub's /releases/latest skips prereleases/drafts).
 */
export async function getLatestReleaseTag(repo: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  let payload: unknown
  try {
    ;({ json: payload } = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, fetchImpl, 'github release lookup failed'))
  } catch (error) {
    if (error instanceof RepoFetchError && error.status === 404) return undefined
    throw error
  }
  const tag = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).tag_name : undefined
  return typeof tag === 'string' && tag !== '' ? tag : undefined
}

/** Stars + release-asset downloads of a repo (two GitHub API requests). */
export async function getRepoStats(repo: string, fetchImpl: typeof fetch = fetch): Promise<{ stars: number; downloads: number }> {
  const headers = apiHeaders()
  const { json: meta } = await fetchJson(`https://api.github.com/repos/${repo}`, fetchImpl, 'github repo not found or unavailable', headers)
  const stars = typeof meta === 'object' && meta !== null && typeof (meta as Record<string, unknown>).stargazers_count === 'number'
    ? (meta as Record<string, unknown>).stargazers_count as number
    : 0
  let downloads = 0
  try {
    const relResponse = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers })
    if (relResponse.ok) {
      const releases: unknown = await relResponse.json()
      if (Array.isArray(releases)) {
        for (const item of releases) {
          if (typeof item !== 'object' || item === null) continue
          const assets = (item as Record<string, unknown>).assets
          if (!Array.isArray(assets)) continue
          for (const asset of assets) {
            if (typeof asset === 'object' && asset !== null && typeof (asset as Record<string, unknown>).download_count === 'number') {
              downloads += (asset as Record<string, unknown>).download_count as number
            }
          }
        }
      }
    }
  } catch {
    // downloads stay 0; stars are the primary signal
  }
  return { stars, downloads }
}

/** Release tags of a repo, newest first (skips drafts, keeps prereleases). */
export async function listRepoReleases(repo: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const { json: payload } = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=20`, fetchImpl, 'github releases lookup failed')
  if (!Array.isArray(payload)) return []
  return payload
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && (item as Record<string, unknown>).draft !== true)
    .map((item) => item.tag_name)
    .filter((tag): tag is string => typeof tag === 'string' && tag !== '')
}

/** Branch names of a repo, default branch first (one GitHub API request). */
export async function listRepoBranches(repo: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const { json: payload } = await fetchJson(`https://api.github.com/repos/${repo}/branches?per_page=100`, fetchImpl, 'github branches lookup failed')
  if (!Array.isArray(payload)) return []
  const names = payload
    .map((item) => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '')
  return names
}

/**
 * Fetch the latest commit of a repo (explicit ref or default branch) with
 * its tree SHA. One GitHub API request; the tree SHA is used to diff the
 * upstream tree on change (one extra request).
 */
export async function getLatestCommit(repo: string, ref?: string, fetchImpl: typeof fetch = fetch): Promise<{ commitSha: string; treeSha: string }> {
  const url = ref !== undefined && ref !== ''
    ? `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`
    : `https://api.github.com/repos/${repo}/commits?per_page=1`
  const { json: payload } = await fetchJson(url, fetchImpl, 'github commit lookup failed')
  const record = Array.isArray(payload)
    ? (payload[0] ?? {}) as Record<string, unknown>
    : typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const commitSha = typeof record.sha === 'string' && record.sha !== '' ? record.sha : null
  const tree = typeof record.commit === 'object' && record.commit !== null ? (record.commit as Record<string, unknown>).tree as Record<string, unknown> | undefined : undefined
  const treeSha = typeof tree?.sha === 'string' && tree.sha !== '' ? tree.sha : null
  if (commitSha === null || treeSha === null) throw new RepoFetchError('github commit response has no sha/tree')
  return { commitSha, treeSha }
}

/** Load the recursive git tree at an explicit tree SHA (one API request). */
export async function loadRepoTreeAt(repo: string, treeSha: string, fetchImpl: typeof fetch = fetch): Promise<RepoTreeItem[]> {
  const { json: payload } = await fetchJson(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, fetchImpl, 'github tree lookup failed')
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  if (record.truncated === true) throw new RepoFetchError('repo tree is too large to scan')
  return Array.isArray(record.tree) ? record.tree as RepoTreeItem[] : []
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

