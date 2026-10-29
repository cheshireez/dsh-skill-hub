/**
 * ZIP 导入的线格式。
 *
 * 请求体是原始 `.zip` 字节（`content-type: application/zip`），不是 base64
 * 包在 JSON 里 —— 理由见 `routes/http.ts` 的 `MAX_BINARY_BODY_BYTES`。
 *
 * 一个包可以整体是一个技能（`SKILL.md` 在包根），也可以是技能的集合
 * （每个子目录一份 `SKILL.md`）；服务端按「最浅的含 SKILL.md 目录」分组，
 * 逐个独立成败，与 `foreign/import` 同一套结果语义。
 */

import type { AuditWarningView } from './audit.ts'

/** 一条警告级审计发现（阻断级会让整个技能进 `failed`，不落盘）。 */
export type ZipAuditWarning = AuditWarningView

/** POST /api/skill-hub/import/zip */
export interface ZipImportResponse {
  ok: true
  /** 落盘成功的技能名（以 frontmatter 的 name 为准）。 */
  imported: string[]
  /** 导入前被移入回收站的同名占位（已禁用发现文件 / 空壳目录），可恢复。 */
  replaced?: string[]
  /** 主动跳过的条目：目标根已有同名启用态技能。 */
  skipped: Array<{ name: string; reason: string }>
  /** 失败条目：审计阻断、frontmatter 不合法、写盘错误。 */
  failed: Array<{ name: string; error: string }>
  /** 落盘成功但带警告的技能。 */
  warnings: Array<{ name: string; findings: ZipAuditWarning[] }>
}
