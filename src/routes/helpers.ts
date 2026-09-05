/**
 * routes 共享层：请求围栏（回环信任/方法/总开关/JSON 体）、统一错误映射、
 * 可写技能解析、目录/分组数据装配。handler 只写业务，从这里 import。
 * 从 routes.ts 原样搬出，行为不变。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import {
  resolveHubConfig,
  isProjectSource,
  type CatalogResponse,
  type CatalogSkill,
  type CollectionGroup,
  type GroupsResponse,
  type HubConfig,
  type SkillDetail,
  type WritableRoot,
} from '../protocol.ts'
import { rootOfPath, rootPath, readSkillInterface, scanDiagnostics } from '../skillfs.ts'
import { CURRENT_VERSION } from '../update.ts'
import { dshHome, StoreError, type SkillHubStore } from '../store.ts'
import { RepoFetchError } from '../repo.ts'

/** Cap on JSON request bodies (toggle/create payloads are tiny). */
export const MAX_JSON_BODY_BYTES = 64 * 1024

/** Loopback literal check plus browser same-origin markers. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
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
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** One JSON error response. */
export function writeError(res: ServerResponse, status: number, error: unknown): void {
  const body = { error: error instanceof Error ? error.message : String(error) }
  writeJson(res, status, body)
}

/** HTTP status per store business-rule kind (user error, not server fault). */
export const STORE_ERROR_STATUS = { validation: 400, 'not-found': 404, conflict: 409 } as const

/** Map known error types onto HTTP statuses: repo fetch + store business rules. */
export function writeRouteError(res: ServerResponse, error: unknown): void {
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
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
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
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Async existence check (import/sync use it on the user root). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Sources the hub may toggle (the user-level filesystem roots). */
export function isWritableSource(source: string): source is WritableRoot {
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
  stats?: import('../stats.ts').SkillStatsReader
  /** Resolves the current plugin config; business routes honour the master switch. */
  config?: () => HubConfig
  /** Resolves the raw saved config layer (fields the user explicitly overrode). */
  saved?: () => Partial<HubConfig>
  /** Persist a config patch and re-sync plugin surfaces; resolves with the fresh config. */
  updateConfig?: (patch: Partial<HubConfig>) => Promise<HubConfig>
}

/** The resolved hub config a route sees (the shared resolver fills defaults). */
export function configOf(deps: SkillHubRouteDeps): HubConfig {
  return resolveHubConfig({}, deps.config?.() ?? {})
}

/** The raw saved config layer a route reports (empty when the owner omits it). */
export function savedOf(deps: SkillHubRouteDeps): Partial<HubConfig> {
  return deps.saved?.() ?? {}
}

/** Refuse business routes while the master switch is off (the config route stays up). */
export function disabledGate(deps: SkillHubRouteDeps, res: ServerResponse): boolean {
  if (configOf(deps).enabled) return false
  writeError(res, 503, 'plugin disabled: enable it from the settings card')
  return true
}

/** Resolve the home used for writable-root operations. */
export function homeOf(deps: SkillHubRouteDeps): string {
  return deps.home ?? dshHome()
}

/** A skill resolved as a hub-writable user-level file. */
export interface WritableSkill {
  skill: SkillDefinition
  /** Absolute discovery-file path (guaranteed present by the resolver). */
  path: string
  /** The writable root containing the file. */
  root: WritableRoot
}

/** A refusal with the exact HTTP error the caller should answer with. */
export interface WritableSkillRefusal {
  status: number
  error: string
}

export type WritableSkillResult = { ok: true } & WritableSkill | { ok: false } & WritableSkillRefusal

/**
 * Resolve a skill by name as something the hub may write, or the exact
 * refusal the caller should answer with. Owns the guard sequence shared by
 * toggle, toggle-batch, and skill/delete: registry lookup, writable source,
 * writable file, and path containment inside a user root.
 */
export async function resolveWritableSkill(deps: SkillHubRouteDeps, name: string, cwd?: string): Promise<WritableSkillResult> {
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
export async function buildGroups(deps: SkillHubRouteDeps): Promise<GroupsResponse> {
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
export async function knownSkillNames(deps: SkillHubRouteDeps): Promise<Set<string>> {
  const snapshot = await deps.skills.snapshot()
  const names = new Set(snapshot.skills.map((skill) => skill.name))
  for (const disabled of await deps.store.listDisabled()) names.add(disabled.name)
  return names
}

/** 已知工作区条目（dsh 的 workspace.json 表）。 */
export interface WorkspaceEntry {
  path: string
  title: string
}

/**
 * 读取 dsh 的已知工作区清单（~/.dsh/storages/workspace.json 的
 * tables.workspaces 表）。面板默认视图据此合并所有工作区的项目技能；
 * 文件缺失/损坏时返回空清单（回退为仅用户级视图）。
 */
export async function workspaceEntries(home: string): Promise<WorkspaceEntry[]> {
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
export async function buildCatalog(deps: SkillHubRouteDeps, cwd?: string): Promise<CatalogResponse> {
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
export function toDetail(skill: SkillDefinition): SkillDetail {
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

/** What a route handler receives: fences already passed, URL/body prepared. */
export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  /** Request URL parsed against a localhost base (query reading for GET). */
  url: URL
  /** Parsed JSON body; empty object for requests without one. */
  body: Record<string, unknown>
}

export type RouteHandler = (context: RouteContext) => Promise<void>

/** One declarative route: path + accepted methods + the business handler. */
export interface RouteSpec {
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
 * Wrap one handler in the shared request fences. Order matches the
 * original per-handler prologue: loopback trust → HTTP method → master
 * switch → JSON body. The outer catch maps errors onto the JSON error
 * body (preserving RepoFetchError status codes).
 */
export function createRoute(deps: SkillHubRouteDeps, spec: RouteSpec): WebRoute {
  return {
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
  }
}
