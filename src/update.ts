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

import { spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * 已写入磁盘、但还没被宿主重启加载的版本。
 *
 * `CURRENT_VERSION` 是模块加载时读的常量 —— 点击更新换掉磁盘上的包之后，进程里
 * 仍然是旧值。不记住这个，界面上会一直写着旧版本、按钮还挂着，用户会以为没成功。
 */
let pendingRestart: string | undefined

/** The version installed on disk but not yet loaded; undefined when none. */
export function pendingRestartVersion(): string | undefined {
  return pendingRestart
}

/** Reset the pending marker (tests only). */
export function resetPendingRestart(): void {
  pendingRestart = undefined
}

/** Attach the pending-restart marker to a check result. */
function withPending(value: UpdateCheckResponse): UpdateCheckResponse {
  return pendingRestart === undefined ? value : { ...value, pendingRestartVersion: pendingRestart }
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
    return withPending({ ...cached.value, currentVersion })
  }
  const value = await probeLatest(repo, fetchImpl, currentVersion)
  cached = { at: now, value }
  return withPending(value)
}

// ---------------------------------------------------------------- 安装形态

/**
 * 插件自己是怎么落到磁盘上的。决定「点击更新」可不可做 —— 而不是让它试了才失败。
 *
 * `import.meta.url` 给的是 realpath（Node 默认解析软链），所以两种形态能分开：
 * 装在 profile 的 `node_modules` 里 → 路径里带 `/profiles/<name>/node_modules/`；
 * 被 `link:` 到开发目录 → 解析出来是项目路径，压根没有这段。
 */
export interface InstallContext {
  /** `profile` 可直接替换；`development` 必须由开发者自己重建。 */
  kind: 'profile' | 'development'
  /** profile 名，仅 `kind === 'profile'` 时存在。 */
  profileName?: string
  /** 不能自动更新的原因（给用户看的原文）。 */
  reason?: string
}

/** `…/profiles/<name>/node_modules/dsh-skill-hub/…` —— 只认这个形状。 */
const PROFILE_INSTALL = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]dsh-skill-hub[\\/]/

/**
 * Classify the running copy.
 * @param moduleUrl - entry module URL (`import.meta.url` in production).
 * @returns the install shape; `development` carries the refusal text.
 */
export function detectInstallContext(moduleUrl: string = import.meta.url): InstallContext {
  let filePath: string
  try {
    filePath = realpathSync(fileURLToPath(moduleUrl))
  } catch (error) {
    return { kind: 'development', reason: 'cannot resolve the installed package path: ' + errorText(error) }
  }
  const match = PROFILE_INSTALL.exec(filePath)
  if (match !== null) return { kind: 'profile', profileName: match[1] }
  return {
    kind: 'development',
    reason: 'this copy is linked from a working directory rather than installed into a profile — rebuild it there (npm run build), or install it with `dsh plugin add`',
  }
}

/** Outcome of one in-place update attempt. */
export interface ApplyUpdateResult {
  ok: boolean
  /** Version now on disk; null when nothing was written. */
  appliedVersion: string | null
  error?: string
}

/** How long the package manager may take before the update is abandoned. */
const APPLY_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 绕开 pnpm 的「最小发布年龄」策略。
 *
 * 用户点「立即更新」的时机，恰好是新版本刚发布、仍落在 pnpm 保护窗口里的时候 ——
 * 不豁免就会以「版本太新」失败，而这正是按钮最该工作的那一刻。
 * pnpm 12 会忽略命令行上的这个 flag，所以同时用环境变量兜一遍。
 */
const RELEASE_AGE_FLAG = '--config.minimum-release-age=0'
const PNPM_ENV = { PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0' } as const

/** dsh CLI 的启动方式。 */
export interface DshCommand {
  file: string
  args: string[]
  /** 启动目录；Electron 的 asar 入口不可 chdir，此时省略。 */
  cwd?: string
}

/** 认得出的 dsh CLI 载体：编译后的 `bin.js`、源码运行的 `bin.ts`，或 `dsh` 本体。 */
const DSH_ENTRY = /[\\/](?:bin\.(?:js|ts)|dsh)$/

/**
 * Work out how to launch the dsh CLI from inside a running dsh process.
 *
 * 不能只靠 PATH：Electron 宿主的 PATH 里通常没有 `dsh`，而它的入口可能位于
 * `app.asar`（Electron 读得到，操作系统进不去那个目录）。所以优先复用**当前进程
 * 自己的入口**：同一个 node/Electron 可执行文件 + 同样的 execArgv + 入口绝对路径。
 * 只有认不出来时才退回 PATH。
 * @returns the command to spawn.
 */
export function dshCommand(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
  execArgv: readonly string[] = process.execArgv,
): DshCommand {
  const entry = argv[1]
  if (entry !== undefined && DSH_ENTRY.test(entry)) {
    try {
      const absolute = resolve(entry)
      // asar 内部不可 chdir；正常安装时把 cwd 放在入口旁边，源码运行
      // （tsx/esm 之类）才能把 execArgv 的 import 解析出来。
      const cwd = absolute.includes('.asar' + sep) ? undefined : dirname(absolute)
      return { file: execPath, args: [...execArgv, absolute], ...(cwd !== undefined ? { cwd } : {}) }
    } catch {
      // 解析不出绝对路径就退回 PATH 分支。
    }
  }
  return { file: 'dsh', args: [] }
}

/** 结束整棵进程树：只杀直接子进程会留下仍在写 profile 的 pnpm。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // 进程组已经没了，落到单进程 kill。
    }
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run one command with a deadline, capturing both streams.
 * stdout/stderr 一定要读完再判定结果：pnpm 的错误只出现在输出里，退出码常常是 1
 * 但看不出原因。
 */
function run(command: string, args: readonly string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...PNPM_ENV },
      // 独立进程组（POSIX）：超时时一个组信号带走 dsh 包装进程和它的 pnpm 孙子，
      // 否则 pnpm 会在后台继续写 profile，和随后的重试互相踩。
      detached: process.platform !== 'win32',
      ...(cwd !== undefined ? { cwd } : {}),
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr: stderr + errorText(error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
  })
}

/** Last few lines of a command's output, for an error message a human can act on. */
function tail(text: string, lines = 6): string {
  const kept = text.trim().split('\n').filter((line) => line.trim() !== '').slice(-lines)
  return kept.join('\n')
}

/**
 * Install one exact version into the profile the running copy belongs to.
 *
 * 走 `dsh plugin` 而不是直接 `pnpm add`：那层会先做宿主自己的检查（例如 Electron
 * 独占的 profile 会直接拒绝），复用它的判断比在这里重新实现一份可靠。
 * @param version - exact `x.y.z` to install; anything else is refused.
 * @param profileName - profile that owns this copy.
 * @param runImpl - command runner (tests inject a stub).
 * @param dsh - how to launch the CLI; defaults to the current process entry.
 * @returns whether the package landed, plus the output tail on failure.
 */
export async function applyUpdate(
  version: string,
  profileName: string,
  runImpl: typeof run = run,
  dsh: DshCommand = dshCommand(),
): Promise<ApplyUpdateResult> {
  // 版本号必须是纯 x.y.z：它会被拼进参数，绝不能让调用方塞进别的开关或包名。
  if (parseVersion(version) === null) return { ok: false, appliedVersion: null, error: 'invalid version: ' + version }
  if (!/^[A-Za-z0-9._-]+$/.test(profileName)) return { ok: false, appliedVersion: null, error: 'invalid profile name: ' + profileName }
  const result = await runImpl(
    dsh.file,
    [...dsh.args, 'plugin', '--profile', profileName, 'add', RELEASE_AGE_FLAG, UPDATE_PACKAGE + '@' + version],
    APPLY_TIMEOUT_MS,
    dsh.cwd,
  )
  if (result.timedOut) {
    return { ok: false, appliedVersion: null, error: 'package manager timed out after ' + Math.round(APPLY_TIMEOUT_MS / 1000) + 's' }
  }
  if (result.code !== 0) {
    const detail = tail(result.stderr) || tail(result.stdout)
    return {
      ok: false,
      appliedVersion: null,
      error: (detail === '' ? 'dsh plugin add failed with exit code ' + String(result.code) : detail),
    }
  }
  pendingRestart = version
  // 版本可能变了（比如装上了更新的补丁版），下一轮检查要从磁盘重新读。
  cached = undefined
  return { ok: true, appliedVersion: version }
}
