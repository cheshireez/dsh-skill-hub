/**
 * GitHub 仓库读取：仓库树、发布标签、星标/下载量、分支与提交查询。
 * 统一走 repo/github-client.ts 的请求层（鉴权、ETag 缓存、错误映射）。
 * 从 repo.ts 抽出。
 */

import { RepoFetchError, apiHeaders, fetchJson, fetchJsonCached } from './github-client.ts'
import type { RepoTreeItem } from './types.ts'

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
