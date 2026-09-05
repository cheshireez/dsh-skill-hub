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
  skillDelete: '/api/skill-hub/skill/delete',
  toggle: '/api/skill-hub/toggle',
  toggleBatch: '/api/skill-hub/toggle-batch',
  create: '/api/skill-hub/create',
  stats: '/api/skill-hub/stats',
  config: '/api/skill-hub/config',
  market: '/api/skill-hub/market',
  marketSource: '/api/skill-hub/market/source',
  marketSourceDelete: '/api/skill-hub/market/source/delete',
  marketSourceRef: '/api/skill-hub/market/source/ref',
  marketCheck: '/api/skill-hub/market/check',
  marketSync: '/api/skill-hub/market/source/sync',
  repo: '/api/skill-hub/repo',
  repoImport: '/api/skill-hub/repo/import',
  repoImportProgress: '/api/skill-hub/repo/import/progress',
  repoImportCancel: '/api/skill-hub/repo/import/cancel',
  update: '/api/skill-hub/update',
  groups: '/api/skill-hub/groups',
  tag: '/api/skill-hub/tag',
  tagDelete: '/api/skill-hub/tag/delete',
  tagMembers: '/api/skill-hub/tag/members',
  tagReorder: '/api/skill-hub/tag/reorder',
  collectionReorder: '/api/skill-hub/collections/reorder',
  sourceGroupReorder: '/api/skill-hub/source-groups/reorder',
  sources: '/api/skill-hub/sources',
  sourceCheck: '/api/skill-hub/sources/check',
  sourceSync: '/api/skill-hub/sources/sync',
  sourceDelete: '/api/skill-hub/sources/delete',
  sourceRestore: '/api/skill-hub/sources/restore',
  sourceTrashClear: '/api/skill-hub/sources/trash/clear',
  diagnosticFix: '/api/skill-hub/diagnostic/fix',
  marketSourceVersions: '/api/skill-hub/market/source/versions',
  marketStats: '/api/skill-hub/market/stats',
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
  invocation: HubInvocation
  provider: string
  /** Whether the hub may toggle this skill (user-level filesystem skills only). */
  writable: boolean
  /** 技能来源标识（user-dsh/user-agents/project-dsh/project-agents/...）。 */
  source: string
  /** SKILL.md creation time (epoch ms); used for "added" sorting. Absent when unknown. */
  addedAt?: number
  /** SKILL.md last-modified time (epoch ms); used for "updated" display. Absent when unknown. */
  updatedAt?: number
  /** 项目技能的所属工作区路径（仅 project-dsh/project-agents 来源携带）。 */
  workspace?: string
  /** 工作区显示标题（来自 workspace.json；无则回退为路径）。 */
  workspaceTitle?: string
  /** UI metadata from agents/openai.yaml (mirrors codex SkillInterface). */
  displayName?: string
  shortDescription?: string
  brandColor?: string
  iconSmall?: string
  iconLarge?: string
  defaultPrompt?: string
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
  /** Whether this diagnostic can be auto-fixed (e.g. unquoted colon). */
  fixable?: boolean
}

/** POST /api/skill-hub/diagnostic/fix — repair a fixable diagnostic in place. */
export interface DiagnosticFixRequest {
  path: string
}
export interface DiagnosticFixResponse {
  ok: true
  path: string
}

/** GET /api/skill-hub/catalog */
export interface CatalogResponse {
  ok: true
  /** 已安装插件自身的版本号（package.json version），面板标题旁显示。 */
  pluginVersion: string
  /** Whether discovery completed within a stable catalog revision. */
  complete: boolean
  /** Sorted winning summaries of every enabled skill (all roots + providers). */
  skills: CatalogSkill[]
  /** Skills the hub has toggled off (kept outside provider discovery). */
  disabled: DisabledSkill[]
  /** Files in the writable roots the provider ignores, with reasons. */
  diagnostics: DiagnosticEntry[]
  /** Skill names that appeared in multiple roots (first wins, others hidden). Mirrors codex name_counts. */
  duplicateNames?: string[]
}

/** GET /api/skill-hub/skill */
export interface SkillDetail {
  name: string
  description: string
  whenToUse?: string
  invocation: HubInvocation
  provider: string
  /** Absolute file path when the skill came from disk. */
  path?: string
  /** SKILL.md creation time (epoch ms); absent when the file is unreadable. */
  addedAt?: number
  /** SKILL.md last-modified time (epoch ms); absent when the file is unreadable. */
  updatedAt?: number
  /** Markdown instruction body. */
  content: string
  displayName?: string
  shortDescription?: string
  brandColor?: string
  iconSmall?: string
  iconLarge?: string
  defaultPrompt?: string
}

export interface SkillDetailResponse {
  ok: true
  skill: SkillDetail
}

/** POST /api/skill-hub/skill/delete — 把单个技能移入回收站（可恢复）。 */
export interface SkillDeleteRequest {
  name: string
}

/** POST /api/skill-hub/skill/delete */
export interface SkillDeleteResponse {
  ok: true
  name: string
  /** 移入回收站后的路径（目录或文件）。 */
  path: string
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

/**
 * Persisted incremental-scan checkpoint for the usage statistics (sidecar
 * `skillStats` field). Sessions created before `frozenBefore` are treated as
 * finalized: their per-session counts live in `frozenSessions` (only sessions
 * with at least one invocation are kept) and they are not re-read on
 * incremental scans. A daily full reconciliation rebuilds the cache and
 * advances the watermark, so a resumed old session is eventually re-counted.
 */
export interface SkillStatsCheckpoint {
  /** The rolling-window configuration this checkpoint was built for (0 = all history). */
  windowDays: number
  /** Watermark: every session with header.createdAt < this value is frozen. */
  frozenBefore: number
  /** Per-session counts of finalized sessions, keyed by session id. */
  frozenSessions: Record<string, { createdAt: number; counts: Record<string, { count: number; lastUsed: number }> }>
  /** Epoch ms of the last full reconciliation (drives the daily cadence). */
  lastFullReconcile: number
  /**
   * Totals from the last completed scan (any kind). Served instantly on cold
   * start so a restart still shows numbers while the background rescan runs.
   */
  lastTotals?: SkillStat[]
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
  /** Show group-header usage summaries (count + last used). Default true. */
  showGroupSummary?: boolean
  /** 统计滚动窗口天数：只统计最近 N 天的使用；0 = 全部历史。默认 0。 */
  statsWindowDays?: number
  /** 自动统计扫描间隔（分钟，最小 1）。默认 5。 */
  statsScanMinutes?: number
  /**
   * GitHub personal access token for market/source API calls (anonymous quota
   * is 60 req/h, authed 5000/hr). Stored in the local settings doc; absent
   * means anonymous. Never logged.
   */
  githubToken?: string
}

/**
 * The resolved shape of the hub's settings namespace (schema defaults, then
 * the composition base, then the user layer). Kept as a type alias so the
 * browser-side settings scope snapshot is index-compatible with the card
 * form's record shape.
 */
export type HubSettingsValue = {
  enabled: boolean
  announceToAgent: boolean
  showUseCount: boolean
  showUseTime: boolean
  showGroupSummary: boolean
  /** Model-invocable dot color (#rrggbb); absent means the panel default. */
  dotModelColor?: string
  /** User-invocable dot color (#rrggbb); absent means the panel default. */
  dotUserColor?: string
  /** 统计滚动窗口天数（0 = 全部历史）。 */
  statsWindowDays?: number
  /** 自动统计扫描间隔（分钟）。 */
  statsScanMinutes?: number
  /** GitHub token（明文存本地设置文档，仅回环可读；缺省为匿名）。 */
  githubToken?: string
}

/**
 * Hub config defaults — the single source every layer reads: the cordis
 * schema (index.ts), the host's saved-override merge, and the routes'
 * fallback view. Changing a default here changes all three.
 */
export const HUB_CONFIG_DEFAULTS = {
  enabled: true,
  announceToAgent: true,
  showUseCount: true,
  showUseTime: true,
  showGroupSummary: true,
  statsWindowDays: 14,
  statsScanMinutes: 5,
} as const

/**
 * Resolve the effective hub config: saved sidecar overrides win over the
 * cordis composition entry (the web card owns runtime config), missing
 * booleans fall back to HUB_CONFIG_DEFAULTS, and dot colors pass through
 * (saved first, then base) only when set. Numeric stats knobs are clamped to
 * their sane ranges (window ≥ 0, scan interval ≥ 1 minute).
 */
export function resolveHubConfig(saved: Partial<HubConfig>, base: Partial<HubConfig> = {}): HubConfig {
  const dotModelColor = saved.dotModelColor !== undefined ? saved.dotModelColor : base.dotModelColor
  const dotUserColor = saved.dotUserColor !== undefined ? saved.dotUserColor : base.dotUserColor
  const githubToken = saved.githubToken !== undefined ? saved.githubToken : base.githubToken
  const windowDays = clampNumber(saved.statsWindowDays ?? base.statsWindowDays, 0) ?? HUB_CONFIG_DEFAULTS.statsWindowDays
  const scanMinutes = clampNumber(saved.statsScanMinutes ?? base.statsScanMinutes, 1) ?? HUB_CONFIG_DEFAULTS.statsScanMinutes
  return {
    enabled: saved.enabled ?? base.enabled ?? HUB_CONFIG_DEFAULTS.enabled,
    announceToAgent: saved.announceToAgent ?? base.announceToAgent ?? HUB_CONFIG_DEFAULTS.announceToAgent,
    showUseCount: saved.showUseCount ?? base.showUseCount ?? HUB_CONFIG_DEFAULTS.showUseCount,
    showUseTime: saved.showUseTime ?? base.showUseTime ?? HUB_CONFIG_DEFAULTS.showUseTime,
    showGroupSummary: saved.showGroupSummary ?? base.showGroupSummary ?? HUB_CONFIG_DEFAULTS.showGroupSummary,
    statsWindowDays: windowDays,
    statsScanMinutes: scanMinutes,
    ...(dotModelColor !== undefined ? { dotModelColor } : {}),
    ...(dotUserColor !== undefined ? { dotUserColor } : {}),
    ...(githubToken !== undefined ? { githubToken } : {}),
  }
}

/** Clamp a numeric override into a valid value; undefined/invalid stays undefined. */
function clampNumber(value: unknown, min: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return undefined
  return Math.floor(value)
}

/** HEX color validation shared by host routes and the settings card. */
export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

/** GET /api/skill-hub/config */
export interface ConfigResponse {
  ok: true
  /** 已安装插件自身的版本号（package.json version），设置卡标题旁显示。 */
  pluginVersion: string
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
  showGroupSummary?: boolean | null
  /** Set the dot color; null clears the saved override so it re-inherits the default. */
  dotModelColor?: string | null
  /** Set the dot color; null clears the saved override so it re-inherits the default. */
  dotUserColor?: string | null
  /** 统计滚动窗口天数（0 = 全部历史）；null 清除覆盖回默认。 */
  statsWindowDays?: number | null
  /** 自动统计扫描间隔（分钟）；null 清除覆盖回默认。 */
  statsScanMinutes?: number | null
  /** Set the GitHub token; null/empty clears it back to anonymous. */
  githubToken?: string | null
}

/** GitHub token validation shared by host routes and the settings card. */
export const GITHUB_TOKEN_RE = /^[A-Za-z0-9_\-]{8,255}$/

/** One market source: a tracked upstream repo plus its pinned version. */
export interface MarketSourceRecord {
  /** Repo slug (owner/repo). */
  repo: string
  /** Pinned version: release tag, branch name, or custom ref. Absent = not yet pinned. */
  ref?: string
  /** Commit the pinned ref last resolved to (update-check baseline). */
  commitSha?: string
}

/** GET /api/skill-hub/market — the user's added market sources. */
export interface MarketSourcesResponse {
  ok: true
  /** Added market sources, in addition order. */
  repos: MarketSourceRecord[]
}

/** POST /api/skill-hub/market/source — add one repo as a market source. */
export interface MarketSourceRequest {
  /** owner/repo, owner/repo@ref, or a github.com URL. */
  repo: string
}

/** POST /api/skill-hub/market/source|delete */
export interface MarketSourceResponse {
  ok: true
  repos: MarketSourceRecord[]
}

/** POST /api/skill-hub/market/source/ref — pin a market source to an explicit ref. */
export interface MarketSourceRefRequest {
  repo: string
  /** Release tag or branch name chosen for the repo. */
  ref: string
}

/** GET /api/skill-hub/market/source/versions?repo= — releases + branches for the version picker. */
export interface MarketSourceVersionsResponse {
  ok: true
  repo: string
  /** Currently pinned ref, when one is recorded. */
  current?: string
  /** Release tags, newest first (drafts excluded). */
  releases: string[]
  /** Branch names, default branch first. */
  branches: string[]
}

/** Persisted market-stats snapshot (sidecar `marketStats` field): last fetched stars/downloads per repo. */
export interface MarketStatsSnapshot {
  /** Epoch ms of the fetch this snapshot was built from (drives the hourly TTL). */
  fetchedAt: number
  /** Per-repo numbers, keyed by repo slug. */
  stats: Record<string, { stars: number; downloads: number }>
}

/** GET /api/skill-hub/market/stats — stars + release-asset downloads per market source. */
export interface MarketStatsResponse {
  ok: true
  results: Array<{
    repo: string
    stars: number
    downloads: number
    /** Throttled: served from the hourly cache without a network round. */
    throttled?: boolean
    /** Stale: older than the hourly TTL, a background refresh is on its way. */
    stale?: boolean
    error?: string
  }>
}

/** GET /api/skill-hub/market/check — update check over market sources. */
export interface MarketCheckResponse {
  ok: true
  results: Array<{
    repo: string
    /** Pinned ref, when one is recorded. */
    ref?: string
    /** Latest release tag on the repo, when it has one. */
    latestTag?: string
    /** Whether the pinned ref (or the repo) has moved ahead. */
    updateAvailable: boolean
    /** Latest commit of the checked ref. */
    commitSha: string
    /** Throttled: the check was skipped within the interval. */
    throttled?: boolean
    error?: string
  }>
}

/** POST /api/skill-hub/market/source/sync — align a market source to its pinned ref. */
export interface MarketSyncResponse {
  ok: true
  repo: string
  /** The ref the source is now pinned to. */
  ref: string
  commitSha: string
  /** Local skills tracked from this repo (candidates for a batch update). */
  skills: string[]
}

/** A skill discovered in a GitHub repo under any top-level root (e.g. skills/, templates/). */
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

/** Skill root in a GitHub repo: the top-level directory that contains skills (e.g. skills, design-templates, templates). Auto-derived from SKILL.md locations, not hard-coded. */
export type RepoRoot = string

/** GET /api/skill-hub/repo — discover importable skills in a GitHub repo. */
export interface RepoDiscoverResponse {
  ok: true
  repo: string
  /**
   * Ref the discovery ran against (release tag / branch / default branch).
   * Null means the repo has no release and no pinned ref — the client must
   * ask the user to pick a branch (see `branches`) and pin it first.
   */
  ref: string | null
  /** Branch names to choose from when ref is null (default branch first). */
  branches?: string[]
  entries: RepoSkillEntry[]
  /** GitHub truncated the tree; discovery is partial (mirrors codex walk_truncated). */
  truncated?: boolean
}

/** POST /api/skill-hub/repo/import — install selected repo skills. */
export interface RepoImportRequest {
  repo: string
  /** Selected SKILL.md paths from the discover response. */
  paths: string[]
  /** The ref the discovery ran against; the import must use the same one. */
  ref?: string
}

/** POST /api/skill-hub/repo/import — now creates an async job (B方案) */
export interface RepoImportResponse {
  ok: true
  jobId: string
  total: number
  totalBytes: number
}

/** GET /api/skill-hub/repo/import/progress?jobId=xxx */
export interface RepoImportProgressResponse {
  ok: true
  jobId: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  total: number
  done: number
  /** 当前正在下载的 skill 名，done < total 时有效 */
  current?: string
  /** 当前正在下载的文件路径（相对 skill dir） */
  currentFile?: string
  /** 字节级进度 */
  totalBytes: number
  downloadedBytes: number
  /** 下载速度 bytes/sec，running 时有效 */
  bytesPerSecond?: number
  imported: Array<{ name: string; origin: string; path: string }>
  skipped: Array<{ name: string; reason: 'exists' }>
  failed: Array<{ name: string; error: string }>
  /** error 状态时的原因 */
  error?: string
}

/** POST /api/skill-hub/repo/import/cancel */
export interface RepoImportCancelRequest {
  jobId: string
}
export interface RepoImportCancelResponse {
  ok: true
  jobId: string
  status: 'cancelled' | 'done'
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
  /** 默认场景（「通用」）：系统预置、不可删除、新技能自动归入。 */
  default?: boolean
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
  /** 用户自定义 tag 分组（按拖拽顺序）。 */
  tags: SkillTag[]
  /** 系统集合组（按拖拽顺序，兜底按名称）。 */
  collections: CollectionGroup[]
  /** skillName → 集合名 的完整映射。 */
  origins: Record<string, string>
  /** 来源分组整体顺序（project / col:xxx / uncategorized-source），用于 SourcesView 顶层排序 */
  sourceGroupOrder?: string[]
  /** 兼容旧 collectionOrder 字段 */
  collectionOrder?: string[]
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

/** POST /api/skill-hub/tag/reorder — 拖拽重排场景分组 */
export interface TagReorderRequest {
  /** 按新顺序排列的 tag id 列表（需包含全部 id） */
  orderedIds: string[]
}
/** POST /api/skill-hub/tag/reorder */
export interface TagReorderResponse {
  ok: true
  tags: SkillTag[]
}

/** POST /api/skill-hub/collections/reorder — 拖拽重排来源集合 */
export interface CollectionReorderRequest {
  /** 按新顺序排列的集合名列表（需包含全部 name） */
  orderedNames: string[]
}
/** POST /api/skill-hub/collections/reorder */
export interface CollectionReorderResponse {
  ok: true
  collections: CollectionGroup[]
  order: string[]
}

/** POST /api/skill-hub/source-groups/reorder — 拖拽重排来源顶层分组（project / collections / personal） */
export interface SourceGroupReorderRequest {
  /** 按新顺序排列的顶层分组 key 列表（project / col:xxx / uncategorized-source） */
  orderedKeys: string[]
}
export interface SourceGroupReorderResponse {
  ok: true
  order: string[]
}

/** 来源跟踪记录：一组来自同一上游仓库根目录的技能。 */
export interface SourceRecord {
  /** GitHub owner/repo。 */
  repo: string
  /** 显式分支/tag；缺省表示默认分支。 */
  ref?: string
  /** 技能在仓库中的根目录。 */
  root: RepoRoot
  /** 上次导入/同步时的上游 commit SHA；空 = 尚未核对过。 */
  commitSha: string
  /** 该来源下的技能名（来源组 = 这些技能）。 */
  skills: string[]
  /** 仓库内路径 → 文件大小 的基线清单（差异检测用；缺失 = 无基线）。 */
  manifest?: Record<string, number>
}

/** 回收站条目：上游删除后跟进删除（移入 .trash）的技能。 */
export interface TrashEntry {
  name: string
  /** .trash 下的绝对路径。 */
  path: string
  /** 移入回收站的时间（epoch ms）。 */
  movedAt: number
  /** 移入回收站前的原始路径（目录或文件）；旧版本条目没有该字段。 */
  sourcePath?: string
  /**
   * 移入回收站前的来源跟踪快照（恢复时用它把技能重新挂回来源记录，
   * 否则恢复后的技能会丢失来源归属、变成「个人技能」）。
   */
  origin?: {
    repo: string
    root: RepoRoot
    ref?: string
    commitSha: string
  }
  /** 移入回收站前所属的场景（tag）ID；恢复时重新加回这些场景。 */
  tagIds?: string[]
}

/** GET /api/skill-hub/sources */
export interface SourcesResponse {
  ok: true
  /** 全部来源记录（按 repo 排序）。 */
  sources: SourceRecord[]
  /** skillName → 集合名（由 sources 派生）。 */
  origins: Record<string, string>
  /** 来源集合组（按 origin 聚合）。 */
  collections: CollectionGroup[]
  /** 回收站内容。 */
  trash: TrashEntry[]
}

/** POST /api/skill-hub/sources/check — 检查指定（或全部）来源的上游更新。 */
export interface SourceCheckRequest {
  /** 仅检查该 repo；缺省检查全部。 */
  repo?: string
}

/** 单个来源的检查结果。 */
export interface SourceCheckResult {
  repo: string
  ref?: string
  /** 检查失败时的原因（如仓库不可达/限流）。 */
  error?: string
  /** 上游 commit 是否变化。 */
  changed: boolean
  /** 上游最新 commit SHA（检查成功时）。 */
  commitSha?: string
  /** 上游有更新的技能名（changed 时经 tree 差异得出）。 */
  updated: string[]
  /** 上游已删除的技能名（changed 时经 tree 差异得出）。 */
  deleted: string[]
  /** 节流跳过（距上次检查不足 5 分钟，未访问网络）。 */
  throttled?: boolean
  /** 该来源此前没有快照（迁移/旧记录），本次已回填 commit，尚未有差异基线。 */
  unverified?: boolean
}

/** POST /api/skill-hub/sources/check */
export interface SourceCheckResponse {
  ok: true
  results: SourceCheckResult[]
}

/** POST /api/skill-hub/sources/sync — 按上游重新下载所选技能并更新快照。 */
export interface SourceSyncRequest {
  repo: string
  /** 要同步的技能名；缺省同步该来源全部技能。 */
  skills?: string[]
}

/** POST /api/skill-hub/sources/sync */
export interface SourceSyncResponse {
  ok: true
  repo: string
  /** 同步后的上游 commit SHA。 */
  commitSha: string
  /** 成功同步的技能。 */
  synced: string[]
  /** 失败的技能。 */
  failed: Array<{ name: string; error: string }>
}

/** POST /api/skill-hub/sources/delete — 跟进上游删除，本地移入回收站。 */
export interface SourceDeleteRequest {
  repo: string
  /** 要删除的技能名（移入 .trash）。 */
  skills: string[]
}

/** POST /api/skill-hub/sources/delete */
export interface SourceDeleteResponse {
  ok: true
  /** 已移入回收站的技能。 */
  trashed: string[]
  failed: Array<{ name: string; error: string }>
}

/** POST /api/skill-hub/sources/restore — 从回收站恢复一个技能。 */
export interface SourceRestoreRequest {
  name: string
}

/** POST /api/skill-hub/sources/restore */
export interface SourceRestoreResponse {
  ok: true
  name: string
  path: string
}

/** POST /api/skill-hub/sources/trash/clear — 永久删除回收站里的全部技能。 */
export interface SourceTrashClearResponse {
  ok: true
  /** 已永久删除的技能名。 */
  deleted: string[]
  /** 未能删除的技能（保留在回收站中）。 */
  failed: Array<{ name: string; error: string }>
}

/** 项目级技能来源（它们有 workspace 归属，不属于「个人」组）。 */
export function isProjectSource(source: string): boolean {
  return source === 'project-dsh' || source === 'project-agents'
}
