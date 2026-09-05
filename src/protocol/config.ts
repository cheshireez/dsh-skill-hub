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
