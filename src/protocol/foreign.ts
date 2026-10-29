/**
 * 外部 agent 技能（收编）的线格式。
 *
 * 发现源有两层：用户级（`~/.claude/skills` 之类）与项目级（`<projectRoot>/.claude/skills`
 * 之类）。两者都**只读**扫描，收编目标由 scope 决定 —— 用户级收进 `~/.dsh/skills`，
 * 项目级收进 `<projectRoot>/.dsh/skills`。前端不传目标路径，只回传它看到的
 * scope 与 projectRoot，服务端据此重算。
 */

/** 外部技能的层级：用户级（`~/.…`）或项目级（`<projectRoot>/.…`）。 */
export type ForeignScope = 'user' | 'project'

/** 一个被扫描的外部技能根。 */
export interface ForeignRootView {
  agent: string
  dir: string
  /** 该目录在本机是否存在（不存在时 skills 里不会出现它的条目）。 */
  present: boolean
  scope: ForeignScope
  /** `scope === 'project'` 时的项目根绝对路径。 */
  projectRoot?: string
}

/** 一条可收编的外部技能。 */
export interface ForeignSkillView {
  name: string
  description: string
  agent: string
  /** 发现文件绝对路径（只读展示）。 */
  path: string
  kind: 'directory' | 'flat'
  /** 目标根已有同名技能，不可导入。 */
  existing: boolean
  scope: ForeignScope
  /** `scope === 'project'` 时的项目根。 */
  projectRoot?: string
}

/** GET /api/skill-hub/foreign */
export interface ForeignListResponse {
  ok: true
  roots: ForeignRootView[]
  skills: ForeignSkillView[]
  /** 已登记工作区推导出的项目根（与 skills 里的 projectRoot 同源）。 */
  projectRoots: Array<{ root: string; name: string }>
}

/** 一条收编请求。`scope` 缺省按 `'user'` 处理（旧客户端兼容）。 */
export interface ForeignImportItem {
  agent: string
  name: string
  scope?: ForeignScope
  /** `scope === 'project'` 时必须给，且必须是服务端已知的项目根。 */
  projectRoot?: string
}

/** POST /api/skill-hub/foreign/import — 按 agent + 名字收编（不信任前端给的路径）。 */
export interface ForeignImportRequest {
  items: ForeignImportItem[]
}

export interface ForeignImportResponse {
  ok: true
  imported: string[]
  /** 导入前被移入回收站的同名占位（已禁用的发现文件 / 空壳目录），可恢复。 */
  replaced?: string[]
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; error: string }>
}
