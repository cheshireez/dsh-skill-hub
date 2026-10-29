/**
 * ZIP 导入域：把一个 `.zip` 里的技能装进用户根。
 *
 * 与市场导入、外部 agent 收编走同一套闸，一个都不少：
 *   - 解压前：路径穿越 / 符号链接 / 加密 / ZIP64 / 解压炸弹（`skillfs/zip.ts`）；
 *   - 落盘前/落盘时：frontmatter、整包审计、冲突判定、原子 rename
 *     （`./install-bundle.ts`，与 skills.sh 直装共用）。
 *
 * 一个包可以是单个技能，也可以是技能集合：按「最浅的含 SKILL.md 目录」分组，
 * 逐条独立成败 —— 一条坏包不该让其余 9 个白装。
 */

import { SKILL_HUB_API, type ZipAuditWarning, type ZipImportResponse } from '../protocol.ts'
import type { AuditFinding } from '../skillfs/audit.ts'
import { groupSkills, readZip, rootPath, ZipError, type ZipEntry } from '../skillfs.ts'
import { homeOf, knownSkillNames, writeError, writeJson, type RouteSpec, type SkillHubRouteDeps } from './helpers.ts'
import { installSkillBundle } from './install-bundle.ts'
import { retireNamePlaceholders } from './route-state.ts'

/** 审计发现 → 线格式（调用方只传 warn 级）。 */
function toWarning(finding: AuditFinding): ZipAuditWarning {
  return {
    rule: finding.rule,
    severity: 'warn',
    file: finding.file,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    message: finding.message,
  }
}

export function zipImportRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    {
      path: SKILL_HUB_API.importZip,
      methods: ['POST'],
      binaryBody: true,
      handler: async ({ res, raw }) => {
        if (raw === undefined) { writeError(res, 400, 'missing request body'); return }

        let grouped: Map<string, ZipEntry[]>
        try {
          grouped = groupSkills(readZip(raw))
        } catch (error) {
          // 结构错误与安全拒绝都是客户端的问题（400），不是服务端故障。
          if (error instanceof ZipError) { writeError(res, 400, error.message); return }
          throw error
        }
        if (grouped.size === 0) {
          writeError(res, 400, 'zip contains no skill: expected at least one SKILL.md')
          return
        }

        const targetRoot = rootPath('user-dsh', homeOf(deps))
        const existing = await knownSkillNames(deps, { includeDisabled: false })

        const imported: string[] = []
        const replaced: string[] = []
        const skipped: Array<{ name: string; reason: string }> = []
        const failed: Array<{ name: string; error: string }> = []
        const warnings: Array<{ name: string; findings: ZipAuditWarning[] }> = []

        for (const [root, files] of grouped) {
          const outcome = await installSkillBundle({
            targetRoot,
            files,
            // 出错时用它报名字：包内目录名比前端传来的任何东西都可信。
            label: root === '' ? '(package root)' : root,
            existing,
            retire: async (name) => (await retireNamePlaceholders(deps, targetRoot, name)) !== undefined,
          })
          if (outcome.status === 'installed') imported.push(outcome.name)
          else if (outcome.status === 'skipped') skipped.push({ name: outcome.name, reason: outcome.error ?? 'skipped' })
          else failed.push({ name: outcome.name, error: outcome.error ?? 'failed' })
          if (outcome.replaced === true) replaced.push(outcome.name)
          if (outcome.warnings !== undefined) warnings.push({ name: outcome.name, findings: outcome.warnings.map(toWarning) })
        }

        if (imported.length > 0) deps.invalidate?.()
        writeJson(res, 200, {
          ok: true,
          imported,
          ...(replaced.length > 0 ? { replaced } : {}),
          skipped,
          failed,
          warnings,
        } satisfies ZipImportResponse)
      },
    },
  ]
}
