/**
 * The /api/skill-hub route family: full catalog (enabled skills from the
 * official registry + hub-disabled skills + discovery diagnostics), skill
 * detail, enable/disable toggle, new-skill scaffold, user groups (tags +
 * origin collections), and upstream source tracking (check/sync/follow
 * upstream deletion into a restorable trash). Every route carries a
 * loopback-only trust fence — these endpoints rename files under the user's
 * skill roots, so LAN-exposed dsh web deployments must not serve them.
 *
 * Every handler is declared through the local `route()` wrapper, which owns
 * the shared request fences (loopback trust, HTTP method, master switch,
 * JSON body) exactly once, so a new route cannot forget them.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { randomUUID } from 'node:crypto'
import {
  cleanupLeftoverImportDirs,
  collectRepoSkillFiles,
  diffRemoteSkills,
  discoverRepoEntries,
  downloadRepoSkill,
  getLatestCommit,
  getLatestReleaseTag,
  isAbortError,
  listRepoBranches,
  listRepoReleases,
  loadRepoTree,
  loadRepoTreeAt,
  normalizeRepoInput,
  repoSkillEntry,
  repoSlug,
  RepoFetchError,
  skillDirOf,
  skillManifest,
} from './repo.ts'
import {
  SKILL_HUB_API,
  type CatalogResponse,
  type RepoImportCancelRequest,
  type RepoImportCancelResponse,
  type RepoImportProgressResponse,
  type RepoImportRequest,
  type RepoImportResponse,
  type CatalogSkill,
  type CollectionGroup,
  type ConfigResponse,
  type CreateResponse,
  type RepoDiscoverResponse,
  type CreateRequest,
  type ErrorResponse,
  type GroupsResponse,
  type HubConfig,
  type MarketCheckResponse,
  type MarketSourceRefRequest,
  type MarketSourceRequest,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type MarketSourceVersionsResponse,
  type MarketSyncResponse,
  type SourceCheckRequest,
  type SourceCheckResponse,
  type SourceCheckResult,
  type SourceDeleteRequest,
  type SourceDeleteResponse,
  type SourceRestoreRequest,
  type SourceRestoreResponse,
  type SourceTrashClearResponse,
  type SourcesResponse,
  type SourceSyncRequest,
  type SourceSyncResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type SkillDeleteRequest,
  type SkillDeleteResponse,
  type TagDeleteRequest,
  type TagDeleteResponse,
  type TagMembersRequest,
  type TagMembersResponse,
  type TagReorderRequest,
  type TagReorderResponse,
  type CollectionReorderRequest,
  type CollectionReorderResponse,
  type SourceGroupReorderRequest,
  type SourceGroupReorderResponse,
  type TagSaveRequest,
  type TagSaveResponse,
  type DiagnosticFixRequest,
  type DiagnosticFixResponse,
  type ToggleBatchRequest,
  type ToggleBatchResponse,
  type ToggleRequest,
  type ToggleResponse,
  type WritableRoot,
  HEX_COLOR_RE,
  isProjectSource,
  resolveHubConfig,
} from './protocol.ts'
import { clearTrash, createSkill, disableSkill, enableSkill, fixDiagnosticFile, parseFrontmatter, readSkillInterface, restoreSkill, rootOfPath, rootPath, scanDiagnostics, trashSkill } from './skillfs.ts'
import { checkLatestRelease, CURRENT_VERSION } from './update.ts'
import { dshHome, StoreError, type SkillHubStore } from './store.ts'
import type { SkillStatsReader } from './stats.ts'

/** Cap on JSON request bodies (toggle/create payloads are tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Minimum interval between network update checks per source (GitHub rate limits). */
const MIN_CHECK_INTERVAL_MS = 5 * 60_000

/** Loopback literal check plus browser same-origin markers. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** One JSON error response. */
function writeError(res: ServerResponse, status: number, error: unknown): void {
  const body: ErrorResponse = { error: error instanceof Error ? error.message : String(error) }
  writeJson(res, status, body)
}

/** HTTP status per store business-rule kind (user error, not server fault). */
const STORE_ERROR_STATUS = { validation: 400, 'not-found': 404, conflict: 409 } as const

/** Map known error types onto HTTP statuses: repo fetch + store business rules. */
function writeRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof RepoFetchError) {
    writeError(res, error.status, error)
    return
  }
  if (error instanceof StoreError) {
    writeError(res, STORE_ERROR_STATUS[error.kind], error)
    return
  }
  writeError(res, 500, error)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Async existence check (import/sync use it on the user root). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Sources the hub may toggle (the user-level filesystem roots). */
function isWritableSource(source: string): source is WritableRoot {
  return source === 'user-dsh' || source === 'user-agents'
}

/** Lookup options the hub forwards to the registry (cwd selects project roots). */
export interface SkillLookupLike {
  cwd?: string
}

/** Route family dependencies (narrow structural view of ctx.skills for tests). */
export interface SkillHubRouteDeps {
  skills: {
    snapshot(options?: SkillLookupLike): Promise<{ skills: SkillSummary[]; complete: boolean }>
    get(name: string, options?: SkillLookupLike): Promise<SkillDefinition | undefined>
  }
  store: SkillHubStore
  /** DSH home override (tests isolate the writable roots; defaults to ~/.dsh). */
  home?: string
  /** Invalidate the registry catalog cache after hub-driven mutations. */
  invalidate?: () => void
  /** Optional invocation-count reader; absent means the stats route reports unavailable. */
  stats?: SkillStatsReader
  /** Resolves the current plugin config; business routes honour the master switch. */
  config?: () => HubConfig
  /** Resolves the raw saved config layer (fields the user explicitly overrode). */
  saved?: () => Partial<HubConfig>
  /** Persist a config patch and re-sync plugin surfaces; resolves with the fresh config. */
  updateConfig?: (patch: Partial<HubConfig>) => Promise<HubConfig>
}

/** The resolved hub config a route sees (the shared resolver fills defaults). */
function configOf(deps: SkillHubRouteDeps): HubConfig {
  return resolveHubConfig({}, deps.config?.() ?? {})
}

/** The raw saved config layer a route reports (empty when the owner omits it). */
function savedOf(deps: SkillHubRouteDeps): Partial<HubConfig> {
  return deps.saved?.() ?? {}
}

/** Refuse business routes while the master switch is off (the config route stays up). */
function disabledGate(deps: SkillHubRouteDeps, res: ServerResponse): boolean {
  if (configOf(deps).enabled) return false
  writeError(res, 503, 'plugin disabled: enable it from the settings card')
  return true
}

/** Resolve the home used for writable-root operations. */
function homeOf(deps: SkillHubRouteDeps): string {
  return deps.home ?? dshHome()
}

/** A skill resolved as a hub-writable user-level file. */
interface WritableSkill {
  skill: SkillDefinition
  /** Absolute discovery-file path (guaranteed present by the resolver). */
  path: string
  /** The writable root containing the file. */
  root: WritableRoot
}

/** A refusal with the exact HTTP error the caller should answer with. */
interface WritableSkillRefusal {
  status: number
  error: string
}

type WritableSkillResult = { ok: true } & WritableSkill | { ok: false } & WritableSkillRefusal

/**
 * Resolve a skill by name as something the hub may write, or the exact
 * refusal the caller should answer with. Owns the guard sequence shared by
 * toggle, toggle-batch, and skill/delete: registry lookup, writable source,
 * writable file, and path containment inside a user root.
 */
async function resolveWritableSkill(deps: SkillHubRouteDeps, name: string, cwd?: string): Promise<WritableSkillResult> {
  const lookup = cwd !== undefined && cwd !== '' ? { cwd } : undefined
  const skill = await deps.skills.get(name, lookup)
  if (skill === undefined) return { ok: false, status: 404, error: 'skill not found: ' + name }
  if (!isWritableSource(skill.source)) {
    return { ok: false, status: 409, error: 'source "' + skill.source + '" is managed outside the hub (read-only)' }
  }
  if (skill.path === undefined) return { ok: false, status: 409, error: 'provider-managed skill has no writable file' }
  const root = rootOfPath(skill.path, homeOf(deps))
  if (root === undefined) return { ok: false, status: 409, error: 'skill path is outside the hub writable roots' }
  return { ok: true, skill, path: skill.path, root }
}

/** 系统集合组 + 用户 tag + origin 映射（groups 路由的数据源）。 */
async function buildGroups(deps: SkillHubRouteDeps): Promise<GroupsResponse> {
  const [tags, origins, collectionOrder, sourceGroupOrder] = await Promise.all([deps.store.listTags(), deps.store.listOrigins(), deps.store.getCollectionOrder(), deps.store.getSourceGroupOrder()])
  const byCollection = new Map<string, string[]>()
  for (const [skillName, origin] of Object.entries(origins)) {
    const list = byCollection.get(origin)
    if (list === undefined) byCollection.set(origin, [skillName])
    else list.push(skillName)
  }
  const orderIndex = new Map(collectionOrder.map((name, i) => [name, i] as const))
  const collections: CollectionGroup[] = [...byCollection.entries()]
    .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => {
      const ai = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Infinity
      const bi = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Infinity
      if (ai !== bi) return ai - bi
      return a.name.localeCompare(b.name)
    })
  return { ok: true, tags, collections, origins, ...(sourceGroupOrder.length > 0 ? { sourceGroupOrder } : {}), ...(collectionOrder.length > 0 ? { collectionOrder } : {}) }
}

/** 目录中存在的技能名集合（tag 成员校验用）：启用目录 ∪ 已禁用名单，避免成员因禁用而丢失。 */
async function knownSkillNames(deps: SkillHubRouteDeps): Promise<Set<string>> {
  const snapshot = await deps.skills.snapshot()
  const names = new Set(snapshot.skills.map((skill) => skill.name))
  for (const disabled of await deps.store.listDisabled()) names.add(disabled.name)
  return names
}

/** 已知工作区条目（dsh 的 workspace.json 表）。 */
interface WorkspaceEntry {
  path: string
  title: string
}

/**
 * 读取 dsh 的已知工作区清单（~/.dsh/storages/workspace.json 的
 * tables.workspaces 表）。面板默认视图据此合并所有工作区的项目技能；
 * 文件缺失/损坏时返回空清单（回退为仅用户级视图）。
 */
async function workspaceEntries(home: string): Promise<WorkspaceEntry[]> {
  try {
    const raw = await readFile(join(home, 'storages', 'workspace.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const tables = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).tables as Record<string, unknown> | undefined
      : undefined
    const workspaces = tables !== undefined && typeof tables === 'object'
      ? (tables as Record<string, unknown>).workspaces as Record<string, unknown> | undefined
      : undefined
    const entries: WorkspaceEntry[] = []
    if (workspaces !== undefined && typeof workspaces === 'object') {
      for (const record of Object.values(workspaces)) {
        const entry = record as { path?: unknown; title?: unknown } | null
        if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && entry.path !== '') {
          entries.push({
            path: entry.path,
            title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.path,
          })
        }
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Build the full catalog response (shared by catalog/toggle/create handlers).
 * 显式 cwd 只看该工作区；否则合并所有已知工作区（workspace.json）的项目技能
 * + 用户级技能，同名技能先到先得；没有任何工作区时回退为仅用户级视图。
 */
async function buildCatalog(deps: SkillHubRouteDeps, cwd?: string): Promise<CatalogResponse> {
  const home = homeOf(deps)
  let workspaces: WorkspaceEntry[]
  if (cwd !== undefined && cwd !== '') {
    workspaces = [{ path: cwd, title: cwd }]
  } else {
    workspaces = await workspaceEntries(home)
    if (workspaces.length === 0) workspaces = [{ path: '', title: '' }]
  }
  // Project skills with same name but different workspace are distinct entries (grouped by workspace in SourcesView), so key includes workspace for project sources.
  const byKey = new Map<string, { skill: SkillSummary; workspace?: string; workspaceTitle?: string }>()
  // Distinct identities per logical key: the same skill reappearing across
  // workspace snapshots (same source+provider) is one skill, not a duplicate.
  // Only different source/provider identities sharing a name are ambiguous.
  const identitiesByKey = new Map<string, Set<string>>()
  let complete = true
  for (const ws of workspaces) {
    const lookup = ws.path !== '' ? { cwd: ws.path } : undefined
    const snapshot = await deps.skills.snapshot(lookup)
    if (!snapshot.complete) complete = false
    for (const skill of snapshot.skills) {
      const logicalKey = isProjectSource(skill.source) && ws.path !== '' ? `${skill.name}\0${ws.path}\0${skill.source}` : skill.name
      let identities = identitiesByKey.get(logicalKey)
      if (identities === undefined) {
        identities = new Set()
        identitiesByKey.set(logicalKey, identities)
      }
      identities.add(skill.source + '\0' + skill.provider)
      if (byKey.has(logicalKey)) continue
      byKey.set(logicalKey, {
        skill,
        ...(isProjectSource(skill.source) && ws.path !== '' ? { workspace: ws.path, workspaceTitle: ws.title } : {}),
      })
    }
  }
  const disabled = await deps.store.listDisabled()
  const byName = byKey
  // A hub-disabled record whose name is also enabled elsewhere hides one
  // identity behind the toggle; flag it as well.
  for (const d of disabled) {
    let identities = identitiesByKey.get(d.name)
    if (identities === undefined) {
      identities = new Set()
      identitiesByKey.set(d.name, identities)
    }
    identities.add('hub-disabled\0' + d.root)
  }
  const duplicateNames = [...identitiesByKey.entries()]
    .filter(([, identities]) => identities.size > 1)
    .map(([key]) => key.split('\0')[0])
    .filter((name, idx, arr) => arr.indexOf(name) === idx)
    .sort((a, b) => a.localeCompare(b))
  // 添加/更新时间 = 用户级技能文件的创建/修改时间（排序与详情展示用）。
  // snapshot 只给 SkillSummary（无 path），所以按可写根推断路径；非用户级
  // 来源没有稳定路径，省略字段，客户端排序会把它放到末尾。
  // 全部技能并发收集（面板每 5 秒轮询一次，逐个串行 stat 会让响应随技能
  // 数量线性变慢）。
  const timesByName = new Map<string, { addedAt: number; updatedAt: number }>()
  await Promise.all([...byName.values()].map(async ({ skill }) => {
    if (!isWritableSource(skill.source)) return
    const base = rootPath(skill.source as WritableRoot, home)
    for (const candidate of [join(base, skill.name, 'SKILL.md'), join(base, skill.name), join(base, skill.name + '.md')]) {
      try {
        const times = await stat(candidate)
        timesByName.set(skill.name, { addedAt: times.birthtimeMs, updatedAt: times.mtimeMs })
        return
      } catch {
        // 目录/文件不存在则尝试下一个候选路径。
      }
    }
  }))
  // UI metadata from agents/openai.yaml (codex SkillInterface) — best-effort, no error if missing.
  const interfaceByName = new Map<string, { displayName?: string; shortDescription?: string; brandColor?: string; iconSmall?: string; iconLarge?: string; defaultPrompt?: string }>()
  await Promise.all([...byName.values()].map(async ({ skill, workspace }) => {
    const candidates: string[] = []
    if (isWritableSource(skill.source as WritableRoot)) {
      candidates.push(join(rootPath(skill.source as WritableRoot, home), skill.name))
    } else if (isProjectSource(skill.source) && workspace !== undefined) {
      candidates.push(join(workspace, skill.source === 'project-dsh' ? '.dsh/skills' : '.agents/skills', skill.name))
    } else if (isProjectSource(skill.source)) {
      for (const ws of workspaces) if (ws.path !== '') candidates.push(join(ws.path, skill.source === 'project-dsh' ? '.dsh/skills' : '.agents/skills', skill.name))
    }
    for (const dir of candidates) {
      try {
        const iface = await readSkillInterface(dir)
        if (iface !== undefined) {
          interfaceByName.set(skill.name, iface)
          return
        }
      } catch {
        // ignore
      }
    }
  }))
  const skills: CatalogSkill[] = [...byName.values()].map(({ skill, workspace, workspaceTitle }) => {
    const row: CatalogSkill = {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: {
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
      },
      provider: skill.provider,
      writable: isWritableSource(skill.source),
      source: skill.source,
      ...(workspace !== undefined ? { workspace, workspaceTitle: workspaceTitle ?? workspace } : {}),
    }
    const times = timesByName.get(skill.name)
    if (times !== undefined) {
      row.addedAt = times.addedAt
      row.updatedAt = times.updatedAt
    }
    const iface = interfaceByName.get(skill.name)
    if (iface !== undefined) {
      if (iface.displayName !== undefined) row.displayName = iface.displayName
      if (iface.shortDescription !== undefined) row.shortDescription = iface.shortDescription
      if (iface.brandColor !== undefined) row.brandColor = iface.brandColor
      if (iface.iconSmall !== undefined) row.iconSmall = iface.iconSmall
      if (iface.iconLarge !== undefined) row.iconLarge = iface.iconLarge
      if (iface.defaultPrompt !== undefined) row.defaultPrompt = iface.defaultPrompt
    }
    return row
  })
  const diagnostics = [
    ...(await scanDiagnostics('user-dsh', home)),
    ...(await scanDiagnostics('user-agents', home)),
  ]
  return {
    ok: true,
    pluginVersion: CURRENT_VERSION,
    complete,
    skills,
    disabled,
    diagnostics,
    ...(duplicateNames.length > 0 ? { duplicateNames } : {}),
  }
}

/** Map a loaded definition onto the wire shape. */
function toDetail(skill: SkillDefinition): SkillDetail {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    invocation: {
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    },
    provider: skill.provider,
    ...(skill.path !== undefined ? { path: skill.path } : {}),
    content: skill.content,
  }
}

/** Last successful check time per repo (in-memory throttle for GitHub rate limits). */
const lastSourceCheck = new Map<string, number>()
/** Last successful market update check per repo (same throttle). */
const lastMarketCheck = new Map<string, number>()

/** Async import job (B方案：jobId + 轮询，选项2后台继续) */
interface ImportJob {
  jobId: string
  repo: string
  ref: string
  total: number
  done: number
  current?: string
  currentFile?: string
  totalBytes: number
  downloadedBytes: number
  startTime: number
  imported: Array<{ name: string; origin: string; path: string }>
  skipped: Array<{ name: string; reason: 'exists' }>
  failed: Array<{ name: string; error: string }>
  status: 'running' | 'done' | 'cancelled' | 'error'
  error?: string
  controller: AbortController
  createdAt: number
}
const importJobs = new Map<string, ImportJob>()
const IMPORT_JOB_TTL_MS = 5 * 60_000
const IMPORT_JOB_MAX = 100
function gcImportJobs(): void {
  if (importJobs.size > 500) importJobs.clear()
  const now = Date.now()
  for (const [id, job] of importJobs) {
    if (job.status !== 'running' && now - job.createdAt > IMPORT_JOB_TTL_MS) importJobs.delete(id)
  }
  if (importJobs.size > IMPORT_JOB_MAX) {
    const sorted = [...importJobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (let i = 0; i < sorted.length - IMPORT_JOB_MAX; i++) importJobs.delete(sorted[i][0])
  }
}

/** Replace one skill directory with a fresh download; restores the old dir on failure. */
async function replaceSkillDir(targetDir: string, download: () => Promise<void>): Promise<void> {
  // 点前缀：发现扫描跳过点开头的目录（与导入临时目录 .<name>.import- 同一
  // 约定），备份即使删除失败残留下来，也不会混进目录/发现诊断，更不会
  // 造成同名技能重复注册。
  const backup = join(dirname(targetDir), '.' + basename(targetDir) + '.sync-bak-' + Date.now())
  await rename(targetDir, backup)
  try {
    await download()
  } catch (error) {
    await rename(backup, targetDir).catch(() => {})
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

/** What a route handler receives: fences already passed, URL/body prepared. */
interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  /** Request URL parsed against a localhost base (query reading for GET). */
  url: URL
  /** Parsed JSON body; empty object for requests without one. */
  body: Record<string, unknown>
}

type RouteHandler = (context: RouteContext) => Promise<void>

/** One declarative route: path + accepted methods + the business handler. */
interface RouteSpec {
  path: string
  /** Accepted HTTP methods; anything else answers 405. */
  methods: readonly ('GET' | 'POST')[]
  /** POST requests must carry a JSON body (400 when missing/unparseable). */
  jsonBody?: boolean
  /** Skip the master-switch gate (the config route stays up while disabled). */
  skipGate?: boolean
  handler: RouteHandler
}

/**
 * Build every /api/skill-hub route.
 * @param deps - skill registry view + sidecar store.
 * @returns the exact-path routes.
 */
export function makeRoutes(deps: SkillHubRouteDeps): WebRoute[] {
  /**
   * Wrap one handler in the shared request fences. Order matches the
   * original per-handler prologue: loopback trust → HTTP method → master
   * switch → JSON body. The outer catch maps errors onto the JSON error
   * body (preserving RepoFetchError status codes).
   */
  const route = (spec: RouteSpec): WebRoute => ({
    kind: 'exact',
    path: spec.path,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
      if (!spec.methods.includes(req.method as 'GET' | 'POST')) {
        writeError(res, 405, 'method not allowed: ' + (req.method ?? ''))
        return
      }
      if (spec.skipGate !== true && disabledGate(deps, res)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      let body: Record<string, unknown> = {}
      if (spec.jsonBody === true && req.method === 'POST') {
        const parsed = await readJsonBody(req)
        if (parsed === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        body = parsed
      }
      try {
        await spec.handler({ req, res, url, body })
      } catch (error) {
        writeRouteError(res, error)
      }
    },
  })

  return [
    // ------------------------------------------------------------ catalog
    route({
      path: SKILL_HUB_API.catalog,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const cwd = queryParam(url, 'cwd')
        writeJson(res, 200, await buildCatalog(deps, cwd))
      },
    }),
    // -------------------------------------------------------------- detail
    route({
      path: SKILL_HUB_API.skill,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const name = queryParam(url, 'name')
        if (name === undefined || name === '') { writeError(res, 400, 'name query parameter is required'); return }
        const cwd = queryParam(url, 'cwd')
        // 显式 cwd 只看该工作区；否则按已知工作区逐个查找（与目录默认视图
        // 一致），最后回退用户级根，保证默认视图里可见的项目技能能打开详情。
        let skill: SkillDefinition | undefined
        if (cwd !== undefined && cwd !== '') {
          skill = await deps.skills.get(name, { cwd })
        } else {
          for (const ws of await workspaceEntries(homeOf(deps))) {
            skill = await deps.skills.get(name, { cwd: ws.path })
            if (skill !== undefined) break
          }
          if (skill === undefined) skill = await deps.skills.get(name)
        }
        if (skill === undefined) {
          // Hub-disabled skills live outside registry discovery (renamed to .disabled);
          // serve their detail straight from the sidecar record + file.
          const record = await deps.store.getDisabled(name)
          if (record !== undefined) {
            try {
              const text = await readFile(record.path, 'utf8')
              const parsed = parseFrontmatter(text)
              if (!('error' in parsed)) {
                const disabledDetail: SkillDetail = {
                  name: record.name,
                  description: parsed.value.description,
                  ...(parsed.value.whenToUse !== undefined ? { whenToUse: parsed.value.whenToUse } : {}),
                  invocation: { ...parsed.value.invocation },
                  provider: 'skill-hub (disabled)',
                  path: record.path,
                  content: parsed.value.content,
                }
                try {
                  const times = await stat(record.path)
                  disabledDetail.addedAt = times.birthtimeMs
                  disabledDetail.updatedAt = times.mtimeMs
                } catch {
                  // ignore
                }
                writeJson(res, 200, { ok: true, skill: disabledDetail } satisfies SkillDetailResponse)
                return
              }
            } catch {
              // fall through to 404 below
            }
          }
          writeError(res, 404, 'skill not found: ' + name)
          return
        }
        const detail = toDetail(skill)
        if (skill.path !== undefined) {
          try {
            const times = await stat(skill.path)
            detail.addedAt = times.birthtimeMs
            detail.updatedAt = times.mtimeMs
          } catch {
            // 文件不可读时省略时间字段，详情页不显示这两行。
          }
          // UI metadata from agents/openai.yaml beside the skill directory (codex).
          try {
            const rb = skill.resourceBase as { kind?: string; path?: string } | undefined
            const dir = rb?.kind === 'directory' && typeof rb.path === 'string' ? rb.path : (skill.path.endsWith('SKILL.md') ? dirname(skill.path) : undefined)
            if (dir !== undefined) {
              const iface = await readSkillInterface(dir)
              if (iface !== undefined) {
                if (iface.displayName !== undefined) detail.displayName = iface.displayName
                if (iface.shortDescription !== undefined) detail.shortDescription = iface.shortDescription
                if (iface.brandColor !== undefined) detail.brandColor = iface.brandColor
                if (iface.iconSmall !== undefined) detail.iconSmall = iface.iconSmall
                if (iface.iconLarge !== undefined) detail.iconLarge = iface.iconLarge
                if (iface.defaultPrompt !== undefined) detail.defaultPrompt = iface.defaultPrompt
              }
            }
          } catch {
            // best-effort
          }
        }
        writeJson(res, 200, { ok: true, skill: detail } satisfies SkillDetailResponse)
      },
    }),
    // -------------------------------------------------------- skill/delete
    // 把单个技能（目录或平面文件）移入回收站（可恢复），并清理禁用记录、tag 成员与来源映射。
    route({
      path: SKILL_HUB_API.skillDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SkillDeleteRequest & { cwd?: string }
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const resolved = await resolveWritableSkill(deps, name, typeof request.cwd === 'string' ? request.cwd : undefined)
        // 已禁用的技能不在 registry 中，resolve 会 404，这里单独处理：允许整组删除未开启的技能
        let trashResult: { path: string; source: string } | null = null
        if (!resolved.ok) {
          const disabled = await deps.store.getDisabled(name)
          if (disabled !== undefined) {
            // 禁用态：SKILL.md.disabled 或 *.md.disabled，直接将其所在技能整体移入回收站
            const isBundleDisabled = disabled.path.endsWith('SKILL.md.disabled')
            const sourceToTrash = isBundleDisabled ? dirname(disabled.path) : disabled.path
            const trashDir = join(dirname(sourceToTrash), '.trash')
            await mkdir(trashDir, { recursive: true })
            const target = join(trashDir, basename(sourceToTrash) + '-' + Date.now())
            await rename(sourceToTrash, target)
            trashResult = { path: target, source: sourceToTrash }
          } else {
            writeError(res, resolved.status, resolved.error); return
          }
        }
        // 入回收站前快照来源归属与场景成员：恢复时把它们加回来，否则恢复
        // 后的技能会丢失来源（变成「个人技能」）和场景分组。
        const tracked = await deps.store.getSourceForSkill(name)
        const tagIds = (await deps.store.listTags()).filter((tag) => tag.skillNames.includes(name)).map((tag) => tag.id)
        const { path, source } = trashResult ?? await trashSkill((resolved as { ok: true; path: string }).path)
        await deps.store.addTrash({
          name,
          path,
          movedAt: Date.now(),
          sourcePath: source,
          ...(tracked !== undefined
            ? { origin: { repo: tracked.repo, root: tracked.root, ...(tracked.ref !== undefined && tracked.ref !== '' ? { ref: tracked.ref } : {}), commitSha: tracked.commitSha } }
            : {}),
          ...(tagIds.length > 0 ? { tagIds } : {}),
        })
        await deps.store.removeDisabled(name)
        await deps.store.removeSkillFromSources(name)
        await deps.store.removeSkillFromTags(name)
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, name, path } satisfies SkillDeleteResponse)
      },
    }),
    // -------------------------------------------------------------- toggle
    route({
      path: SKILL_HUB_API.toggle,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as ToggleRequest & { cwd?: string }
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const lookup = typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : undefined
        if (request.enabled === true) {
          const record = await deps.store.getDisabled(name)
          if (record === undefined) { writeError(res, 404, 'skill is not hub-disabled: ' + name); return }
          try {
            await enableSkill(record.path)
          } catch (error) {
            // The renamed file may have vanished (external cleanup); report
            // precisely instead of a generic 500, like toggle-batch does.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              writeError(res, 409, 'disabled skill file is missing on disk: ' + record.path)
              return
            }
            throw error
          }
          await deps.store.removeDisabled(name)
        } else {
          const resolved = await resolveWritableSkill(deps, name, typeof request.cwd === 'string' ? request.cwd : undefined)
          if (!resolved.ok) { writeError(res, resolved.status, resolved.error); return }
          const disabledPath = await disableSkill(resolved.path)
          await deps.store.addDisabled({
            name,
            description: resolved.skill.description,
            path: disabledPath,
            root: resolved.root,
            disabledAt: Date.now(),
          })
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd) } satisfies ToggleResponse)
      },
    }),
    // -------------------------------------------------------- toggle-batch
    // One write for a whole group: enables every hub-disabled name, or
    // disables every writable name. Skips already-target states as no-ops;
    // per-name failures are reported, never fatal.
    route({
      path: SKILL_HUB_API.toggleBatch,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as ToggleBatchRequest & { cwd?: string }
        const names = Array.isArray(request.names) ? request.names.filter((n): n is string => typeof n === 'string' && n !== '') : []
        if (names.length === 0) { writeError(res, 400, 'names must be a non-empty array'); return }
        const enabled = request.enabled === true
        const lookup = typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : undefined
        const failures: Array<{ name: string; error: string }> = []
        for (const name of names) {
          try {
            if (enabled) {
              const record = await deps.store.getDisabled(name)
              if (record === undefined) continue // already enabled: no-op
              await enableSkill(record.path)
              await deps.store.removeDisabled(name)
            } else {
              const resolved = await resolveWritableSkill(deps, name, typeof request.cwd === 'string' ? request.cwd : undefined)
              if (!resolved.ok) { failures.push({ name, error: resolved.error }); continue }
              const disabledPath = await disableSkill(resolved.path)
              await deps.store.addDisabled({ name, description: resolved.skill.description, path: disabledPath, root: resolved.root, disabledAt: Date.now() })
            }
          } catch (error) {
            failures.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd), failures } satisfies ToggleBatchResponse)
      },
    }),
    // -------------------------------------------------------------- create
    route({
      path: SKILL_HUB_API.create,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as CreateRequest
        const name = typeof request.name === 'string' ? request.name.trim() : ''
        if (!isSkillName(name)) { writeError(res, 400, 'skill name must be kebab-case (lowercase letters, digits, dashes)'); return }
        const root: WritableRoot = request.root ?? 'user-dsh'
        if (root !== 'user-dsh' && root !== 'user-agents') { writeError(res, 400, 'root must be user-dsh or user-agents'); return }
        const existing = await deps.skills.get(name)
        if (existing !== undefined) { writeError(res, 409, 'skill name already exists: ' + name); return }
        if (await deps.store.getDisabled(name) !== undefined) { writeError(res, 409, 'skill name is disabled: re-enable it from the disabled list first'); return }
        // A directory may exist without producing a registry entry (invalid
        // frontmatter — exactly what the diagnostics section reports).
        // Refuse to overwrite it instead of silently truncating its SKILL.md.
        const target = join(rootPath(root, homeOf(deps)), name)
        if (await pathExists(target)) {
          writeError(res, 409, 'skill directory already exists on disk: ' + name + ' (check the discovery diagnostics)')
          return
        }
        const path = await createSkill(root, name, typeof request.description === 'string' ? request.description : '', homeOf(deps))
        // 新技能自动归入默认场景（「通用」）。
        const defaultTag = await deps.store.getDefaultTag()
        if (defaultTag !== undefined) await deps.store.addSkillToTag(defaultTag.id, name)
        deps.invalidate?.()
        writeJson(res, 201, { ok: true, path, root } satisfies CreateResponse)
      },
    }),
    // ---------------------------------------------------------------- stats
    route({
      path: SKILL_HUB_API.stats,
      methods: ['GET'],
      handler: async ({ res }) => {
        if (deps.stats === undefined) {
          writeJson(res, 200, { ok: true, available: false, stats: [] } satisfies import('./protocol.ts').StatsResponse)
          return
        }
        const stats = await deps.stats()
        writeJson(res, 200, { ok: true, available: true, stats } satisfies import('./protocol.ts').StatsResponse)
      },
    }),
    // --------------------------------------------------------------- config
    // The config route stays mounted even with the master switch off, so the
    // settings card can always read and re-enable the hub.
    route({
      path: SKILL_HUB_API.config,
      methods: ['GET', 'POST'],
      jsonBody: true,
      skipGate: true,
      handler: async ({ req, res, body }) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, pluginVersion: CURRENT_VERSION, config: configOf(deps), saved: savedOf(deps) } satisfies ConfigResponse)
          return
        }
        const raw = body
        const patch: Partial<HubConfig> = {}
        if (raw.enabled !== undefined) {
          if (raw.enabled === null) patch.enabled = undefined
          else if (typeof raw.enabled !== 'boolean') { writeError(res, 400, 'enabled must be a boolean or null'); return }
          else patch.enabled = raw.enabled
        }
        if (raw.announceToAgent !== undefined) {
          if (raw.announceToAgent === null) patch.announceToAgent = undefined
          else if (typeof raw.announceToAgent !== 'boolean') { writeError(res, 400, 'announceToAgent must be a boolean or null'); return }
          else patch.announceToAgent = raw.announceToAgent
        }
        for (const key of ['showUseCount', 'showUseTime', 'showGroupSummary'] as const) {
          const value = raw[key]
          if (value === undefined) continue
          if (value === null) { patch[key] = undefined; continue }
          if (typeof value !== 'boolean') { writeError(res, 400, key + ' must be a boolean or null'); return }
          patch[key] = value
        }
        for (const key of ['dotModelColor', 'dotUserColor'] as const) {
          const value = raw[key]
          if (value === undefined) continue
          if (value === null) { patch[key] = undefined; continue }
          if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) { writeError(res, 400, key + ' must be a #rrggbb color or null'); return }
          patch[key] = value
        }
        let config: HubConfig
        if (deps.updateConfig === undefined) {
          const merged: HubConfig = { ...configOf(deps) }
          for (const [key, value] of Object.entries(patch) as Array<[keyof HubConfig, boolean | string | undefined]>) {
            if (value === undefined) delete merged[key]
            else (merged as unknown as Record<string, unknown>)[key] = value
          }
          config = merged
        } else {
          config = await deps.updateConfig(patch)
        }
        writeJson(res, 200, { ok: true, pluginVersion: CURRENT_VERSION, config, saved: savedOf(deps) } satisfies ConfigResponse)
      },
    }),
    // --------------------------------------------------------------- market
    // Market sources: the user adds repo slugs; each source can
    // be scanned through /repo and imported through /repo/import.
    route({
      path: SKILL_HUB_API.market,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, { ok: true, repos: await deps.store.listMarketSources() } satisfies MarketSourcesResponse)
      },
    }),
    route({
      path: SKILL_HUB_API.marketSource,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        // An explicit @ref pins the source immediately (e.g. repo@v1.2.3);
        // otherwise the first scan resolves latest-release / branch choice.
        const ref = parsed.ref !== undefined ? parsed.ref : undefined
        writeJson(res, 200, { ok: true, repos: await deps.store.addMarketSource(repoSlug(parsed), ref) } satisfies MarketSourceResponse)
      },
    }),
    route({
      path: SKILL_HUB_API.marketSourceDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        writeJson(res, 200, { ok: true, repos: await deps.store.removeMarketSource(repoSlug(parsed)) } satisfies MarketSourceResponse)
      },
    }),
    // ------------------------------------------------------- market/source/ref
    // Pin a market source to an explicit ref (branch chosen after a scan
    // found no release, or a user-specified tag).
    route({
      path: SKILL_HUB_API.marketSourceRef,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRefRequest
        const parsed = normalizeRepoInput(typeof request.repo === 'string' ? request.repo : '')
        const ref = typeof request.ref === 'string' ? request.ref.trim() : ''
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        if (ref === '') { writeError(res, 400, 'ref is required'); return }
        const record = await deps.store.setMarketSourceRef(repoSlug(parsed), ref)
        if (record === undefined) { writeError(res, 404, 'market source not found: ' + repoSlug(parsed)); return }
        writeJson(res, 200, { ok: true, repos: await deps.store.listMarketSources() } satisfies MarketSourceResponse)
      },
    }),
    // -------------------------------------------- market/source/versions
    // Version picker data: release tags + branch names for one market source.
    route({
      path: SKILL_HUB_API.marketSourceVersions,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const input = queryParam(url, 'repo') ?? ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const source = await deps.store.getMarketSource(repo)
        if (source === undefined) { writeError(res, 404, 'market source not found: ' + repo); return }
        const [releases, branches] = await Promise.all([listRepoReleases(repo), listRepoBranches(repo)])
        writeJson(res, 200, {
          ok: true,
          repo,
          ...(source.ref !== undefined && source.ref !== '' ? { current: source.ref } : {}),
          releases,
          branches,
        } satisfies MarketSourceVersionsResponse)
      },
    }),
    // ------------------------------------------------------- market/check
    // Update check over every market source: compares the pinned ref's
    // commit against the recorded baseline and surfaces newer releases.
    // 5-minute throttle mirrors the source check.
    route({
      path: SKILL_HUB_API.marketCheck,
      methods: ['GET'],
      handler: async ({ res }) => {
        const sources = await deps.store.listMarketSources()
        if (lastMarketCheck.size > 500) lastMarketCheck.clear()
        const results: MarketCheckResponse['results'] = []
        for (const source of sources) {
          const base = { repo: source.repo, ...(source.ref !== undefined ? { ref: source.ref } : {}) }
          const now = Date.now()
          const last = lastMarketCheck.get(source.repo) ?? 0
          if (now - last < MIN_CHECK_INTERVAL_MS) {
            results.push({ ...base, updateAvailable: false, commitSha: source.commitSha ?? '', throttled: true })
            continue
          }
          try {
            const latestTag = await getLatestReleaseTag(source.repo)
            if (source.ref === undefined) {
              // Not pinned yet: report the latest release so the UI can
              // suggest pinning, but never claim an update.
              results.push({ ...base, updateAvailable: false, commitSha: source.commitSha ?? '', ...(latestTag !== undefined ? { latestTag } : {}) })
              continue
            }
            const latest = await getLatestCommit(source.repo, source.ref)
            lastMarketCheck.set(source.repo, now)
            const commitMoved = source.commitSha !== undefined && latest.commitSha !== source.commitSha
            const newRelease = latestTag !== undefined && latestTag !== source.ref
            results.push({ ...base, updateAvailable: commitMoved || newRelease, commitSha: latest.commitSha, ...(newRelease ? { latestTag } : {}) })
          } catch (error) {
            results.push({ ...base, updateAvailable: false, commitSha: source.commitSha ?? '', error: error instanceof Error ? error.message : String(error) })
          }
        }
        writeJson(res, 200, { ok: true, results } satisfies MarketCheckResponse)
      },
    }),
    // ------------------------------------------------------- market/source/sync
    // Align a market source to its version: resolve the pinned ref (or pick
    // the latest release when unpinned), record the commit, and propagate the
    // ref to the matching tracked source record so source checks/syncs follow
    // it. Returns the local skills tracked from this repo so the UI can offer
    // a batch update.
    route({
      path: SKILL_HUB_API.marketSync,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as MarketSourceRefRequest
        const parsed = normalizeRepoInput(typeof request.repo === 'string' ? request.repo : '')
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const source = await deps.store.getMarketSource(repo)
        if (source === undefined) { writeError(res, 404, 'market source not found: ' + repo); return }
        // Resolve the ref: pinned ref wins; otherwise auto-adopt the latest
        // release; a repo without releases must be pinned via the branch picker first.
        let ref = source.ref
        if (ref === undefined || ref === '') {
          const latestTag = await getLatestReleaseTag(repo)
          if (latestTag === undefined) { writeError(res, 409, 'repo has no release — pick a branch first'); return }
          ref = latestTag
          await deps.store.setMarketSourceRef(repo, ref)
        }
        const latest = await getLatestCommit(repo, ref)
        await deps.store.setMarketSourceCommit(repo, latest.commitSha)
        // Propagate the ref to the tracked source record so checks follow it.
        await deps.store.setSourceRef(repo, ref)
        const tracked = await deps.store.getSource(repo)
        writeJson(res, 200, {
          ok: true,
          repo,
          ref,
          commitSha: latest.commitSha,
          skills: tracked !== undefined ? [...tracked.skills] : [],
        } satisfies MarketSyncResponse)
      },
    }),
    // ---------------------------------------------------------------- repo
    // Discover importable skills in a public GitHub repo (any top-level root containing SKILL.md).
    route({
      path: SKILL_HUB_API.repo,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const input = queryParam(url, 'repo') ?? ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        // Version resolution: explicit @ref wins; then the market source's
        // pinned ref (branch picked earlier); then the latest release;
        // a repo without releases must be pinned to a branch by the user
        // (branches returned, ref null).
        let ref = parsed.ref
        if (ref === undefined || ref === '') {
          const pinned = await deps.store.getMarketSource(repo)
          if (pinned?.ref !== undefined && pinned.ref !== '') {
            ref = pinned.ref
          }
        }
        if (ref === undefined || ref === '') {
          const releaseTag = await getLatestReleaseTag(repo)
          if (releaseTag !== undefined) {
            ref = releaseTag
            // Auto-pin an existing but unpinned market source to the resolved
            // release, so the row shows the tracked version from the first scan.
            const existing = await deps.store.getMarketSource(repo)
            if (existing !== undefined && (existing.ref === undefined || existing.ref === '')) {
              await deps.store.setMarketSourceRef(repo, releaseTag)
            }
          } else {
            const branches = await listRepoBranches(repo)
            if (branches.length === 0) { writeError(res, 404, 'repo has no branches to scan'); return }
            writeJson(res, 200, { ok: true, repo, ref: null, branches, entries: [] } satisfies RepoDiscoverResponse)
            return
          }
        }
        const { ref: resolvedRef, tree, truncated } = await loadRepoTree(repo, ref)
        const existing = await knownSkillNames(deps)
        const entries = discoverRepoEntries(tree, repo, existing)
        writeJson(res, 200, { ok: true, repo, ref: resolvedRef, entries, ...(truncated ? { truncated: true } : {}) } satisfies RepoDiscoverResponse)
      },
    }),
    // ----------------------------------------------------------- repo/import  B方案 Job
    // Install selected repo skills — now async job (B方案：轮询 + 选项2后台继续)
    // POST returns jobId instantly (<500ms), GET /progress polls for done.
    route({
      path: SKILL_HUB_API.repoImport,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as RepoImportRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const paths = Array.isArray(request.paths) ? request.paths.filter((path): path is string => typeof path === 'string' && path !== '') : []
        if (paths.length === 0) { writeError(res, 400, 'paths must be a non-empty array'); return }
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const ref = typeof request.ref === 'string' && request.ref !== '' ? request.ref : parsed.ref
        const { ref: resolvedRef, tree } = await loadRepoTree(repo, ref)
        const existing = await knownSkillNames(deps)
        const entries = discoverRepoEntries(tree, repo, existing)
        // truncated tree is still usable for the selected paths the user already picked from the prior discover response
        const byPath = new Map(entries.map((entry) => [entry.path, entry]))
        const selected = paths.map((path) => byPath.get(path)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        if (selected.length === 0) { writeError(res, 400, 'no matching skills for selected paths'); return }
        if (selected.length > 500) { writeError(res, 400, 'select at most 500 skills per import'); return }
        const totalBytes = selected.reduce((sum, entry) => sum + entry.totalBytes, 0)
        if (totalBytes > 200 * 1024 * 1024) { writeError(res, 400, 'selected skills exceed the 200MB import limit'); return }

        let commitSha = ''
        try {
          const latest = await getLatestCommit(repo, resolvedRef)
          commitSha = latest.commitSha
        } catch {
          // empty snapshot ok
        }

        const jobId = 'imp_' + randomUUID().slice(0, 8)
        const controller = new AbortController()
        const now = Date.now()
        const job: ImportJob = {
          jobId,
          repo,
          ref: resolvedRef,
          total: selected.length,
          done: 0,
          totalBytes,
          downloadedBytes: 0,
          startTime: now,
          imported: [],
          skipped: [],
          failed: [],
          status: 'running',
          controller,
          createdAt: now,
        }
        gcImportJobs()
        importJobs.set(jobId, job)

        // 启动时顺手清理一次残留临时目录（best-effort，不阻塞响应）
        const targetRootEarly = rootPath('user-dsh', homeOf(deps))
        void cleanupLeftoverImportDirs(targetRootEarly).catch(() => {})

        // 后台执行，不阻塞响应（选项2：关面板也继续跑，唯有 /cancel 才 abort）
        void (async () => {
          const targetRoot = rootPath('user-dsh', homeOf(deps))
          await mkdir(targetRoot, { recursive: true })
          const defaultTag = await deps.store.getDefaultTag()
          let needInvalidate = false
          for (const entry of selected) {
            if (controller.signal.aborted) break
            job.current = entry.name
            job.currentFile = entry.dir + '/SKILL.md'
            if (entry.existing) {
              job.skipped.push({ name: entry.name, reason: 'exists' })
              job.downloadedBytes += entry.totalBytes
              job.done += 1
              continue
            }
            if (await pathExists(join(targetRoot, entry.name))) {
              job.skipped.push({ name: entry.name, reason: 'exists' })
              job.downloadedBytes += entry.totalBytes
              job.done += 1
              continue
            }
            if (controller.signal.aborted) break
            const files = collectRepoSkillFiles(tree, entry.dir)
            try {
              const result = await downloadRepoSkill(repo, resolvedRef, entry, files, targetRoot, fetch, controller.signal, (bytes, file) => {
                job.downloadedBytes += bytes
                job.currentFile = entry.dir + '/' + file
              })
              await deps.store.addSourceSkill(repo, entry.root, commitSha, resolvedRef, entry.name)
              await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir)
              if (defaultTag !== undefined) await deps.store.addSkillToTag(defaultTag.id, entry.name)
              job.imported.push({ name: entry.name, origin: entry.origin, path: result.skillPath })
              needInvalidate = true
            } catch (error) {
              if (isAbortError(error) || controller.signal.aborted) {
                // 取消时不记为 failed，保留已完成的 imported/skipped，直接跳出
                break
              }
              job.failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
            } finally {
              job.done += 1
            }
          }
          if (controller.signal.aborted) {
            job.status = 'cancelled'
            job.current = undefined
            job.currentFile = undefined
          } else {
            job.status = 'done'
            job.current = undefined
            job.currentFile = undefined
            // 确保字节进度最终对齐（避免浮点/并发尾差）
            job.downloadedBytes = job.totalBytes
          }
          if (needInvalidate) deps.invalidate?.()
        })().catch((error) => {
          job.status = 'error'
          job.error = error instanceof Error ? error.message : String(error)
          job.current = undefined
          job.currentFile = undefined
        })

        writeJson(res, 200, { ok: true, jobId, total: selected.length, totalBytes } satisfies RepoImportResponse)
      },
    }),
    // 进度轮询（含字节级进度和速度）
    route({
      path: SKILL_HUB_API.repoImportProgress,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const jobId = queryParam(url, 'jobId') ?? ''
        if (jobId === '') { writeError(res, 400, 'jobId is required'); return }
        const job = importJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'import job not found: ' + jobId); return }
        const elapsedSec = Math.max(0.5, (Date.now() - job.startTime) / 1000)
        const bytesPerSecond = job.status === 'running' ? Math.round(job.downloadedBytes / elapsedSec) : undefined
        writeJson(res, 200, {
          ok: true,
          jobId: job.jobId,
          status: job.status,
          total: job.total,
          done: job.done,
          ...(job.current !== undefined ? { current: job.current } : {}),
          ...(job.currentFile !== undefined ? { currentFile: job.currentFile } : {}),
          totalBytes: job.totalBytes,
          downloadedBytes: job.downloadedBytes,
          ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
          imported: [...job.imported],
          skipped: [...job.skipped],
          failed: [...job.failed],
          ...(job.error !== undefined ? { error: job.error } : {}),
        } satisfies RepoImportProgressResponse)
      },
    }),
    // 取消任务（选项2：唯有点取消才停）
    route({
      path: SKILL_HUB_API.repoImportCancel,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as RepoImportCancelRequest
        const jobId = typeof request.jobId === 'string' ? request.jobId : ''
        if (jobId === '') { writeError(res, 400, 'jobId is required'); return }
        const job = importJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'import job not found: ' + jobId); return }
        if (job.status === 'running') {
          job.controller.abort()
          job.status = 'cancelled'
        }
        writeJson(res, 200, { ok: true, jobId: job.jobId, status: job.status as 'cancelled' | 'done' } satisfies RepoImportCancelResponse)
      },
    }),
    // -------------------------------------------------------------- update
    // 自身更新检查：查询 GitHub latest release。
    route({
      path: SKILL_HUB_API.update,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, await checkLatestRelease())
      },
    }),
    // -------------------------------------------------------------- groups
    // 用户 tag 分组 + 系统集合组 + origin 映射（前端分组栏的数据源）。
    route({
      path: SKILL_HUB_API.groups,
      methods: ['GET'],
      handler: async ({ res }) => {
        writeJson(res, 200, await buildGroups(deps))
      },
    }),
    // ----------------------------------------------------------------- tag
    // 新建（缺省 id）或重命名（带 id）一个用户 tag 分组。
    route({
      path: SKILL_HUB_API.tag,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') { writeError(res, 400, 'tag name is required'); return }
        const id = typeof body.id === 'string' && body.id !== '' ? body.id : undefined
        await deps.store.saveTag({ id, name })
        writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagSaveResponse)
      },
    }),
    // ----------------------------------------------------------- tag/delete
    route({
      path: SKILL_HUB_API.tagDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const id = typeof (body as unknown as TagDeleteRequest).id === 'string' ? (body as unknown as TagDeleteRequest).id : ''
        if (id === '') { writeError(res, 400, 'tag id is required'); return }
        const tag = await deps.store.getTag(id)
        if (tag?.default === true) { writeError(res, 409, 'the default scene cannot be deleted'); return }
        await deps.store.deleteTag(id)
        writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagDeleteResponse)
      },
    }),
    // ---------------------------------------------------------- tag/members
    // 直接设置某 tag 的完整成员列表；后端只保留目录中实际存在的技能名。
    route({
      path: SKILL_HUB_API.tagMembers,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as TagMembersRequest
        const id = typeof request.id === 'string' ? request.id : ''
        if (id === '') { writeError(res, 400, 'tag id is required'); return }
        const names = Array.isArray(request.skillNames) ? request.skillNames.filter((n): n is string => typeof n === 'string') : []
        const known = await knownSkillNames(deps)
        const saved = await deps.store.setTagMembers(id, names.filter((n) => known.has(n)))
        if (saved === undefined) { writeError(res, 404, 'tag not found: ' + id); return }
        writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagMembersResponse)
      },
    }),
    // ---------------------------------------------------------- tag/reorder
    // 拖拽重排场景分组顺序
    route({
      path: SKILL_HUB_API.tagReorder,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as TagReorderRequest
        const orderedIds = Array.isArray(request.orderedIds) ? request.orderedIds.filter((id): id is string => typeof id === 'string' && id !== '') : []
        try {
          const tags = await deps.store.reorderTags(orderedIds)
          writeJson(res, 200, { ok: true, tags } satisfies TagReorderResponse)
        } catch (error) {
          if (error instanceof StoreError) { writeError(res, error.kind === 'validation' ? 400 : error.kind === 'not-found' ? 404 : 409, error.message); return }
          throw error
        }
      },
    }),
    // ------------------------------------------------- collection/reorder
    // 拖拽重排来源集合顺序
    route({
      path: SKILL_HUB_API.collectionReorder,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as CollectionReorderRequest
        const orderedNames = Array.isArray(request.orderedNames) ? request.orderedNames.filter((n): n is string => typeof n === 'string' && n !== '') : []
        const order = await deps.store.reorderCollections(orderedNames)
        const groups = await buildGroups(deps)
        writeJson(res, 200, { ok: true, collections: groups.collections, order } satisfies CollectionReorderResponse)
      },
    }),
    // ------------------------------------------------ source-group/reorder
    // 拖拽重排来源顶层分组（project / collections / personal 统一顺序）
    route({
      path: SKILL_HUB_API.sourceGroupReorder,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceGroupReorderRequest
        const orderedKeys = Array.isArray(request.orderedKeys) ? request.orderedKeys.filter((k): k is string => typeof k === 'string' && k !== '') : []
        const order = await deps.store.reorderSourceGroups(orderedKeys)
        writeJson(res, 200, { ok: true, order } satisfies SourceGroupReorderResponse)
      },
    }),
    // ------------------------------------------------------------- sources
    // 来源列表 + 派生 origin 映射 + 集合组 + 回收站。
    route({
      path: SKILL_HUB_API.sources,
      methods: ['GET'],
      handler: async ({ res }) => {
        const [sources, origins, trash, collectionOrder] = await Promise.all([deps.store.listSources(), deps.store.listOrigins(), deps.store.listTrash(), deps.store.getCollectionOrder()])
        const byCollection = new Map<string, string[]>()
        for (const [skillName, origin] of Object.entries(origins)) {
          const list = byCollection.get(origin)
          if (list === undefined) byCollection.set(origin, [skillName])
          else list.push(skillName)
        }
        const orderIndex = new Map(collectionOrder.map((name, i) => [name, i] as const))
        const collections: CollectionGroup[] = [...byCollection.entries()]
          .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
          .sort((a, b) => {
            const ai = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Infinity
            const bi = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Infinity
            if (ai !== bi) return ai - bi
            return a.name.localeCompare(b.name)
          })
        writeJson(res, 200, { ok: true, sources, origins, collections, trash } satisfies SourcesResponse)
      },
    }),
    // -------------------------------------------------------- sources/check
    // 检查指定（或全部）来源的上游更新。每个来源最多 1 次 commit 请求；
    // 仅当 commit 变化时再拉一次 tree 做逐技能差异。5 分钟节流。
    route({
      path: SKILL_HUB_API.sourceCheck,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceCheckRequest
        let only: string | undefined
        if (typeof request.repo === 'string' && request.repo !== '') {
          // Normalize URLs/slugs the same way every other route does, so a
          // check for "https://github.com/a/b" finds the "a/b" record.
          const parsedOnly = normalizeRepoInput(request.repo)
          only = parsedOnly !== null ? repoSlug(parsedOnly) : undefined
        }
        const source = only !== undefined ? await deps.store.getSource(only) : undefined
        if (only !== undefined && source === undefined) { writeError(res, 404, 'source not found: ' + only); return }
        const sources = source !== undefined ? [source] : await deps.store.listSources()
        if (lastSourceCheck.size > 500) lastSourceCheck.clear()
        const results: SourceCheckResult[] = []
        for (const item of sources) {
          const base = { repo: item.repo, ...(item.ref !== undefined ? { ref: item.ref } : {}) }
          const now = Date.now()
          const last = lastSourceCheck.get(item.repo) ?? 0
          if (now - last < MIN_CHECK_INTERVAL_MS) {
            results.push({ ...base, changed: false, updated: [], deleted: [], throttled: true })
            continue
          }
          try {
            const latest = await getLatestCommit(item.repo, item.ref)
            lastSourceCheck.set(item.repo, now)
            if (item.commitSha === '') {
              // Migrated/legacy record without a snapshot: backfill the
              // commit now and report "unverified" instead of claiming every
              // skill is updated (there is no baseline to diff against yet).
              await deps.store.setSourceCommit(item.repo, latest.commitSha)
              results.push({ ...base, changed: false, updated: [], deleted: [], unverified: true, commitSha: latest.commitSha })
              continue
            }
            if (latest.commitSha === item.commitSha) {
              results.push({ ...base, changed: false, updated: [], deleted: [] })
              continue
            }
            const tree = await loadRepoTreeAt(item.repo, latest.treeSha)
            const diff = diffRemoteSkills(tree, item)
            results.push({ ...base, changed: true, commitSha: latest.commitSha, updated: diff.updated, deleted: diff.deleted })
          } catch (error) {
            results.push({ ...base, changed: false, updated: [], deleted: [], error: error instanceof Error ? error.message : String(error) })
          }
        }
        writeJson(res, 200, { ok: true, results } satisfies SourceCheckResponse)
      },
    }),
    // --------------------------------------------------------- sources/sync
    // 按上游重新下载所选（或全部）技能并更新 commit 快照与 manifest。
    route({
      path: SKILL_HUB_API.sourceSync,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceSyncRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        const selected = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : undefined
        const source = await deps.store.getSource(repo)
        if (source === undefined) { writeError(res, 404, 'source not found: ' + repo); return }
        const targets = selected !== undefined ? selected : source.skills
        const latest = await getLatestCommit(repo, source.ref)
        const tree = await loadRepoTreeAt(repo, latest.treeSha)
        const targetRoot = rootPath('user-dsh', homeOf(deps))
        await mkdir(targetRoot, { recursive: true })
        const synced: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        for (const name of targets) {
          // Sync writes under the user root: only accept real skill names
          // this source actually tracks (a bare join would otherwise fold
          // `..` segments out of the writable root).
          if (!isSkillName(name) || !source.skills.includes(name)) {
            failed.push({ name, error: 'skill is not tracked by this source' })
            continue
          }
          try {
            const entry = repoSkillEntry(name, source.root, repo)
            // 上游可能用分类子目录（skills/engineering/<name>/）且目录会移动：
            // 先在上游 tree 里搜真实位置，manifest 兜底，否则嵌套技能会 404。
            entry.dir = skillDirOf(source, name, tree.map((item) => item.path))
            entry.path = entry.dir + '/SKILL.md'
            const files = collectRepoSkillFiles(tree, entry.dir)
            if (files.length === 0) { failed.push({ name, error: 'skill missing upstream' }); continue }
            const targetDir = join(targetRoot, name)
            const wasDisabled = (await deps.store.getDisabled(name)) !== undefined
            if (await pathExists(targetDir)) {
              await replaceSkillDir(targetDir, async () => {
                await downloadRepoSkill(repo, latest.commitSha, entry, files, targetRoot)
              })
            } else {
              await downloadRepoSkill(repo, latest.commitSha, entry, files, targetRoot)
            }
            if (wasDisabled) {
              // Preserve the disabled state: the fresh SKILL.md must not
              // re-enter discovery.
              await rename(join(targetDir, 'SKILL.md'), join(targetDir, 'SKILL.md.disabled'))
            } else {
              await deps.store.removeDisabled(name)
            }
            await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir)
            synced.push(name)
          } catch (error) {
            failed.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        // Only advance the commit snapshot when every skill landed: a failed
        // sync keeps the old commit, so the next check still diffs the tree
        // and re-reports the missing skills instead of silently hiding them.
        if (failed.length === 0) {
          await deps.store.setSourceCommit(repo, latest.commitSha)
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, repo, commitSha: latest.commitSha, synced, failed } satisfies SourceSyncResponse)
      },
    }),
    // ------------------------------------------------------- sources/delete
    // 跟进上游删除：把所选技能的本地目录移入回收站（可恢复）。
    route({
      path: SKILL_HUB_API.sourceDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceDeleteRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        const skills = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : []
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        if (skills.length === 0) { writeError(res, 400, 'skills must be a non-empty array'); return }
        const source = await deps.store.getSource(repo)
        if (source === undefined) { writeError(res, 404, 'source not found: ' + repo); return }
        const home = homeOf(deps)
        const trashed: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        const sourceNames = new Set(source.skills)
        for (const name of skills) {
          // Every name must be a real kebab-case skill that this source
          // actually tracks; anything else must never touch the filesystem
          // (a bare `join` would otherwise fold `..` segments out of the
          // writable root — see the path-containment assert below).
          if (!isSkillName(name) || !sourceNames.has(name)) {
            failed.push({ name, error: 'skill is not tracked by this source' })
            continue
          }
          const sourcePath = join(rootPath('user-dsh', home), name)
          if (rootOfPath(sourcePath, home) === undefined) {
            failed.push({ name, error: 'skill path is outside the hub writable roots' })
            continue
          }
          if (!await pathExists(sourcePath)) {
            failed.push({ name, error: 'skill directory not found' })
            continue
          }
          try {
            // 入回收站前快照来源与场景归属，恢复时挂回（见 sourceRestore）。
            const tagIds = (await deps.store.listTags()).filter((tag) => tag.skillNames.includes(name)).map((tag) => tag.id)
            const { path } = await trashSkill(sourcePath)
            await deps.store.addTrash({
              name,
              path,
              movedAt: Date.now(),
              sourcePath,
              origin: { repo: source.repo, root: source.root, ...(source.ref !== undefined && source.ref !== '' ? { ref: source.ref } : {}), commitSha: source.commitSha },
              ...(tagIds.length > 0 ? { tagIds } : {}),
            })
            await deps.store.removeDisabled(name)
            await deps.store.removeSkillFromTags(name)
            trashed.push(name)
          } catch (error) {
            failed.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (trashed.length > 0) {
          await deps.store.setSourceSkills(repo, source.skills.filter((n) => !trashed.includes(n)))
          deps.invalidate?.()
        }
        writeJson(res, 200, { ok: true, trashed, failed } satisfies SourceDeleteResponse)
      },
    }),
    // ------------------------------------------------------ sources/restore
    // 从回收站恢复一个技能目录。
    route({
      path: SKILL_HUB_API.sourceRestore,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceRestoreRequest
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const entry = await deps.store.getTrash(name)
        if (entry === undefined) { writeError(res, 404, 'trash entry not found: ' + name); return }
        const home = homeOf(deps)
        const target = entry.sourcePath ?? join(rootPath('user-dsh', home), name)
        if (await pathExists(target)) {
          writeError(res, 409, 'skill already exists: ' + name)
          return
        }
        const path = await restoreSkill(entry, home)
        // 恢复来源归属（入回收站前快照的来源记录）与场景成员，否则恢复后
        // 的技能会变成「个人技能」并脱离原场景。
        if (entry.origin !== undefined) {
          await deps.store.addSourceSkill(entry.origin.repo, entry.origin.root, entry.origin.commitSha, entry.origin.ref, name)
        }
        for (const tagId of entry.tagIds ?? []) {
          await deps.store.addSkillToTag(tagId, name)
        }
        await deps.store.removeTrash(name)
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, name, path } satisfies SourceRestoreResponse)
      },
    }),
    // ------------------------------------------------- sources/trash/clear
    // 清空回收站：永久删除 .trash 里的技能，失败项保留可重试。
    route({
      path: SKILL_HUB_API.sourceTrashClear,
      methods: ['POST'],
      handler: async ({ res }) => {
        const home = homeOf(deps)
        const entries = await deps.store.listTrash()
        const deleted: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        for (const entry of entries) {
          try {
            await clearTrash(entry, home)
            // A permanently deleted skill must not linger in user groups.
            await deps.store.removeSkillFromTags(entry.name)
            deleted.push(entry.name)
          } catch (error) {
            failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        for (const name of deleted) await deps.store.removeTrash(name)
        if (deleted.length > 0) deps.invalidate?.()
        writeJson(res, 200, { ok: true, deleted, failed } satisfies SourceTrashClearResponse)
      },
    }),
    // -------------------------------------------------------- diagnostic fix
    route({
      path: SKILL_HUB_API.diagnosticFix,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as DiagnosticFixRequest
        const rawPath = typeof request.path === 'string' ? request.path.trim() : ''
        if (rawPath === '') { writeError(res, 400, 'path is required'); return }
        try {
          await fixDiagnosticFile(rawPath, homeOf(deps))
          deps.invalidate?.()
          writeJson(res, 200, { ok: true, path: rawPath } satisfies DiagnosticFixResponse)
        } catch (error) {
          writeRouteError(res, error)
        }
      },
    }),
  ]
}
