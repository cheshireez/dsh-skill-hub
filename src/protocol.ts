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
  toggleBatch: '/api/skill-hub/toggle-batch',
  create: '/api/skill-hub/create',
  stats: '/api/skill-hub/stats',
  config: '/api/skill-hub/config',
  market: '/api/skill-hub/market',
  importSkill: '/api/skill-hub/import',
  repo: '/api/skill-hub/repo',
  repoImport: '/api/skill-hub/repo/import',
  update: '/api/skill-hub/update',
  groups: '/api/skill-hub/groups',
  tag: '/api/skill-hub/tag',
  tagDelete: '/api/skill-hub/tag/delete',
  tagMembers: '/api/skill-hub/tag/members',
  origin: '/api/skill-hub/origin',
  scene: '/api/skill-hub/scene',
  sceneDelete: '/api/skill-hub/scene/delete',
  sceneMembers: '/api/skill-hub/scene/members',
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

/** POST /api/skill-hub/toggle-batch — one group of skills, one write. */
export interface ToggleBatchRequest {
  names: string[]
  enabled: boolean
}

/** POST /api/skill-hub/toggle-batch */
export interface ToggleBatchResponse {
  ok: true
  catalog: CatalogResponse
  /** Per-name failures (unknown/read-only skills); empty means all landed. */
  failures: Array<{ name: string; error: string }>
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

/** One skill's invocation stats across the local session logs. */
export interface SkillStat {
  /** Kebab-case skill name. */
  name: string
  /** How many sessions recorded a user-explicit invocation of this skill. */
  count: number
  /** Unix epoch ms of the most recent invocation (absent when never called). */
  lastUsed?: number
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

/** The skill hub's own runtime configuration, edited from the settings card. */
export interface HubConfig {
  /** Master switch: routes, provider, and announcement all go live with this. */
  enabled: boolean
  /** When true, a system-prompt section announces the hub to every agent. */
  announceToAgent: boolean
  /** Model-invocable dot color (#rrggbb); absent means the panel default. */
  dotModelColor?: string
  /** User-invocable dot color (#rrggbb); absent means the panel default. */
  dotUserColor?: string
  /** Show per-skill invocation count chip. Default true. */
  showUseCount?: boolean
  /** Show per-skill last-used relative time. Default true. */
  showUseTime?: boolean
  /** Show the per-source column on rows. Default true. */
  showSourceColumn?: boolean
  /** Show group-header usage summaries (count + last used). Default true. */
  showGroupSummary?: boolean
}

/** HEX color validation shared by host routes and the settings card. */
export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

/** GET /api/skill-hub/config */
export interface ConfigResponse {
  ok: true
  /** Effective configuration (saved overrides merged over the defaults). */
  config: HubConfig
  /** Raw user overrides persisted in the sidecar (absent fields inherit defaults). */
  saved: Partial<HubConfig>
}

/** POST /api/skill-hub/config — a partial patch; omitted fields keep their values. */
export interface ConfigRequest {
  /** Set the field; null clears the saved override so it re-inherits the default. */
  enabled?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  announceToAgent?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showUseCount?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showUseTime?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showSourceColumn?: boolean | null
  /** Set the field; null clears the saved override so it re-inherits the default. */
  showGroupSummary?: boolean | null
}

/** One market row as the GUI renders it (installed flag from the local root). */
export interface MarketRow {
  name: string
  description: string
  repo: string
  /** Whether a skill with this name is already installed in the user root. */
  installed: boolean
}

/** GET /api/skill-hub/market */
export interface MarketResponse {
  ok: true
  entries: MarketRow[]
}

/** POST /api/skill-hub/import — install one market skill by name. */
export interface ImportRequest {
  name: string
}

/** POST /api/skill-hub/import */
export interface ImportResponse {
  ok: true
  name: string
  path: string
}

/** A skill discovered in a GitHub repo under skills/ or design-templates/. */
export interface RepoSkillEntry {
  /** Kebab-case skill name (directory basename). */
  name: string
  /** Root-relative skill directory, e.g. skills/code-review. */
  dir: string
  /** Root-relative SKILL.md path, e.g. skills/code-review/SKILL.md. */
  path: string
  /** Repo root the skill lives in. */
  root: RepoRoot
  /** Collection name recorded as origin after import. */
  origin: string
  /** Number of files in the skill directory. */
  fileCount: number
  /** Total bytes across all files in the skill directory. */
  totalBytes: number
  /** Whether a same-named skill already exists locally. */
  existing: boolean
}

/** Supported skill roots in a GitHub repo. */
export type RepoRoot = 'skills' | 'design-templates'

/** GET /api/skill-hub/repo — discover importable skills in a GitHub repo. */
export interface RepoDiscoverResponse {
  ok: true
  repo: string
  ref: string
  entries: RepoSkillEntry[]
}

/** POST /api/skill-hub/repo/import — install selected repo skills. */
export interface RepoImportRequest {
  repo: string
  /** Selected SKILL.md paths from the discover response. */
  paths: string[]
}

/** POST /api/skill-hub/repo/import */
export interface RepoImportResponse {
  ok: true
  imported: Array<{ name: string; origin: string; path: string }>
  skipped: Array<{ name: string; reason: 'exists' }>
  failed: Array<{ name: string; error: string }>
}

/** GET /api/skill-hub/update — check the plugin's own latest GitHub release. */
export interface UpdateCheckResponse {
  ok: true
  /** Installed plugin version (from the bundled host build). */
  currentVersion: string
  /** Latest release tag, normalized without the leading v; null when unknown. */
  latestVersion: string | null
  /** True when latestVersion is strictly newer than currentVersion. */
  updateAvailable: boolean
  /** Release page URL; null when unavailable. */
  url: string | null
  /** Best-effort message when the check failed or no release exists. */
  error?: string
}

/** 用户自定义 tag 分组：纯组织视图，不改技能文件。 */
export interface SkillTag {
  /** 稳定 ID（新建时由宿主生成）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 成员技能名（集合技能与独立技能都可加入）。 */
  skillNames: string[]
}

/** 系统集合组：按 origin（来源集合标识）自动聚合。 */
export interface CollectionGroup {
  /** 集合名（origin 值，如 "superpowers" / "anthropics/skills"）。 */
  name: string
  /** 该集合下的技能名，按名称排序。 */
  skillNames: string[]
}

/** GET /api/skill-hub/groups */
export interface GroupsResponse {
  ok: true
  /** 用户自定义 tag 分组（按创建顺序）。 */
  tags: SkillTag[]
  /** 系统集合组（按 origin 聚合，名称排序）。 */
  collections: CollectionGroup[]
  /** skillName → 集合名 的完整映射。 */
  origins: Record<string, string>
  /** User-defined scenes (dedicated to one-click enable/disable). */
  scenes: Scene[]
}

/** POST /api/skill-hub/tag — 新建（缺省 id）或重命名（带 id）。 */
export interface TagSaveRequest {
  /** 已有 tag 的 id；缺省表示新建。 */
  id?: string
  /** 显示名（去空格后非空）。 */
  name: string
}

/** POST /api/skill-hub/tag */
export interface TagSaveResponse {
  ok: true
  /** 变更后的全部 tag。 */
  tags: SkillTag[]
}

/** POST /api/skill-hub/tag/delete */
export interface TagDeleteRequest {
  id: string
}

/** POST /api/skill-hub/tag/delete */
export interface TagDeleteResponse {
  ok: true
  tags: SkillTag[]
}

/** POST /api/skill-hub/tag/members — 直接设置某 tag 的完整成员列表（幂等）。 */
export interface TagMembersRequest {
  id: string
  /** 目标成员技能名；后端只保留目录中存在的名字。 */
  skillNames: string[]
}

/** POST /api/skill-hub/tag/members */
export interface TagMembersResponse {
  ok: true
  tags: SkillTag[]
}

/** POST /api/skill-hub/origin — 手动标记/清除某技能归属的集合。 */
export interface OriginRequest {
  /** 目标技能名。 */
  skillName: string
  /** 集合名；null 清除归属。 */
  origin: string | null
}

/** POST /api/skill-hub/origin */
export interface OriginResponse {
  ok: true
  /** 变更后的完整映射。 */
  origins: Record<string, string>
  /** 变更后的系统集合组。 */
  collections: CollectionGroup[]
}

/** A scene: a user-defined group dedicated to one-click enable/disable. */
export interface Scene extends SkillTag {
}

/** POST /api/skill-hub/scene — create (no id) or rename (with id) a scene. */
export interface SceneSaveRequest {
  id?: string
  name: string
}

/** POST /api/skill-hub/scene */
export interface SceneSaveResponse {
  ok: true
  scenes: Scene[]
}

/** POST /api/skill-hub/scene/delete */
export interface SceneDeleteRequest {
  id: string
}

/** POST /api/skill-hub/scene/delete */
export interface SceneDeleteResponse {
  ok: true
  scenes: Scene[]
}

/** POST /api/skill-hub/scene/members — set a scene's full member list (idempotent). */
export interface SceneMembersRequest {
  id: string
  skillNames: string[]
}

/** POST /api/skill-hub/scene/members */
export interface SceneMembersResponse {
  ok: true
  scenes: Scene[]
}
