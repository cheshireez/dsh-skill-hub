/**
 * Shared API contract for dsh-skill-hub: the route paths and payload shapes
 * both the host half and the browser half import. The browser half must never
 * depend on host SDK packages, so registry types are re-spelled here as
 * plain JSON-safe interfaces.
 */

/** Browser-facing base paths of the skill-hub API family. */
export const SKILL_HUB_API = {
  catalog: '/api/skill-hub/catalog',
  skill: '/api/skill-hub/skill',
  toggle: '/api/skill-hub/toggle',
  create: '/api/skill-hub/create',
  stats: '/api/skill-hub/stats',
} as const

/** User-level roots the hub may write to (matches dsh-skill-filesystem ranks 400/500). */
export type WritableRoot = 'user-dsh' | 'user-agents'

/** Invocation policy resolved by the registry, re-spelled for the wire. */
export interface HubInvocation {
  /** Whether model-facing catalogs may load this skill. */
  modelInvocable: boolean
  /** Whether human-facing command catalogs may load this skill. */
  userInvocable: boolean
}

/** One enabled skill row in the catalog. */
export interface CatalogSkill {
  name: string
  description: string
  whenToUse?: string
  /** Optional group names declared in the skill's frontmatter (`sets`). */
  sets?: string[]
  invocation: HubInvocation
  source: string
  provider: string
  /** Whether the hub may toggle this skill (user-level filesystem skills only). */
  writable: boolean
}

/** One disabled skill tracked by the hub sidecar (SKILL.md renamed away). */
export interface DisabledSkill {
  name: string
  description: string
  /** Absolute path of the renamed file (SKILL.md.disabled / <name>.md.disabled). */
  path: string
  root: WritableRoot
  disabledAt: number
}

/** One discovery diagnostic: a file the filesystem provider skips, with the reason. */
export interface DiagnosticEntry {
  path: string
  root: string
  reason: string
}

/** GET /api/skill-hub/catalog */
export interface CatalogResponse {
  ok: true
  /** Whether discovery completed within a stable catalog revision. */
  complete: boolean
  /** Sorted winning summaries of every enabled skill (all roots + providers). */
  skills: CatalogSkill[]
  /** Skills the hub has toggled off (kept outside provider discovery). */
  disabled: DisabledSkill[]
  /** Files in the writable roots the provider ignores, with reasons. */
  diagnostics: DiagnosticEntry[]
}

/** GET /api/skill-hub/skill */
export interface SkillDetail {
  name: string
  description: string
  whenToUse?: string
  /** Optional group names declared in the skill's frontmatter (`sets`). */
  sets?: string[]
  invocation: HubInvocation
  source: string
  provider: string
  /** Absolute file path when the skill came from disk. */
  path?: string
  /** Markdown instruction body. */
  content: string
}

export interface SkillDetailResponse {
  ok: true
  skill: SkillDetail
}

/** POST /api/skill-hub/toggle */
export interface ToggleRequest {
  /** Kebab-case skill name. */
  name: string
  /** true re-enables a hub-disabled skill; false disables an enabled one. */
  enabled: boolean
}

export interface ToggleResponse {
  ok: true
  /** Fresh catalog after the mutation (the filesystem provider may lag a beat). */
  catalog: CatalogResponse
}

/** POST /api/skill-hub/create */
export interface CreateRequest {
  /** Kebab-case skill name (validated with the official isSkillName grammar). */
  name: string
  /** Optional one-line routing description for the frontmatter. */
  description?: string
  /** Target user root; defaults to user-dsh (~/.dsh/skills). */
  root?: WritableRoot
}

export interface CreateResponse {
  ok: true
  path: string
  root: WritableRoot
}

/** One skill's invocation count across the local session logs. */
export interface SkillStat {
  /** Kebab-case skill name. */
  name: string
  /** How many sessions recorded a user-explicit invocation of this skill. */
  count: number
}

/** GET /api/skill-hub/stats */
export interface StatsResponse {
  ok: true
  /** Whether a session-log source was available (false means counts are empty). */
  available: boolean
  /** Sorted per-skill invocation counts. */
  stats: SkillStat[]
}

/** JSON error body shared by every route. */
export interface ErrorResponse {
  error: string
}
