/**
 * GitHub API 统一请求层：token 管理、鉴权头、ETag 缓存、错误映射、
 * 带缓存的 JSON GET。从 repo.ts 抽出，原 6 处重复的 try/catch +
 * headers + json 解析收敛到 fetchJson / fetchJsonCached 两个入口。
 */

/** Fetch failure carrying a useful HTTP status for the route layer. */
export class RepoFetchError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'RepoFetchError'
    this.status = status
  }
}

/**
 * GitHub token for authenticated API calls. Read from GITHUB_TOKEN /
 * GH_TOKEN at module load; setGithubToken() overrides it at runtime (the
 * host calls it from the settings sync whenever the card value changes;
 * an absent value falls back to the env var).
 */
let githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''

/** Override the GitHub token at runtime ('' falls back to the env var). */
export function setGithubToken(token: string | undefined): void {
  githubToken = token !== undefined && token !== '' ? token : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '')
}

/** Authorization header for api.github.com / raw.githubusercontent.com calls. */
export function githubAuthHeaders(): Record<string, string> {
  return githubToken === '' ? {} : { authorization: 'Bearer ' + githubToken }
}

/** JSON API 默认请求头（含鉴权）。 */
export function apiHeaders(): Record<string, string> {
  return { accept: 'application/vnd.github+json', ...githubAuthHeaders() }
}

/** ETag cache for GitHub API JSON (mirrors codex lib.rs marker+fingerprint). In-memory only, saves 304 for daily checks. */
const etagCache = new Map<string, { etag: string; json: unknown }>()
const ETAG_MAX = 200
function etagCacheGet(url: string): { etag: string; json: unknown } | undefined {
  return etagCache.get(url)
}
function etagCacheSet(url: string, etag: string, json: unknown): void {
  if (etagCache.size >= ETAG_MAX) {
    const first = etagCache.keys().next().value as string | undefined
    if (first !== undefined) etagCache.delete(first)
  }
  etagCache.set(url, { etag, json })
}
export function clearEtagCache(): void {
  etagCache.clear()
}

/**
 * Build a RepoFetchError; when the response shows an exhausted rate limit,
 * report the reset time instead of a bare HTTP status.
 */
export function fetchError(context: string, response: Response, fallbackStatus = 502): RepoFetchError {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  if (response.status === 403 || response.status === 429) {
    if (remaining === '0' && reset !== null) {
      const at = new Date(Number(reset) * 1000)
      return new RepoFetchError(
        'github rate limit reached (anonymous quota exhausted); retry after ' + at.toLocaleTimeString() + ' or set GITHUB_TOKEN',
        403,
      )
    }
  }
  return new RepoFetchError(context + ' (HTTP ' + response.status + ')', response.status === 404 ? 404 : fallbackStatus)
}

/** 是否限流/中断类错误（调用方可直接透出，不再包装）。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted') || error.message.includes('Abort'))
}

/**
 * 不带缓存的统一 GET+JSON：网络异常、非 2xx、坏 JSON 全部映射为
 * RepoFetchError，调用方无需重复写 try/catch。
 */
export async function fetchJson(url: string, fetchImpl: typeof fetch, context: string, headers: Record<string, string> = apiHeaders()): Promise<{ json: unknown; response: Response }> {
  let response: Response
  try {
    response = await fetchImpl(url, { headers })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new RepoFetchError(context + ': ' + (error instanceof Error ? error.message : String(error)))
  }
  if (!response.ok) throw fetchError(context, response)
  try {
    return { json: await response.json(), response }
  } catch {
    throw new RepoFetchError('invalid github response for ' + url)
  }
}

/**
 * Load repo metadata and the recursive git tree at the given ref. The meta
 * request always resolves the default branch (used when ref is absent); the
 * tree is fetched at `ref ?? default_branch` so an explicit branch/tag scans
 * the exact same content a later download would fetch.
 */
export async function fetchJsonCached(url: string, fetchImpl: typeof fetch, context: string): Promise<{ json: unknown; response: Response }> {
  const cached = etagCacheGet(url)
  const headers: Record<string, string> = { ...apiHeaders() }
  if (cached !== undefined) headers['if-none-match'] = cached.etag
  let response: Response
  try {
    response = await fetchImpl(url, { headers })
  } catch (error) {
    throw new RepoFetchError(context + ': ' + (error instanceof Error ? error.message : String(error)))
  }
  if (response.status === 304 && cached !== undefined) {
    // Return cached JSON with a synthetic 200-like response for error mapping.
    return { json: cached.json, response }
  }
  if (!response.ok) throw fetchError(context, response)
  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new RepoFetchError('invalid github response for ' + url)
  }
  const etag = response.headers.get('etag')
  if (etag !== null && etag !== '') etagCacheSet(url, etag, json)
  return { json, response }
}
