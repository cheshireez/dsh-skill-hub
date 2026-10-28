/**
 * 外部 agent 技能域路由：发现（只读扫描别家目录）与收编（复制进本地可写根）。
 *
 * 两条约束：
 * 1. 外部目录只读 —— 扫描不会 mkdir，也不会写任何东西到别家路径下；
 * 2. 导入不信任前端给的路径：只接受 `agent + name`，服务端重新扫一遍定位，
 *    否则一个拼出来的绝对路径就能把任意文件复制进技能目录。
 */

import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SKILL_HUB_API,
  type ForeignImportResponse,
  type ForeignListResponse,
  type ForeignSkillView,
} from '../protocol.ts'
import { foreignRoots, importForeignSkill, occupancyOf, rootPath, scanForeignSkills } from '../skillfs.ts'
import { errorText } from '../error-text.ts'
import { homeOf, knownSkillNames, pathExists, userHomeOf, writeError, writeJson, type RouteSpec, type SkillHubRouteDeps } from './helpers.ts'
import { retireNamePlaceholders } from './route-state.ts'

/** 判断一个外部根是否真实存在（只 stat 一次，不列目录）。 */
async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export function foreignRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // ------------------------------------------------------------- foreign
    // 列出其他 agent 用户级技能目录里的可收编技能。
    {
      path: SKILL_HUB_API.foreign,
      methods: ['GET'],
      handler: async ({ res }) => {
        const home = homeOf(deps)
        // 外部技能目录挂在**用户主目录**下（`~/.claude/skills`），不是 DSH 的
        // 状态根（`~/.dsh`）。两者混用会扫到一个永远不存在的位置。
        const userHome = userHomeOf(deps)
        const existing = await knownSkillNames(deps, { includeDisabled: false })
        const skills = await scanForeignSkills(userHome, existing)
        const roots = await Promise.all(foreignRoots(userHome).map(async (root) => ({ ...root, present: await dirExists(root.dir) })))
        const targetRoot = rootPath('user-dsh', home)
        // 注册表快照是权威的（含项目级/内置），但它可能比磁盘慢一拍：刚写进去
        // 还没被 watcher 收进索引时，快照会说「没有」。只对快照没命中的做一次
        // 磁盘确认，避免把冲突项标成可导入。
        //
        // 判据只看**启用态**的发现文件：`<name>/SKILL.md` 或扁平 `<name>.md`。
        // 目录存在但只有 `SKILL.md.disabled`（或干脆是空壳）不算冲突 —— 那正是
        // 导入时会被移入回收站让位的占位，标成「已存在」会让用户根本选不了。
        const view: ForeignSkillView[] = await Promise.all(skills.map(async (skill) => ({
          name: skill.name,
          description: skill.description,
          agent: skill.agent,
          path: skill.path,
          kind: skill.kind,
          existing: skill.existing
            || await pathExists(join(targetRoot, skill.name, 'SKILL.md'))
            || await pathExists(join(targetRoot, skill.name + '.md')),
        })))
        writeJson(res, 200, { ok: true, roots: roots.filter((root) => root.present), skills: view } satisfies ForeignListResponse)
      },
    },
    // ------------------------------------------------------ foreign/import
    // 按 agent + name 收编。逐条独立成败，一条失败不影响其余。
    {
      path: SKILL_HUB_API.foreignImport,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const items = Array.isArray(body.items) ? body.items : []
        if (items.length === 0) { writeError(res, 400, 'items must be a non-empty array'); return }
        if (items.length > 100) { writeError(res, 400, 'import at most 100 skills per request'); return }
        const home = homeOf(deps)
        const userHome = userHomeOf(deps)
        const existing = await knownSkillNames(deps, { includeDisabled: false })
        // 一次扫描覆盖所有条目：逐个条目扫一遍目录会让 20 个技能 = 20 次全盘 readdir。
        const available = await scanForeignSkills(userHome, existing)
        const targetRoot = rootPath('user-dsh', home)
        await mkdir(targetRoot, { recursive: true })
        const imported: string[] = []
        const replaced: string[] = []
        const skipped: Array<{ name: string; reason: string }> = []
        const failed: Array<{ name: string; error: string }> = []
        const seen = new Set<string>()
        for (const raw of items) {
          const item = raw as { agent?: unknown; name?: unknown } | null
          const agent = item !== null && typeof item.agent === 'string' ? item.agent : ''
          const name = item !== null && typeof item.name === 'string' ? item.name : ''
          if (agent === '' || name === '') { failed.push({ name, error: 'agent and name are required' }); continue }
          if (seen.has(agent + '/' + name)) continue
          seen.add(agent + '/' + name)
          // 只认服务端自己扫出来的条目：前端给的名字必须对得上一条真实记录。
          const skill = available.find((candidate) => candidate.agent === agent && candidate.name === name)
          if (skill === undefined) { failed.push({ name, error: 'skill not found under ' + agent }); continue }
          if (skill.existing) {
            skipped.push({ name, reason: 'a skill with this name already exists' })
            continue
          }
          // 磁盘上可能有已禁用的同名占位或空壳目录：那不算「已存在」，但目标目录
          // 非空，裸 rename 会 ENOTEMPTY。先让它进回收站（可恢复），与市场导入同一语义。
          const occupancy = await occupancyOf(targetRoot, name)
          if (occupancy.enabled.length > 0) {
            skipped.push({ name, reason: 'a skill with this name already exists' })
            continue
          }
          if (occupancy.disabled.length > 0 || occupancy.bareDir !== undefined) {
            const trashed = await retireNamePlaceholders(deps, targetRoot, name)
            if (trashed !== undefined) replaced.push(name)
          }
          try {
            await importForeignSkill(skill, targetRoot)
            imported.push(name)
          } catch (error) {
            failed.push({ name, error: errorText(error) })
          }
        }
        if (imported.length > 0) deps.invalidate?.()
        writeJson(res, 200, { ok: true, imported, ...(replaced.length > 0 ? { replaced } : {}), skipped, failed } satisfies ForeignImportResponse)
      },
    },
  ]
}
