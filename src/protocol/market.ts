import type { AuditWarningView } from './audit.ts'

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

/**
 * POST /api/skill-hub/market/source — same list, plus the slug the host
 * resolved from the input. Clients must scan *this* slug rather than assume
 * the acted-on source sits at some position in `repos`: re-adding a repo the
 * user already tracks only updates its `ref` in place and never reorders the
 * list.
 */
export interface MarketSourceAddResponse extends MarketSourceResponse {
  /** Normalized `owner/repo` the host recorded for the submitted input. */
  repo: string
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

/** GET /api/skill-hub/market/source/check — update check over market sources. */
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

/**
 * 一条 skills.sh 搜索结果。
 *
 * skills.sh 是索引不是仓库：`source` 是 `owner/repo`，可以直接当市场源加入；
 * `skillId` 是技能在该仓库里的目录名，加入后由仓库扫描定位。
 */
export interface MarketSkillsShEntry {
  /** 上游 id，形如 `owner/repo/skillId`（去重键）。 */
  id: string
  /** `owner/repo` —— 已按严格形态校验过，可直接拼进 github.com 路径。 */
  source: string
  /** 技能在仓库里的目录名。 */
  skillId: string
  name: string
  /** 上游统计的安装次数；缺失表示上游没给。 */
  installs?: number
}

/** GET /api/skill-hub/market/skills-sh?q= */
export interface MarketSkillsShResponse {
  ok: true
  /** 已按相关度排序、去重、限制条数。 */
  skills: MarketSkillsShEntry[]
}

/** POST /api/skill-hub/market/skills-sh/install — 直装单个技能（不登记来源）。 */
export interface MarketSkillsShInstallRequest {
  /** `owner/repo`。 */
  source: string
  skillId: string
}

export interface MarketSkillsShInstallResponse {
  ok: true
  /** installed = 已落盘；skipped = 同名已存在；failed = 审计阻断或写盘失败。 */
  status: 'installed' | 'skipped' | 'failed'
  name: string
  /** `skipped` / `failed` 的原因。 */
  error?: string
  /** 安装前把同名禁用占位移入了回收站。 */
  replaced?: boolean
  /** 落盘成功的警告级发现。 */
  warnings?: AuditWarningView[]
}
