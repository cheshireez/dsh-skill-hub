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
