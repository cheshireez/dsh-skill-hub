/**
 * skills.sh 搜索索引的只读客户端。
 *
 * skills.sh 不是仓库，而是一份「owner/repo + skillId」的索引：它只告诉
 * 我们某个技能住在哪个 GitHub 仓库里，真正的安装仍然走仓库发现与导入。
 * 所以这里只做一件事 —— 把搜索词变成一份经过校验的候选列表。
 *
 * 三条约束：
 * 1. **服务端代理，不前端直连**。上游没有 CORS 头（浏览器直连必被拦），
 *    而且为了搜一次技能就把用户的出口 IP 暴露给第三方没有必要。
 * 2. **字段白名单 + 形态校验**。`source` 会被拼进 `https://github.com/…`，
 *    一个 `..` 或 `@evil.com` 就能把链接指向别处；只放行严格的 owner/repo。
 * 3. **有界**。查询词长度、响应字节、结果条数都有上限 —— 这是一个我们
 *    控制不了的外部服务，它返回多大的东西不该决定我们占用多少内存。
 */

const SEARCH_URL = 'https://skills.sh/api/search'
const DOWNLOAD_URL = 'https://skills.sh/api/download'
/** 上游要求至少 2 个字符（少于此直接回 error JSON）。 */
const MIN_QUERY_CHARS = 2
const MAX_QUERY_CHARS = 100
const MAX_RESPONSE_BYTES = 1 << 20
const MAX_RESULTS = 50
const TIMEOUT_MS = 10_000
/** 单技能包的体积与文件数上限（与内容审计的单技能上限一致）。 */
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024
const MAX_PACKAGE_FILE_BYTES = 2 * 1024 * 1024
const MAX_PACKAGE_FILES = 500
/** 单段标识符：首字符必须是字母或数字，所以 `..` / `@` / 空段天然出局。 */
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** 包内相对路径：不得绝对、不得含 `..` 段。 */
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/

/** 一条可安装的候选。`source` 可直接喂给市场源的 `owner/repo` 入参。 */
export interface SkillsShSkill {
  /** 上游 id，形如 `owner/repo/skillId`；去重键。 */
  id: string
  /** `owner/repo`。 */
  source: string
  /** 技能在仓库里的目录名。 */
  skillId: string
  name: string
  /** 上游统计的安装次数；缺失或非法时省略。 */
  installs?: number
}

/** 搜索失败。`status` 直接用作 HTTP 状态：400 = 入参问题，502 = 上游问题。 */
export class SkillsShError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SkillsShError'
  }
}

/** 只保留严格 owner/repo，其余一律丢弃（它会被当成 GitHub 路径用）。 */
function repoSlugOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.split('/')
  if (parts.length !== 2) return undefined
  if (!parts.every((part) => IDENTIFIER_RE.test(part))) return undefined
  return value
}

function identifierOf(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER_RE.test(value) ? value : undefined
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text !== '' && text.length <= maxLength ? text : undefined
}

/**
 * 边读边计上限。Content-Length 只是声明值，可以缺失也可以撒谎，
 * 所以真正的约束在流里，而不是头部。
 */
async function readBounded(response: Response, limit = MAX_RESPONSE_BYTES): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new SkillsShError('skills.sh response is too large', 502)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

/**
 * 在 skills.sh 里搜技能。
 * @param query - 用户输入的搜索词。
 * @param fetchImpl - 注入点（测试用）。
 * @returns 校验过的候选，最多 `MAX_RESULTS` 条，按上游给的相关度顺序。
 */
export async function searchSkillsSh(query: string, fetchImpl: typeof fetch = fetch): Promise<SkillsShSkill[]> {
  const normalized = query.trim()
  if (normalized.length < MIN_QUERY_CHARS) throw new SkillsShError(`query must be at least ${MIN_QUERY_CHARS} characters`, 400)
  if (normalized.length > MAX_QUERY_CHARS) throw new SkillsShError(`query must be at most ${MAX_QUERY_CHARS} characters`, 400)

  const url = new URL(SEARCH_URL)
  url.searchParams.set('q', normalized)

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        // 与 GitHub 请求同一个理由：代理链可能丢掉 content-encoding 却仍给
        // 压缩体，解析会失败。要求明文，代价是几 KB。
        'accept-encoding': 'identity',
      },
      // 不让上游把我们重定向到别的主机：这是一次纯 JSON 请求，重定向没有正当用途。
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new SkillsShError('skills.sh is unreachable', 502)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new SkillsShError(`skills.sh answered HTTP ${String(response.status)}`, 502)
  }

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new SkillsShError('skills.sh response is too large', 502)
  }

  let payload: unknown
  try {
    payload = JSON.parse((await readBounded(response)).toString('utf8'))
  } catch (error) {
    if (error instanceof SkillsShError) throw error
    throw new SkillsShError('skills.sh returned invalid JSON', 502)
  }
  if (typeof payload !== 'object' || payload === null) throw new SkillsShError('skills.sh returned an unexpected payload', 502)
  const list = (payload as { skills?: unknown }).skills
  if (!Array.isArray(list)) throw new SkillsShError('skills.sh returned an unexpected payload', 502)

  const skills: SkillsShSkill[] = []
  const seen = new Set<string>()
  for (const candidate of list) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const source = repoSlugOf(record.source)
    const skillId = identifierOf(record.skillId)
    const name = boundedString(record.name, 256)
    if (source === undefined || skillId === undefined || name === undefined) continue
    const id = boundedString(record.id, 768) ?? source + '/' + skillId
    if (seen.has(id)) continue
    seen.add(id)
    const installs = record.installs
    skills.push({
      id,
      source,
      skillId,
      name,
      ...(typeof installs === 'number' && Number.isSafeInteger(installs) && installs >= 0 ? { installs } : {}),
    })
    if (skills.length >= MAX_RESULTS) break
  }
  return skills
}

/** 一个待安装的包内文件（路径已规范化）。 */
export interface SkillsShPackageFile {
  path: string
  data: Buffer
}

export interface SkillsShPackage {
  /** 上游标识 `owner/repo/skillId`，用于展示与错误信息。 */
  origin: string
  files: SkillsShPackageFile[]
}

/**
 * 下载单个技能的内容。
 *
 * 这是「只想要这一个技能」的路径：不经仓库扫描、不落 commit 快照，换来
 * 一步到位。代价说清楚 —— 直装出来的技能没有仓库内路径（上游只给 skillId，
 * 不给它在仓库里的目录前缀），因此**无法登记为来源记录**，后续不能检查上游
 * 更新。要跟随上游请走「加为源」。
 *
 * 上游返回 `{files: [{path, contents}]}`，contents 是文本。路径同样要校验：
 * 这些字符串会直接变成落盘路径。
 * @param source - `owner/repo`。
 * @param skillId - 技能在该仓库里的目录名。
 * @param fetchImpl - 注入点（测试用）。
 */
export async function downloadSkillsShSkill(source: string, skillId: string, fetchImpl: typeof fetch = fetch): Promise<SkillsShPackage> {
  const repo = repoSlugOf(source)
  const id = identifierOf(skillId)
  if (repo === undefined) throw new SkillsShError('source must be a strict owner/repo', 400)
  if (id === undefined) throw new SkillsShError('skillId is not a valid identifier', 400)

  const [owner, name] = repo.split('/') as [string, string]
  const url = DOWNLOAD_URL + '/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/' + encodeURIComponent(id)

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new SkillsShError('skills.sh is unreachable', 502)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    // 404 是「这个技能没了」，其余都是上游故障 —— 前者该让用户换个结果，后者该重试。
    throw new SkillsShError(`skills.sh answered HTTP ${String(response.status)}`, response.status === 404 ? 404 : 502)
  }

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES * 2) {
    await response.body?.cancel().catch(() => undefined)
    throw new SkillsShError('skill package is too large', 502)
  }

  let payload: unknown
  try {
    // 响应是 JSON，字符串转义会让体积比实际内容大；上限留两倍余量。
    payload = JSON.parse((await readBounded(response, MAX_PACKAGE_BYTES * 2)).toString('utf8'))
  } catch (error) {
    if (error instanceof SkillsShError) throw error
    throw new SkillsShError('skills.sh returned invalid JSON', 502)
  }
  const list = typeof payload === 'object' && payload !== null ? (payload as { files?: unknown }).files : undefined
  if (!Array.isArray(list)) throw new SkillsShError('skills.sh returned an unexpected payload', 502)
  if (list.length === 0 || list.length > MAX_PACKAGE_FILES) throw new SkillsShError('skill package has an unsupported file count', 502)

  const files: SkillsShPackageFile[] = []
  let total = 0
  for (const item of list) {
    if (typeof item !== 'object' || item === null) throw new SkillsShError('skills.sh returned an invalid file entry', 502)
    const record = item as Record<string, unknown>
    // 反斜杠先统一：Windows 风格的 `..\..\x` 会绕过所有按 `/` 做的检查。
    const path = typeof record.path === 'string' ? record.path.replace(/\\/g, '/') : ''
    if (path === '' || !SAFE_PATH_RE.test(path)) throw new SkillsShError('skill package contains an unsafe path: ' + String(record.path), 502)
    if (typeof record.contents !== 'string') throw new SkillsShError('skill package file ' + path + ' has no text contents', 502)
    const data = Buffer.from(record.contents, 'utf8')
    if (data.length > MAX_PACKAGE_FILE_BYTES) throw new SkillsShError(path + ' is over the per-file limit', 502)
    total += data.length
    if (total > MAX_PACKAGE_BYTES) throw new SkillsShError('skill package is over the total size limit', 502)
    files.push({ path, data })
  }
  if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) throw new SkillsShError('skill package has no SKILL.md', 502)
  return { origin: repo + '/' + id, files }
}
