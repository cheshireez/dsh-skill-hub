/**
 * The /api/skill-hub route family: full catalog (enabled skills from the
 * official registry + hub-disabled skills + discovery diagnostics), skill
 * detail, enable/disable toggle, and new-skill scaffold. Every route
 * carries a loopback-only trust fence — these endpoints rename files under
 * the user's skill roots, so LAN-exposed dsh web deployments must not
 * serve them.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { collectRepoSkillFiles, discoverRepoEntries, downloadRepoSkill, loadRepoTree, normalizeRepoInput, repoSlug, RepoFetchError } from './repo.ts'
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
  type ImportResponse,
  type MarketResponse,
  type MarketRow,
  type OriginRequest,
  type OriginResponse,
  type SceneDeleteRequest,
  type SceneDeleteResponse,
  type SceneMembersRequest,
  type SceneMembersResponse,
  type SceneSaveRequest,
  type SceneSaveResponse,
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
import { createSkill, disableSkill, enableSkill, normalizeSets, parseFrontmatter, rootOfPath, rootPath, scanDiagnostics } from './skillfs.ts'
import { MARKET, marketEntry } from './market.ts'
import { checkLatestRelease } from './update.ts'
import { dshHome, type SkillHubStore } from './store.ts'
import type { SkillStatsReader } from './stats.ts'

/** Cap on JSON request bodies (toggle/create payloads are tiny). */
const MAX_JSON_BODY_BYTES = 64 * 1024

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

/** Async existence check (import/market use it on the user root). */
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
  return deps.config?.() ?? { enabled: true, announceToAgent: true }
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

/** 系统集合组 + 用户 tag + origin 映射（groups/origin 路由共用）。 */
async function buildGroups(deps: SkillHubRouteDeps): Promise<GroupsResponse> {
  const [tags, origins, scenes] = await Promise.all([deps.store.listTags(), deps.store.listOrigins(), deps.store.listScenes()])
  const byCollection = new Map<string, string[]>()
  for (const [skillName, origin] of Object.entries(origins)) {
    const list = byCollection.get(origin)
    if (list === undefined) byCollection.set(origin, [skillName])
    else list.push(skillName)
  }
  const collections: CollectionGroup[] = [...byCollection.entries()]
    .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, tags, collections, origins, scenes }
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
  // The registry's snapshot() yields metadata-less SkillSummary rows; a skill's
  // `sets` live on its SkillDefinition.metadata, so enrich each row through a
  // per-name get(). Local catalogs are small and the registry caches completed
  // collections, so the per-skill file read is cheap.
  const skills: CatalogSkill[] = await Promise.all(snapshot.skills.map(async (skill) => {
    const sets = await readSets(deps, skill.name, lookup)
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      ...(sets !== undefined ? { sets } : {}),
      invocation: {
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
      },
      source: skill.source,
      provider: skill.provider,
      writable: isWritableSource(skill.source),
    }
  }))
  const disabled = await deps.store.listDisabled()
  const home = homeOf(deps)
  const diagnostics = [
    ...(await scanDiagnostics('user-dsh', home)),
    ...(await scanDiagnostics('user-agents', home)),
  ]
  return { ok: true, complete: snapshot.complete, skills, disabled, diagnostics }
}

/** Read one skill's normalized `sets` (undefined when absent, unreadable, or empty). */
async function readSets(deps: SkillHubRouteDeps, name: string, lookup: SkillLookupLike | undefined): Promise<string[] | undefined> {
  try {
    const definition = await deps.skills.get(name, lookup)
    return normalizeSets(definition?.metadata?.sets)
  } catch {
    return undefined // a provider that cannot resolve keeps the row uncategorized
  }
}

/** Map a loaded definition onto the wire shape. */
function toDetail(skill: SkillDefinition): SkillDetail {
  const sets = normalizeSets(skill.metadata?.sets)
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    ...(sets !== undefined ? { sets } : {}),
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
          const body: SkillDetailResponse = { ok: true, skill: toDetail(skill) }
          writeJson(res, 200, body)
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
          const body: ToggleResponse = { ok: true, catalog: await buildCatalog(deps, lookup?.cwd) }
          writeJson(res, 200, body)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // -------------------------------------------------------- toggle-batch
    // One write for a whole group (Set/source row): enables every hub-disabled
    // name, or disables every writable name. Skips already-target states as
    // no-ops; per-name failures are reported, never fatal.
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
        const body: ToggleBatchResponse = { ok: true, catalog: await buildCatalog(deps, lookup?.cwd), failures }
        writeJson(res, 200, body)
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
    // settings card can always read and re-enable the hub (a card that only
    // lives while the plugin is on could never turn it back on).
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
        // Build the store patch: `null` encodes "clear the saved override"
        // (the web card's reset), which the store represents as `undefined`.
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
          // No owner: merge in-memory, treating undefined values as clears.
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
    {
      kind: 'exact',
      path: SKILL_HUB_API.market,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'GET') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const home = homeOf(deps)
        const entries: MarketRow[] = []
        for (const entry of MARKET) {
          entries.push({ name: entry.name, description: entry.description, repo: entry.repo, installed: await pathExists(join(rootPath('user-dsh', home), entry.name)) })
        }
        writeJson(res, 200, { ok: true, entries } satisfies MarketResponse)
      },
    },
    // ---------------------------------------------------------------- import
    // One-click install of a market skill: download its SKILL.md from GitHub
    // raw, validate frontmatter, and write it into the user-dsh root. Only
    // curated market names are accepted (no arbitrary URL downloads).
    {
      kind: 'exact',
      path: SKILL_HUB_API.importSkill,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const name = typeof raw.name === 'string' ? raw.name.trim() : ''
        const entry = marketEntry(name)
        if (entry === undefined) { writeError(res, 400, 'unknown market skill: ' + name); return }
        const home = homeOf(deps)
        const targetDir = join(rootPath('user-dsh', home), entry.name)
        if (await pathExists(targetDir)) { writeError(res, 409, 'skill already installed: ' + entry.name); return }
        const url = 'https://raw.githubusercontent.com/' + entry.repo + '/HEAD/' + entry.path
        let response: Response
        try {
          response = await fetch(url)
        } catch (error) {
          writeError(res, 502, 'download failed: ' + (error instanceof Error ? error.message : String(error)))
          return
        }
        if (!response.ok) {
          writeError(res, 502, 'download failed (HTTP ' + response.status + ')')
          return
        }
        let text: string
        try {
          text = await response.text()
        } catch (error) {
          writeError(res, 502, 'download read failed: ' + (error instanceof Error ? error.message : String(error)))
          return
        }
        const parsed = parseFrontmatter(text)
        if ('error' in parsed) { writeError(res, 422, 'downloaded skill rejected: ' + parsed.error); return }
        if (parsed.value.name !== entry.name) {
          writeError(res, 422, 'downloaded skill declares name "' + parsed.value.name + '", expected "' + entry.name + '"')
          return
        }
        try {
          await mkdir(targetDir, { recursive: true })
          await writeFile(join(targetDir, 'SKILL.md'), text)
        } catch (error) {
          writeError(res, 500, error)
          return
        }
        // 记录来源集合（系统默认聚合的依据）：本市场技能统一归属其仓库。
        try {
          await deps.store.setOrigin(entry.name, entry.repo)
        } catch (error) {
          console.warn('[dsh-skill-hub] failed to record import origin:', error instanceof Error ? error.message : error)
        }
        deps.invalidate?.()
        writeJson(res, 201, { ok: true, name: entry.name, path: targetDir } satisfies ImportResponse)
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
    // recording origin so they appear as one collection group.
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

          const imported: RepoImportResponse['imported'] = []
          const skipped: RepoImportResponse['skipped'] = []
          const failed: RepoImportResponse['failed'] = []
          const targetRoot = rootPath('user-dsh', homeOf(deps))
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
              await deps.store.setOrigin(entry.name, entry.origin)
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
    // --------------------------------------------------------------- origin
    // 手动标记/清除某技能归属的集合（系统默认聚合的数据源）。
    {
      kind: 'exact',
      path: SKILL_HUB_API.origin,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as OriginRequest
        const skillName = typeof request.skillName === 'string' ? request.skillName : ''
        if (skillName === '') { writeError(res, 400, 'skillName is required'); return }
        const origin = request.origin === null || request.origin === undefined ? null : typeof request.origin === 'string' ? request.origin.trim() : ''
        if (origin === '') { writeError(res, 400, 'origin must be a non-empty string or null'); return }
        try {
          await deps.store.setOrigin(skillName, origin)
          const groups = await buildGroups(deps)
          writeJson(res, 200, { ok: true, origins: groups.origins, collections: groups.collections } satisfies OriginResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ---------------------------------------------------------------- scene
    // User-defined one-click enable/disable presets (like tags, different role).
    {
      kind: 'exact',
      path: SKILL_HUB_API.scene,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as SceneSaveRequest
        const name = typeof request.name === 'string' ? request.name.trim() : ''
        if (name === '') { writeError(res, 400, 'scene name is required'); return }
        const id = typeof request.id === 'string' && request.id !== '' ? request.id : undefined
        try {
          await deps.store.saveScene({ id, name })
          writeJson(res, 200, { ok: true, scenes: await deps.store.listScenes() } satisfies SceneSaveResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ------------------------------------------------------ scene/delete
    {
      kind: 'exact',
      path: SKILL_HUB_API.sceneDelete,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as SceneDeleteRequest
        const id = typeof request.id === 'string' ? request.id : ''
        if (id === '') { writeError(res, 400, 'scene id is required'); return }
        try {
          await deps.store.deleteScene(id)
          writeJson(res, 200, { ok: true, scenes: await deps.store.listScenes() } satisfies SceneDeleteResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
    // ---------------------------------------------------- scene/members
    {
      kind: 'exact',
      path: SKILL_HUB_API.sceneMembers,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
        if (disabledGate(deps, res)) return
        const raw = await readJsonBody(req)
        if (raw === undefined) { writeError(res, 400, 'invalid JSON body'); return }
        const request = raw as unknown as SceneMembersRequest
        const id = typeof request.id === 'string' ? request.id : ''
        if (id === '') { writeError(res, 400, 'scene id is required'); return }
        const names = Array.isArray(request.skillNames) ? request.skillNames.filter((n): n is string => typeof n === 'string') : []
        try {
          const known = await knownSkillNames(deps)
          const saved = await deps.store.setSceneMembers(id, names.filter((n) => known.has(n)))
          if (saved === undefined) { writeError(res, 404, 'scene not found: ' + id); return }
          writeJson(res, 200, { ok: true, scenes: await deps.store.listScenes() } satisfies SceneMembersResponse)
        } catch (error) {
          writeError(res, 500, error)
        }
      },
    },
  ]
}
