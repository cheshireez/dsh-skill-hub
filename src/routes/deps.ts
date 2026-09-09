/**
 * routes 共享层 · 依赖视图：路由依赖接口、配置解析与可写技能解析（HTTP
 * 围栏在 ./http.ts）。从 helpers.ts 原样搬出，行为不变。
 */

import type { ServerResponse } from 'node:http'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { resolveHubConfig, type HubConfig, type WritableRoot } from '../protocol.ts'
import { rootOfPath } from '../skillfs.ts'
import { dshHome, type SkillHubStore } from '../store.ts'
import { writeError } from './http.ts'

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
