/**
 * GitHub repository skill discovery/import helpers.
 *
 * Kept dependency-free and mostly pure so the root/origin rules are easy to
 * test. The two supported roots mirror the repositories we care about:
 * `skills/**` (standard skill bundles) and `design-templates/**` (template
 * skill bundles in nexu-io/open-design).
 */

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { RepoRoot, RepoSkillEntry } from './protocol.ts'
import { parseFrontmatter } from './skillfs.ts'

/** Supported skill roots in a GitHub repo. */
export const REPO_ROOTS: readonly RepoRoot[] = ['skills', 'design-templates']

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

/** Fetch failure carrying a useful HTTP status for the route layer. */
export class RepoFetchError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'RepoFetchError'
    this.status = status
  }
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

/** Load repo metadata and the recursive git tree. Always resolves the default branch. */
export async function loadRepoTree(repo: string, fetchImpl: typeof fetch = fetch): Promise<{ ref: string; tree: RepoTreeItem[] }> {
  let metaResponse: Response
  try {
    metaResponse = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: { accept: 'application/vnd.github+json' },
    })
  } catch (error) {
    throw new RepoFetchError('github request failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (!metaResponse.ok) throw new RepoFetchError('github repo not found or unavailable (HTTP ' + metaResponse.status + ')', metaResponse.status === 404 ? 404 : 502)

  let meta: unknown
  try {
    meta = await metaResponse.json()
  } catch {
    throw new RepoFetchError('invalid github repo response')
  }
  const record = typeof meta === 'object' && meta !== null ? meta as Record<string, unknown> : {}
  const ref = typeof record.default_branch === 'string' && record.default_branch !== '' ? record.default_branch : 'main'

  let treeResponse: Response
  try {
    treeResponse = await fetchImpl(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
      headers: { accept: 'application/vnd.github+json' },
    })
  } catch (error) {
    throw new RepoFetchError('github tree request failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (!treeResponse.ok) throw new RepoFetchError('github tree not found (HTTP ' + treeResponse.status + ')', treeResponse.status === 404 ? 404 : 502)

  let payload: unknown
  try {
    payload = await treeResponse.json()
  } catch {
    throw new RepoFetchError('invalid github tree response')
  }
  const treeRecord = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  if (treeRecord.truncated === true) throw new RepoFetchError('repo tree is too large to scan')
  const tree = Array.isArray(treeRecord.tree) ? treeRecord.tree as RepoTreeItem[] : []
  return { ref, tree }
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
export function originForRoot(repo: string, rootsPresent: ReadonlySet<RepoRoot>, root: RepoRoot): string {
  return rootsPresent.size > 1 ? `${repo}/${root}` : repo
}

/** Discover importable skills from a repo tree. Invalid names are ignored. */
export function discoverRepoEntries(tree: readonly RepoTreeItem[], repo: string, existingNames: ReadonlySet<string> = new Set()): RepoSkillEntry[] {
  const candidates: Array<{ root: RepoRoot; dir: string; name: string; path: string }> = []
  const rootsPresent = new Set<RepoRoot>()
  for (const item of tree) {
    if (item.type !== 'blob') continue
    const match = /^(skills|design-templates)\/(.+)\/SKILL\.md$/.exec(item.path)
    if (match === null) continue
    const root = match[1] as RepoRoot
    const dir = item.path.slice(0, -'/SKILL.md'.length)
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

/** Download one GitHub raw file as a buffer. */
export async function downloadGitHubFile(repo: string, ref: string, path: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodedPath}`
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    throw new RepoFetchError('download failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (!response.ok) throw new RepoFetchError('download failed (HTTP ' + response.status + ') for ' + path)
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new RepoFetchError('download read failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Download a full skill directory into a temporary dir, validate SKILL.md,
 * then atomically rename it into place. Callers pass an existing target root
 * and a skill entry plus its collected files.
 */
export async function downloadRepoSkill(
  repo: string,
  ref: string,
  entry: RepoSkillEntry,
  files: readonly RepoFile[],
  targetRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ targetDir: string; skillPath: string }> {
  const targetDir = join(targetRoot, entry.name)
  const tempDir = await mkdtemp(join(targetRoot, entry.name + '.import-'))
  try {
    await mapConcurrent(files, 6, async (file) => {
      const relative = file.path.slice(entry.dir.length + 1)
      if (relative === '' || relative.includes('..')) throw new RepoFetchError('unsafe repo path: ' + file.path)
      const target = join(tempDir, relative)
      const buffer = await downloadGitHubFile(repo, ref, file.path, fetchImpl)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
    })

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
    return { targetDir, skillPath: join(targetDir, 'SKILL.md') }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
