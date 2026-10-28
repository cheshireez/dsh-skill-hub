/**
 * 外部 agent 技能（收编）的线格式。
 *
 * 发现源是别的 agent 的用户级技能目录（Claude Code / Codex / Cursor / …），
 * 它们一律只读：这里只描述「看到了什么」和「要收编哪一个」。
 */

/** 一个被扫描的外部技能根。 */
export interface ForeignRootView {
  agent: string
  dir: string
  /** 该目录在本机是否存在（不存在时 skills 里不会出现它的条目）。 */
  present: boolean
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
}

/** GET /api/skill-hub/foreign */
export interface ForeignListResponse {
  ok: true
  roots: ForeignRootView[]
  skills: ForeignSkillView[]
}

/** POST /api/skill-hub/foreign/import — 按 agent + 名字收编（不信任前端给的路径）。 */
export interface ForeignImportRequest {
  items: Array<{ agent: string; name: string }>
}

export interface ForeignImportResponse {
  ok: true
  imported: string[]
  /** 导入前被移入回收站的同名占位（已禁用的发现文件 / 空壳目录），可恢复。 */
  replaced?: string[]
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; error: string }>
}
