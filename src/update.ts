/**
 * Self-update check for dsh-skill-hub.
 *
 * 数据源以 **npm registry** 为准，GitHub release 降为兜底。三个理由：
 *
 * - `dist-tags.latest` 就是用户 `pnpm add dsh-skill-hub` 会装到的版本，也是发版
 *   链路的终点；GitHub release 是另一次独立动作（`npm publish` + `gh release
 *   create`），两者可能不同步 —— 发了包但没建 release 时，只查 GitHub 会答
 *   「暂无可用的发布版本」，用户看到的是假阴性。
 * - npm 没有匿名限流；GitHub API 是 60 次/小时，共享出口 IP 很容易打满。
 * - 一次请求就够：`releases/tag/v<version>` 是稳定命名，不必再向 GitHub 要 URL。
 *
 * 依赖仍是零新增：Node 全局 fetch + 一个 semver 子集解析器（本项目只发 x.y.z）。
 */

import { createRequire } from 'node:module'
import { errorText } from './error-text.ts'
import { apiHeaders, rateLimitResetAt } from './repo.ts'
import type { UpdateCheckResponse } from './protocol.ts'

/** Repository checked for releases. Keep in sync with package.json. */
export const UPDATE_REPO = 'cheshireez/dsh-skill-hub'

/** npm package name (the artifact users actually install). */
export const UPDATE_PACKAGE = 'dsh-skill-hub'

/** Registry endpoint that answers the `latest` dist-tag. */
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/' + UPDATE_PACKAGE + '/latest'

/**
 * How long one result stays fresh.
 *
 * 检查本身是低频动作，但触发点不止一处：设置卡片挂载时会查一次，面板的「⋯ →
 * 检查更新」还能被反复点。没有缓存的话，光打开设置页 + 点两下菜单就是三次出网，
 * 而 GitHub 匿名额度是 60 次/小时。10 分钟足够覆盖「改完配置顺手看一眼」的节奏，
 * 又不会让刚发布的版本等太久才被发现。
 */
const CACHE_TTL_MS = 10 * 60 * 1000

let cached: { at: number; value: UpdateCheckResponse } | undefined

/** Drop the cached result: `?refresh=1` and the tests both need a clean slate. */
export function resetUpdateCache(): void {
  cached = undefined
}

/** Installed plugin version, read from the package manifest. */
const require = createRequire(import.meta.url)
export const CURRENT_VERSION = (require('../package.json') as { version: string }).version

/** Normalize a release tag (`v1.2.3` → `1.2.3`) and parse it numerically. */
export function parseVersion(tag: string): [number, number, number] | null {
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two dotted version strings: negative when a < b, 0 equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a.localeCompare(b, 'en')
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/** True when latest is strictly newer than current. */
export function isUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  return compareVersions(latestVersion, currentVersion) > 0
}

/** Release page for a published version; the tag naming is our own convention. */
function releaseUrl(repo: string, version: string): string {
  return 'https://github.com/' + repo + '/releases/tag/v' + version
}

/** Options shared by the public entry point. */
export interface UpdateCheckOptions {
  /** Ignore the cached result and hit the network (`?refresh=1`). */
  refresh?: boolean
  /** Clock override, so a test can age the cache without sleeping. */
  now?: number
}

/**
 * Resolve `dist-tags.latest` from the registry.
 * @returns the published version, or null when the registry is unreachable or
 * the tag is not a plain `x.y.z`.
 */
async function checkRegistry(fetchImpl: typeof fetch): Promise<string | null> {
  let response: Response
  try {
    response = await fetchImpl(REGISTRY_LATEST_URL, {
      // `accept-encoding: identity` 与 GitHub 走同一条规矩：代理会丢掉
      // `content-encoding` 而 body 仍是 gzip，声明不需要压缩就绕开这条链路。
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return null
  }
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  // 预发布版本（0.4.0-rc.1）不在这里比较：本项目对外只发 x.y.z，遇到别的
  // 形态就交给 GitHub 兜底，而不是拿一个比不了的东西去比。
  return parseVersion(version) === null ? null : version
}

/**
 * Best-effort GitHub latest-release lookup (fallback path).
 * Always resolves with ok:true.
 */
async function checkGithubRelease(repo: string, fetchImpl: typeof fetch, currentVersion: string): Promise<UpdateCheckResponse> {
  /** 统一失败形状：查询失败不抛错，一律 ok:true + error 文案（调用方只看 error）。 */
  const failure = (error: string): UpdateCheckResponse => ({ ok: true, currentVersion, latestVersion: null, updateAvailable: false, url: null, source: 'github', error })
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  let response: Response
  try {
    response = await fetchImpl(url, {
      // apiHeaders() 而非手写等价物：它带上 `accept-encoding: identity`，
      // 缺了它在「启动环境带代理」时响应会变成解不开的 gzip（见 github-client.ts）。
      headers: apiHeaders(),
    })
  } catch (error) {
    return failure(errorText(error))
  }

  if (response.status === 404) return failure('no release published yet')

  if (!response.ok) {
    // Rate-limit exhaustion gets a friendlier message with the reset time.
    // The header parsing lives in github-client so the repo layer and this
    // check can never disagree on what counts as exhaustion.
    const resetAt = rateLimitResetAt(response)
    if (resetAt !== undefined) {
      return failure('github rate limit reached; retry after ' + resetAt.toLocaleTimeString() + ' or set GITHUB_TOKEN')
    }
    return failure('GitHub HTTP ' + response.status)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'invalid GitHub response')
  }

  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const rawTag = typeof record.tag_name === 'string' ? record.tag_name.trim() : ''
  const parsed = parseVersion(rawTag)
  if (parsed === null) {
    return {
      ok: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      url: null,
      source: 'github',
      error: 'unsupported release tag: ' + (rawTag || 'missing'),
    }
  }

  const latestVersion = `${parsed[0]}.${parsed[1]}.${parsed[2]}`
  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable: isUpdateAvailable(currentVersion, latestVersion),
    url: typeof record.html_url === 'string' ? record.html_url : releaseUrl(repo, latestVersion),
    source: 'github',
  }
}

/** One uncached probe: registry first, GitHub release as the fallback. */
async function probeLatest(repo: string, fetchImpl: typeof fetch, currentVersion: string): Promise<UpdateCheckResponse> {
  const version = await checkRegistry(fetchImpl)
  if (version !== null) {
    return {
      ok: true,
      currentVersion,
      latestVersion: version,
      updateAvailable: isUpdateAvailable(currentVersion, version),
      url: releaseUrl(repo, version),
      source: 'npm',
    }
  }
  return checkGithubRelease(repo, fetchImpl, currentVersion)
}

/**
 * Check the plugin's own latest published version.
 *
 * 结果缓存 10 分钟；`options.refresh` 绕过缓存。查询失败一律 `ok:true` +
 * `error` 文案 —— 更新检查失败不该让调用方把它当成接口错误。
 * @param repo - repository whose release page is linked.
 * @param fetchImpl - fetch implementation (tests inject a stub).
 * @param options - cache control.
 * @returns the comparison result.
 */
export async function checkLatestRelease(
  repo = UPDATE_REPO,
  fetchImpl: typeof fetch = fetch,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResponse> {
  const currentVersion = CURRENT_VERSION
  const now = options.now ?? Date.now()
  if (options.refresh !== true && cached !== undefined && now - cached.at < CACHE_TTL_MS) {
    // currentVersion 覆盖一次：缓存不该让「升级后重启」仍然报旧版本号。
    return { ...cached.value, currentVersion }
  }
  const value = await probeLatest(repo, fetchImpl, currentVersion)
  cached = { at: now, value }
  return value
}
