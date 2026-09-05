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
