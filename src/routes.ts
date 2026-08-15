/**
 * The /api/skill-hub route family: full catalog (enabled skills from the
 * official registry + hub-disabled skills + discovery diagnostics), skill
 * detail, enable/disable toggle, new-skill scaffold, user groups (tags +
 * origin collections), and upstream source tracking (check/sync/follow
 * upstream deletion into a restorable trash). Every route carries a
 * loopback-only trust fence — these endpoints rename files under the user's
 * skill roots, so LAN-exposed dsh web deployments must not serve them.
 */

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import {
  collectRepoSkillFiles,
  diffRemoteSkills,
  discoverRepoEntries,
  downloadRepoSkill,
  getLatestCommit,
  loadRepoTree,
  loadRepoTreeAt,
  normalizeRepoInput,
  repoSkillEntry,
  repoSlug,
  RepoFetchError,
  skillManifest,
} from './repo.ts'
import {
  SKILL_HUB_API,
  type CatalogResponse,
  type CatalogSkill,
  type CollectionGroup,
  type ConfigResponse,
  type RepoDiscoverResponse,
  type RepoImportRequest,
  type RepoImportResponse,
  type CreateRequest,
  type ErrorResponse,
  type GroupsResponse,
  type HubConfig,
  type MarketSourceRequest,
  type MarketSourceResponse,
  type MarketSourcesResponse,
  type SourceCheckRequest,
  type SourceCheckResponse,
  type SourceCheckResult,
  type SourceDeleteRequest,
  type SourceDeleteResponse,
  type SourceRestoreRequest,
  type SourceRestoreResponse,
  type SourcesResponse,
  type SourceSyncRequest,
  type SourceSyncResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type TagDeleteRequest,
  type TagDeleteResponse,
  type TagMembersRequest,
  type TagMembersResponse,
  type TagSaveRequest,
  type TagSaveResponse,
  type ToggleBatchRequest,
  type ToggleBatchResponse,
  type ToggleRequest,
  type ToggleResponse,
  type WritableRoot,
  HEX_COLOR_RE,
} from './protocol.ts'
import { createSkill, disableSkill, enableSkill, restoreSkill, rootOfPath, rootPath, scanDiagnostics, trashSkill } from './skillfs.ts'
import { checkLatestRelease } from './update.ts'
import { dshHome, type SkillHubStore } from './store.ts'
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

/** Repo helpers use HTTP-specific errors; preserve the status they carry. */
function writeRepoError(res: ServerResponse, error: unknown): void {
  if (error instanceof RepoFetchError) {
    writeError(res, error.status, error)
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
function isWritableSource(source: string): boolean {
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

/** The resolved hub config a route sees (defaults when the owner omits it). */
function configOf(deps: SkillHubRouteDeps): HubConfig {
  const config = deps.config?.() ?? {}
  return {
    enabled: true,
    announceToAgent: true,
    showUseCount: true,
    showUseTime: true,
    showSourceColumn: true,
    showGroupSummary: true,
    ...config,
  }
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

/** 系统集合组 + 用户 tag + origin 映射（groups 路由的数据源）。 */
async function buildGroups(deps: SkillHubRouteDeps): Promise<GroupsResponse> {
  const [tags, origins] = await Promise.all([deps.store.listTags(), deps.store.listOrigins()])
  const byCollection = new Map<string, string[]>()
  for (const [skillName, origin] of Object.entries(origins)) {
    const list = byCollection.get(origin)
    if (list === undefined) byCollection.set(origin, [skillName])
    else list.push(skillName)
  }
  const collections: CollectionGroup[] = [...byCollection.entries()]
    .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, tags, collections, origins }
}

/** 目录中存在的技能名集合（tag 成员校验用）：启用目录 ∪ 已禁用名单，避免成员因禁用而丢失。 */
async function knownSkillNames(deps: SkillHubRouteDeps): Promise<Set<string>> {
  const snapshot = await deps.skills.snapshot()
  const names = new Set(snapshot.skills.map((skill) => skill.name))
  for (const disabled of await deps.store.listDisabled()) names.add(disabled.name)
  return names
}

/** Build the full catalog response (shared by catalog/toggle/create handlers). */
async function buildCatalog(deps: SkillHubRouteDeps, cwd?: string): Promise<CatalogResponse> {
  const lookup = cwd !== undefined ? { cwd } : undefined
  const snapshot = await deps.skills.snapshot(lookup)
  const skills: CatalogSkill[] = snapshot.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    invocation: {
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    },
    source: skill.source,
    provider: skill.provider,
    writable: isWritableSource(skill.source),
  }))
  const disabled = await deps.store.listDisabled()
  const home = homeOf(deps)
  const diagnostics = [
    ...(await scanDiagnostics('user-dsh', home)),
    ...(await scanDiagnostics('user-agents', home)),
  ]
  return { ok: true, complete: snapshot.complete, skills, disabled, diagnostics }
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
    source: skill.source,
    provider: skill.provider,
    ...(skill.path !== undefined ? { path: skill.path } : {}),
    content: skill.content,
  }
}

/** Last successful check time per repo (in-memory throttle for GitHub rate limits). */
const lastSourceCheck = new Map<string, number>()

/** Replace one skill directory with a fresh download; restores the old dir on failure. */
async function replaceSkillDir(targetDir: string, download: () => Promise<void>): Promise<void> {
  const backup = targetDir + '.sync-bak-' + Date.now()
  await rename(targetDir, backup)
  try {
    await download()
  } catch (error) {
    await rename(backup, targetDir).catch(() => {})
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

/**
 * Build every /api/skill-hub route.
 * @param deps - skill registry view + sidecar store.
 * @returns the exact-path routes.
 */
export function makeRoutes(deps: SkillHubRouteDeps): WebRoute[] {
  return [
    // ------------------------------------------------------------ catalog
    {
      kind: 'exact',
      path: SKILL_HUB_API.catalog,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const cwd = queryParam(url, 'cwd')
          writeJson(res, 200, await buildCatalog(deps, cwd))
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // -------------------------------------------------------------- detail
    {
      kind: 'exact',
      path: SKILL_HUB_API.skill,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const name = queryParam(url, 'name')
        if (name === undefined || name === '') { writeError(res, 400, 'name query parameter is required'); return }
        const cwd = queryParam(url, 'cwd')
        try {
          const skill = await deps.skills.get(name, cwd !== undefined ? { cwd } : undefined)
          if (skill === undefined) { writeError(res, 404, 'skill not found: ' + name); return }
          writeJson(res, 200, { ok: true, skill: toDetail(skill) } satisfies SkillDetailResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // -------------------------------------------------------------- toggle
    {
      kind: 'exact',
      path: SKILL_HUB_API.toggle,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as ToggleRequest & { cwd?: string }
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const lookup = typeof request.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : undefined
        try {
          if (request.enabled === true) {
            const record = await deps.store.getDisabled(name)
            if (record === undefined) { writeError(res, 404, 'skill is not hub-disabled: ' + name); return }
            await enableSkill(record.path)
            await deps.store.removeDisabled(name)
          } else {
            const skill = await deps.skills.get(name, lookup)
            if (skill === undefined) { writeError(res, 404, 'skill not found: ' + name); return }
            if (!isWritableSource(skill.source)) {
              writeError(res, 409, 'source "' + skill.source + '" is managed outside the hub (read-only)')
              return
            }
            if (skill.path === undefined) {
              writeError(res, 409, 'provider-managed skill has no writable file')
              return
            }
            const root = rootOfPath(skill.path, homeOf(deps))
            if (root === undefined) {
              writeError(res, 409, 'skill path is outside the hub writable roots')
              return
            }
            const disabledPath = await disableSkill(skill.path)
            await deps.store.addDisabled({
              name,
              description: skill.description,
              path: disabledPath,
              root,
              disabledAt: Date.now(),
            })
          }
          deps.invalidate?.()
          writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd) } satisfies ToggleResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // -------------------------------------------------------- toggle-batch
    // One write for a whole group: enables every hub-disabled name, or
    // disables every writable name. Skips already-target states as no-ops;
    // per-name failures are reported, never fatal.
    {
      kind: 'exact',
      path: SKILL_HUB_API.toggleBatch,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as ToggleBatchRequest & { cwd?: string }
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
              const skill = await deps.skills.get(name, lookup)
              if (skill === undefined) { failures.push({ name, error: 'skill not found' }); continue }
              if (!isWritableSource(skill.source)) { failures.push({ name, error: 'source "' + skill.source + '" is read-only' }); continue }
              if (skill.path === undefined) { failures.push({ name, error: 'provider-managed skill has no writable file' }); continue }
              const root = rootOfPath(skill.path, homeOf(deps))
              if (root === undefined) { failures.push({ name, error: 'skill path is outside the hub writable roots' }); continue }
              const disabledPath = await disableSkill(skill.path)
              await deps.store.addDisabled({ name, description: skill.description, path: disabledPath, root, disabledAt: Date.now() })
            }
          } catch (error) {
            failures.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd), failures } satisfies ToggleBatchResponse)
      },
    },
    // -------------------------------------------------------------- create
    {
      kind: 'exact',
      path: SKILL_HUB_API.create,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as CreateRequest
        const name = typeof request.name === 'string' ? request.name.trim() : ''
        if (!isSkillName(name)) { writeError(res, 400, 'skill name must be kebab-case (lowercase letters, digits, dashes)'); return }
        const root: WritableRoot = request.root ?? 'user-dsh'
        if (root !== 'user-dsh' && root !== 'user-agents') { writeError(res, 400, 'root must be user-dsh or user-agents'); return }
        try {
          const existing = await deps.skills.get(name)
          if (existing !== undefined) { writeError(res, 409, 'skill name already exists: ' + name); return }
          if (await deps.store.getDisabled(name) !== undefined) { writeError(res, 409, 'skill name is disabled: re-enable it from the disabled list first'); return }
          const path = await createSkill(root, name, typeof request.description === 'string' ? request.description : '', homeOf(deps))
          deps.invalidate?.()
          writeJson(res, 201, { ok: true, path, root } satisfies import('./protocol.ts').CreateResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ---------------------------------------------------------------- stats
    {
      kind: 'exact',
      path: SKILL_HUB_API.stats,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        if (deps.stats === undefined) {
          writeJson(res, 200, { ok: true, available: false, stats: [] } satisfies import('./protocol.ts').StatsResponse)
          return
        }
        try {
          const stats = await deps.stats()
          writeJson(res, 200, { ok: true, available: true, stats } satisfies import('./protocol.ts').StatsResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // --------------------------------------------------------------- config
    // The config route stays mounted even with the master switch off, so the
    // settings card can always read and re-enable the hub.
    {
      kind: 'exact',
      path: SKILL_HUB_API.config,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, config: configOf(deps), saved: savedOf(deps) } satisfies ConfigResponse)
          return
        }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
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
        for (const key of ['showUseCount', 'showUseTime', 'showSourceColumn', 'showGroupSummary'] as const) {
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
          try {
            config = await deps.updateConfig(patch)
          } catch (error) {
            writeError(res, 500, error)
            return
          }
        }
        writeJson(res, 200, { ok: true, config, saved: savedOf(deps) } satisfies ConfigResponse)
      },
    },
    // --------------------------------------------------------------- market
    // Codex-style market sources: the user adds repo slugs; each source can
    // be scanned through /repo and imported through /repo/import.
    {
      kind: 'exact',
      path: SKILL_HUB_API.market,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        try {
          writeJson(res, 200, { ok: true, repos: await deps.store.listMarketSources() } satisfies MarketSourcesResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    {
      kind: 'exact',
      path: SKILL_HUB_API.marketSource,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as MarketSourceRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        try {
          writeJson(res, 200, { ok: true, repos: await deps.store.addMarketSource(repoSlug(parsed)) } satisfies MarketSourceResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    {
      kind: 'exact',
      path: SKILL_HUB_API.marketSourceDelete,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as MarketSourceRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        try {
          writeJson(res, 200, { ok: true, repos: await deps.store.removeMarketSource(repoSlug(parsed)) } satisfies MarketSourceResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ---------------------------------------------------------------- repo
    // Discover importable skills in a public GitHub repo (skills/ + design-templates/).
    {
      kind: 'exact',
      path: SKILL_HUB_API.repo,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const input = queryParam(url, 'repo') ?? ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        try {
          const { ref, tree } = await loadRepoTree(repo)
          const existing = await knownSkillNames(deps)
          const entries = discoverRepoEntries(tree, repo, existing)
          writeJson(res, 200, { ok: true, repo, ref, entries } satisfies RepoDiscoverResponse)
        } catch (error) {
          writeRepoError(res, error)
        }
      },
    },
    // ----------------------------------------------------------- repo/import
    // Install selected repo skills, preserving full skill directories and
    // recording the upstream source (repo + commit snapshot + manifest) so
    // they form one tracked collection group.
    {
      kind: 'exact',
      path: SKILL_HUB_API.repoImport,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as RepoImportRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const paths = Array.isArray(request.paths) ? request.paths.filter((path): path is string => typeof path === 'string' && path !== '') : []
        if (paths.length === 0) { writeError(res, 400, 'paths must be a non-empty array'); return }
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        try {
          const { ref, tree } = await loadRepoTree(repo)
          const existing = await knownSkillNames(deps)
          const entries = discoverRepoEntries(tree, repo, existing)
          const byPath = new Map(entries.map((entry) => [entry.path, entry]))
          const selected = paths.map((path) => byPath.get(path)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
          if (selected.length > 500) { writeError(res, 400, 'select at most 500 skills per import'); return }
          const totalBytes = selected.reduce((sum, entry) => sum + entry.totalBytes, 0)
          if (totalBytes > 200 * 1024 * 1024) { writeError(res, 400, 'selected skills exceed the 200MB import limit'); return }

          // Snapshot the upstream commit for the source record (best-effort:
          // a failure still imports, just with an unverified snapshot).
          let commitSha = ''
          try {
            const latest = await getLatestCommit(repo, parsed.ref)
            commitSha = latest.commitSha
          } catch {
            // source record keeps an empty snapshot; first check backfills it
          }

          const imported: RepoImportResponse['imported'] = []
          const skipped: RepoImportResponse['skipped'] = []
          const failed: RepoImportResponse['failed'] = []
          const targetRoot = rootPath('user-dsh', homeOf(deps))
          await mkdir(targetRoot, { recursive: true })
          for (const entry of selected) {
            if (entry.existing) {
              skipped.push({ name: entry.name, reason: 'exists' })
              continue
            }
            if (await pathExists(join(targetRoot, entry.name))) {
              skipped.push({ name: entry.name, reason: 'exists' })
              continue
            }
            const files = collectRepoSkillFiles(tree, entry.dir)
            try {
              const result = await downloadRepoSkill(repo, ref, entry, files, targetRoot)
              await deps.store.addSourceSkill(repo, entry.root, commitSha, parsed.ref, entry.name)
              await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir))
              imported.push({ name: entry.name, origin: entry.origin, path: result.skillPath })
            } catch (error) {
              failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
            }
          }
          deps.invalidate?.()
          writeJson(res, 200, { ok: true, imported, skipped, failed } satisfies RepoImportResponse)
        } catch (error) {
          writeRepoError(res, error)
        }
      },
    },
    // -------------------------------------------------------------- update
    // 自身更新检查：查询 GitHub latest release（语义同 cc-switch 的检查更新）。
    {
      kind: 'exact',
      path: SKILL_HUB_API.update,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        try {
          writeJson(res, 200, await checkLatestRelease())
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // -------------------------------------------------------------- groups
    // 用户 tag 分组 + 系统集合组 + origin 映射（前端分组栏的数据源）。
    {
      kind: 'exact',
      path: SKILL_HUB_API.groups,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        try {
          writeJson(res, 200, await buildGroups(deps))
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ----------------------------------------------------------------- tag
    // 新建（缺省 id）或重命名（带 id）一个用户 tag 分组。
    {
      kind: 'exact',
      path: SKILL_HUB_API.tag,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const name = typeof raw.name === 'string' ? raw.name.trim() : ''
        if (name === '') { writeError(res, 400, 'tag name is required'); return }
        const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined
        try {
          await deps.store.saveTag({ id, name })
          writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagSaveResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ----------------------------------------------------------- tag/delete
    {
      kind: 'exact',
      path: SKILL_HUB_API.tagDelete,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const id = typeof (raw as unknown as TagDeleteRequest).id === 'string' ? (raw as unknown as TagDeleteRequest).id : ''
        if (id === '') { writeError(res, 400, 'tag id is required'); return }
        try {
          await deps.store.deleteTag(id)
          writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagDeleteResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ---------------------------------------------------------- tag/members
    // 直接设置某 tag 的完整成员列表；后端只保留目录中实际存在的技能名。
    {
      kind: 'exact',
      path: SKILL_HUB_API.tagMembers,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as TagMembersRequest
        const id = typeof request.id === 'string' ? request.id : ''
        if (id === '') { writeError(res, 400, 'tag id is required'); return }
        const names = Array.isArray(request.skillNames) ? request.skillNames.filter((n): n is string => typeof n === 'string') : []
        try {
          const known = await knownSkillNames(deps)
          const saved = await deps.store.setTagMembers(id, names.filter((n) => known.has(n)))
          if (saved === undefined) { writeError(res, 404, 'tag not found: ' + id); return }
          writeJson(res, 200, { ok: true, tags: await deps.store.listTags() } satisfies TagMembersResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ------------------------------------------------------------- sources
    // 来源列表 + 派生 origin 映射 + 集合组 + 回收站。
    {
      kind: 'exact',
      path: SKILL_HUB_API.sources,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        try {
          const [sources, origins, trash] = await Promise.all([deps.store.listSources(), deps.store.listOrigins(), deps.store.listTrash()])
          const byCollection = new Map<string, string[]>()
          for (const [skillName, origin] of Object.entries(origins)) {
            const list = byCollection.get(origin)
            if (list === undefined) byCollection.set(origin, [skillName])
            else list.push(skillName)
          }
          const collections: CollectionGroup[] = [...byCollection.entries()]
            .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
            .sort((a, b) => a.name.localeCompare(b.name))
          writeJson(res, 200, { ok: true, sources, origins, collections, trash } satisfies SourcesResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // -------------------------------------------------------- sources/check
    // 检查指定（或全部）来源的上游更新。每个来源最多 1 次 commit 请求；
    // 仅当 commit 变化时再拉一次 tree 做逐技能差异。5 分钟节流。
    {
      kind: 'exact',
      path: SKILL_HUB_API.sourceCheck,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as SourceCheckRequest
        const only = typeof request.repo === 'string' && request.repo !== '' ? request.repo : undefined
        try {
          const sources = only !== undefined
            ? (await deps.store.getSource(only)) !== undefined ? [await deps.store.getSource(only) as NonNullable<Awaited<ReturnType<SkillHubStore['getSource']>>>] : []
            : await deps.store.listSources()
          if (only !== undefined && sources.length === 0) { writeError(res, 404, 'source not found: ' + only); return }
          const results: SourceCheckResult[] = []
          for (const source of sources) {
            const base = { repo: source.repo, ...(source.ref !== undefined ? { ref: source.ref } : {}) }
            const now = Date.now()
            const last = lastSourceCheck.get(source.repo) ?? 0
            if (now - last < MIN_CHECK_INTERVAL_MS) {
              results.push({ ...base, changed: false, updated: [], deleted: [], throttled: true })
              continue
            }
            try {
              const latest = await getLatestCommit(source.repo, source.ref)
              lastSourceCheck.set(source.repo, now)
              if (latest.commitSha === source.commitSha) {
                results.push({ ...base, changed: false, updated: [], deleted: [] })
                continue
              }
              const tree = await loadRepoTreeAt(source.repo, latest.treeSha)
              const diff = diffRemoteSkills(tree, source)
              results.push({ ...base, changed: true, commitSha: latest.commitSha, updated: diff.updated, deleted: diff.deleted })
            } catch (error) {
              results.push({ ...base, changed: false, updated: [], deleted: [], error: error instanceof Error ? error.message : String(error) })
            }
          }
          writeJson(res, 200, { ok: true, results } satisfies SourceCheckResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // --------------------------------------------------------- sources/sync
    // 按上游重新下载所选（或全部）技能并更新 commit 快照与 manifest。
    {
      kind: 'exact',
      path: SKILL_HUB_API.sourceSync,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as SourceSyncRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        const selected = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : undefined
        try {
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
            try {
              const entry = repoSkillEntry(name, source.root, repo)
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
              await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir))
              synced.push(name)
            } catch (error) {
              failed.push({ name, error: error instanceof Error ? error.message : String(error) })
            }
          }
          await deps.store.setSourceCommit(repo, latest.commitSha)
          deps.invalidate?.()
          writeJson(res, 200, { ok: true, repo, commitSha: latest.commitSha, synced, failed } satisfies SourceSyncResponse)
        } catch (error) {
          writeRepoError(res, error)
        }
      },
    },
    // ------------------------------------------------------- sources/delete
    // 跟进上游删除：把所选技能的本地目录移入回收站（可恢复）。
    {
      kind: 'exact',
      path: SKILL_HUB_API.sourceDelete,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as SourceDeleteRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        const skills = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : []
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        if (skills.length === 0) { writeError(res, 400, 'skills must be a non-empty array'); return }
        try {
          const source = await deps.store.getSource(repo)
          if (source === undefined) { writeError(res, 404, 'source not found: ' + repo); return }
          const home = homeOf(deps)
          const trashed: string[] = []
          const failed: Array<{ name: string; error: string }> = []
          for (const name of skills) {
            if (!await pathExists(join(rootPath('user-dsh', home), name))) {
              failed.push({ name, error: 'skill directory not found' })
              continue
            }
            try {
              const path = await trashSkill(name, 'user-dsh', home)
              await deps.store.addTrash({ name, path, movedAt: Date.now() })
              await deps.store.removeDisabled(name)
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
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ------------------------------------------------------ sources/restore
    // 从回收站恢复一个技能目录。
    {
      kind: 'exact',
      path: SKILL_HUB_API.sourceRestore,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as SourceRestoreRequest
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        try {
          const entry = await deps.store.getTrash(name)
          if (entry === undefined) { writeError(res, 404, 'trash entry not found: ' + name); return }
          const home = homeOf(deps)
          if (await pathExists(join(rootPath('user-dsh', home), name))) {
            writeError(res, 409, 'skill directory already exists: ' + name)
            return
          }
          const path = await restoreSkill(entry, home)
          await deps.store.removeTrash(name)
          deps.invalidate?.()
          writeJson(res, 200, { ok: true, name, path } satisfies SourceRestoreResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
  ]
}

