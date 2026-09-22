import { errorText } from '../error-text.ts'

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

/**
 * 传输层：显式要求服务端返回未压缩实体。
 *
 * 为什么必须加：dsh 会把**启动环境**里的 `HTTP_PROXY`/`HTTPS_PROXY` 装成
 * undici 的全局 dispatcher（`@deepseek-ai/dsh-http-proxy`），插件里的 `fetch`
 * 因此走该代理。实测本机 Clash：经代理返回的响应会**丢掉 `content-encoding`
 * 与 `content-type` 头，而 body 仍是 gzip**；undici 只依据 `content-encoding`
 * 决定是否解压，于是 `response.json()` 拿到 gzip 二进制并抛错，被上层的
 * catch 映射成 `invalid github response for <url>` —— 看起来像 GitHub 坏了。
 * 实测对照（同一 URL、同一代理）：默认 1331 字节解析失败，声明 identity 后
 * 5245 字节解析成功。
 *
 * 代价是不走压缩（我们的响应体都很小），换来的是**无论中间代理是否改写头部
 * 都能正确取到实体**，且用户无需为插件调整启动命令。
 */
export const NO_COMPRESSION: Record<string, string> = { 'accept-encoding': 'identity' }

/** JSON API 默认请求头（含鉴权）。 */
export function apiHeaders(): Record<string, string> {
  return { accept: 'application/vnd.github+json', ...NO_COMPRESSION, ...githubAuthHeaders() }
}

/** ETag cache for GitHub API JSON (mirrors codex lib.rs marker+fingerprint). In-memory only, saves 304 for daily checks. */
const etagCache = new Map<string, { etag: string; json: unknown }>()
const ETAG_MAX = 200
function etagCacheSet(url: string, etag: string, json: unknown): void {
  if (etagCache.size >= ETAG_MAX) {
    const first = etagCache.keys().next().value as string | undefined
    if (first !== undefined) etagCache.delete(first)
  }
  etagCache.set(url, { etag, json })
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
    throw new RepoFetchError(context + ': ' + (errorText(error)))
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
  const cached = etagCache.get(url)
  const headers: Record<string, string> = { ...apiHeaders() }
  if (cached !== undefined) headers['if-none-match'] = cached.etag
  let response: Response
  try {
    response = await fetchImpl(url, { headers })
  } catch (error) {
    throw new RepoFetchError(context + ': ' + (errorText(error)))
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
