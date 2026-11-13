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
 * When the response shows an exhausted GitHub rate limit, the instant it
 * resets; otherwise undefined. Shared by the repo fetch layer and the plugin's
 * own update check so both agree on what counts as a rate-limit rejection
 * (403/429 + `x-ratelimit-remaining: 0` + a parseable `x-ratelimit-reset`)
 * instead of each re-deriving it from the headers.
 */
export function rateLimitResetAt(response: Response): Date | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined
  if (response.headers.get('x-ratelimit-remaining') !== '0') return undefined
  const reset = response.headers.get('x-ratelimit-reset')
  if (reset === null) return undefined
  const at = new Date(Number(reset) * 1000)
  return Number.isNaN(at.getTime()) ? undefined : at
}

/**
 * Build a RepoFetchError; when the response shows an exhausted rate limit,
 * report the reset time instead of a bare HTTP status.
 */
export function fetchError(context: string, response: Response, fallbackStatus = 502): RepoFetchError {
  const resetAt = rateLimitResetAt(response)
  if (resetAt !== undefined) {
    return new RepoFetchError(
      'github rate limit reached (anonymous quota exhausted); retry after ' + resetAt.toLocaleTimeString() + ' or set GITHUB_TOKEN',
      403,
    )
  }
  return new RepoFetchError(context + ' (HTTP ' + response.status + ')', response.status === 404 ? 404 : fallbackStatus)
}

/** 是否限流/中断类错误（调用方可直接透出，不再包装）。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message.includes('aborted') || error.message.includes('Abort'))
}

/** Hard cap on any GitHub response body (tree payloads are the largest). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/**
 * Read a response body under a byte ceiling. Content-Length is checked first,
 * then the stream is accumulated chunk-by-chunk — a missing or forged header
 * can no longer make the process buffer an unbounded payload.
 */
export async function readBoundedResponse(response: Response, limit = MAX_RESPONSE_BYTES): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    throw new RepoFetchError('github response exceeds the ' + limit + ' byte limit')
  }
  if (response.body === null) return Buffer.from(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new RepoFetchError('github response exceeds the ' + limit + ' byte limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Parse a bounded JSON response; replaces `response.json()`, which had no cap. */
export async function readBoundedJson(response: Response): Promise<unknown> {
  const buffer = await readBoundedResponse(response)
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown
  } catch {
    throw new Error('invalid JSON in github response')
  }
}

/**
 * Hard bound on **every** outbound GitHub request. Without it a hung socket
 * leaves `/repo/import` waiting before it can return a jobId, or strands a
 * background job in `running` forever (gcImportJobs never evicts running jobs).
 */
export const REQUEST_TIMEOUT_MS = 30_000

/** Combine an optional caller signal with the per-request timeout. */
export function githubRequestSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return external !== undefined ? AbortSignal.any([external, timeout]) : timeout
}

/**
 * 传输层抖动重试：TLS 握手被重置、连接中途断开这类**瞬时**故障在代理/TUN
 * 环境下很常见（实测同一 URL 连打 5 次会有 1 次 `ECONNRESET`），一次抖动就
 * 让用户点「更新」看到红条，代价远大于多等 150ms。
 *
 * 只对**抛出的网络异常**重试，不重试任何 HTTP 状态码：4xx/5xx 是上游的确定
 * 答复（限流、404、仓库不存在），重试只会浪费配额；AbortError/TimeoutError
 * 是调用方主动取消或硬超时，更不能重试。
 */
const TRANSIENT_ATTEMPTS = 3
const TRANSIENT_BACKOFF_MS = [150, 400] as const

/** DNS/证书/URL 这类错误重试也不会变好，立即失败别拖慢批量检查。 */
function isPermanentNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = (error as Error & { cause?: unknown }).cause
  const causeText = cause instanceof Error
    ? cause.message + ' ' + String((cause as Error & { code?: unknown }).code ?? '')
    : typeof cause === 'object' && cause !== null ? String((cause as { code?: unknown }).code ?? '') : String(cause ?? '')
  return /ENOTFOUND|EAI_NONAME|ERR_INVALID_URL|Invalid URL|CERT_|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(error.message + ' ' + causeText)
}

async function sleepBeforeRetry(attempt: number): Promise<boolean> {
  const backoff = TRANSIENT_BACKOFF_MS[attempt]
  if (backoff === undefined) return false
  await new Promise((resolve) => setTimeout(resolve, backoff))
  return true
}

async function fetchWithRetry(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, context: string, signal?: AbortSignal): Promise<Response> {
  let last: unknown
  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImpl(url, { headers, signal: githubRequestSignal(signal) })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isPermanentNetworkError(error)) throw new RepoFetchError(context + ': ' + (errorText(error)))
      last = error
      if (!(await sleepBeforeRetry(attempt))) break
    }
  }
  throw new RepoFetchError(context + ': ' + (errorText(last)))
}

/**
 * 不带缓存的统一 GET+JSON：网络异常、非 2xx、坏 JSON 全部映射为
 * RepoFetchError，调用方无需重复写 try/catch。
 */
export async function fetchJson(url: string, fetchImpl: typeof fetch, context: string, headers: Record<string, string> = apiHeaders(), signal?: AbortSignal): Promise<{ json: unknown; response: Response }> {
  // A proxy can reset the connection after the headers arrived but while the
  // body is being read. That throws in response.json(), outside the fetch
  // retry above; retry the whole request so a truncated body is not reported
  // as a malformed GitHub response.
  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    const response = await fetchWithRetry(fetchImpl, url, headers, context, signal)
    if (!response.ok) throw fetchError(context, response)
    try {
      return { json: await readBoundedJson(response), response }
    } catch (error) {
      // An over-limit body is a definitive rejection, not a transient parse blip.
      if (isAbortError(error) || error instanceof RepoFetchError) throw error
      if (!(await sleepBeforeRetry(attempt))) break
      // body parse failed; loop and re-fetch the same URL
    }
  }
  throw new RepoFetchError('invalid github response for ' + url)
}

/**
 * Load one JSON document from the GitHub API, reusing an ETag when the URL was
 * fetched before. `fetchImpl`/`context` exist so callers can stub the transport
 * and shape the error text; the payload is whatever the endpoint returned.
 */
export async function fetchJsonCached(url: string, fetchImpl: typeof fetch, context: string, signal?: AbortSignal): Promise<{ json: unknown; response: Response }> {
  const cached = etagCache.get(url)
  const headers: Record<string, string> = { ...apiHeaders() }
  if (cached !== undefined) headers['if-none-match'] = cached.etag
  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    const response = await fetchWithRetry(fetchImpl, url, headers, context, signal)
    if (response.status === 304 && cached !== undefined) {
      // Return cached JSON with a synthetic 200-like response for error mapping.
      return { json: cached.json, response }
    }
    if (!response.ok) throw fetchError(context, response)
    let json: unknown
    try {
      json = await readBoundedJson(response)
    } catch (error) {
      // An over-limit body is a definitive rejection, not a transient parse blip.
      if (isAbortError(error) || error instanceof RepoFetchError) throw error
      if (!(await sleepBeforeRetry(attempt))) break
      // 响应体读取阶段断流：重发请求，而不是把截断的 body 当坏 JSON。
      continue
    }
    const etag = response.headers.get('etag')
    if (etag !== null && etag !== '') etagCacheSet(url, etag, json)
    return { json, response }
  }
  throw new RepoFetchError('invalid github response for ' + url)
}
