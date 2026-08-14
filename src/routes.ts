/**
 * The /api/skill-hub route family: full catalog (enabled skills from the
 * official registry + hub-disabled skills + discovery diagnostics), skill
 * detail, enable/disable toggle, and new-skill scaffold. Every route
 * carries a loopback-only trust fence — these endpoints rename files under
 * the user's skill roots, so LAN-exposed dsh web deployments must not
 * serve them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import {
  SKILL_HUB_API,
  type CatalogResponse,
  type CatalogSkill,
  type CreateRequest,
  type ErrorResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type ToggleRequest,
  type ToggleResponse,
  type WritableRoot,
} from './protocol.ts'
import { createSkill, disableSkill, enableSkill, normalizeSets, rootOfPath, scanDiagnostics } from './skillfs.ts'
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
}

/** Resolve the home used for writable-root operations. */
function homeOf(deps: SkillHubRouteDeps): string {
  return deps.home ?? dshHome()
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
    // -------------------------------------------------------------- create
    {
      kind: 'exact',
      path: SKILL_HUB_API.create,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeError(res, 403, 'forbidden: loopback-only'); return }
        if (req.method !== 'POST') { writeError(res, 405, 'method not allowed: ' + (req.method ?? '')); return }
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
  ]
}

