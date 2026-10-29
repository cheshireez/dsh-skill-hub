/**
 * 外部 agent 技能域路由：发现（只读扫描别家目录）与收编（复制进本地可写根）。
 *
 * 扫描范围有两层：
 *   - 用户级：`~/.claude/skills` 之类，收编到 `~/.dsh/skills`；
 *   - 项目级：`<projectRoot>/.claude/skills` 之类，收编到 `<projectRoot>/.dsh/skills`。
 *
 * 三条约束：
 * 1. 外部目录只读 —— 扫描不会 mkdir，也不会写任何东西到别家路径下；
 * 2. 导入不信任前端给的路径：只接受 `agent + name + scope + projectRoot`，
 *    服务端重新扫一遍定位，且项目根必须来自宿主登记的工作区；
 * 3. 收编目标由 scope 重算，不接受前端传的目标路径。
 */

import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import {
  SKILL_HUB_API,
  type ForeignImportItem,
  type ForeignImportResponse,
  type ForeignListResponse,
  type ForeignScope,
  type ForeignSkillView,
} from '../protocol.ts'
import {
  findProjectRoot,
  foreignProjectRoots,
  foreignRoots,
  importForeignSkill,
  occupancyOf,
  projectSkillsRoot,
  rootPath,
  scanForeignRoots,
  type ForeignSkill,
} from '../skillfs.ts'
import { errorText } from '../error-text.ts'
import {
  homeOf,
  pathExists,
  userHomeOf,
  workspaceEntries,
  writeError,
  writeJson,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'
import { retireNamePlaceholders } from './route-state.ts'

/** 判断一个外部根是否真实存在（只 stat 一次，不列目录）。 */
async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从宿主登记的工作区推项目根。
 *
 * 只推「现在能扫的」：工作区目录已删除的整条跳过 —— 这里只是收编来源，
 * 没有「把路径改回去」的意义，列一个不可用的项目只会长出一堆空行。
 *
 * 导出供 toggle 使用：项目技能的 invocation 覆盖也需要「已知项目根」这份
 * 名单，且必须同源（同一个推导规则），否则两处判定会各自漂移。
 */
export async function knownProjectRoots(home: string): Promise<Array<{ root: string; name: string }>> {
  const workspaces = await workspaceEntries(home)
  const seen = new Map<string, { root: string; name: string }>()
  for (const entry of workspaces) {
    if (!isAbsolute(entry.path)) continue
    let root: string
    try {
      root = await findProjectRoot(entry.path)
    } catch {
      continue
    }
    if (seen.has(root)) continue
    if (!(await dirExists(root))) continue
    seen.set(root, { root, name: basename(root) || root })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 这条外部技能的收编目标根（服务端按 scope 决定，不看前端）。 */
function targetRootOf(skill: Pick<ForeignSkill, 'scope' | 'projectRoot'>, home: string): string {
  return skill.scope === 'project' && skill.projectRoot !== undefined
    ? projectSkillsRoot(skill.projectRoot)
    : rootPath('user-dsh', home)
}

export function foreignRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // ------------------------------------------------------------- foreign
    // 列出用户级与项目级外部技能目录里的可收编技能。
    {
      path: SKILL_HUB_API.foreign,
      methods: ['GET'],
      handler: async ({ res }) => {
        const home = homeOf(deps)
        // 外部技能目录挂在**用户主目录**下（`~/.claude/skills`）或**项目根**下，
        // 都不是 DSH 的状态根（`~/.dsh`）。两者混用会扫到一个永远不存在的位置。
        const userHome = userHomeOf(deps)
        const projects = await knownProjectRoots(home)
        const roots = [...foreignRoots(userHome), ...foreignProjectRoots(projects.map((project) => project.root))]

        // 一次扫描覆盖所有条目：逐个条目扫一遍目录会让 20 个技能 = 20 次全盘 readdir。
        // 「已存在」按各自的收编目标判 —— 同名在一个根里占了、另一个根里没占，是两件事。
        const skills = await scanForeignRoots(roots, async (skill) => {
          const targetRoot = targetRootOf(skill, home)
          return pathExists(join(targetRoot, skill.name, 'SKILL.md'))
            || pathExists(join(targetRoot, skill.name + '.md'))
        })
        const listed = await Promise.all(roots.map(async (root) => ({ ...root, present: await dirExists(root.dir) })))

        const view: ForeignSkillView[] = skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          agent: skill.agent,
          path: skill.path,
          kind: skill.kind,
          existing: skill.existing,
          scope: skill.scope,
          ...(skill.projectRoot !== undefined ? { projectRoot: skill.projectRoot } : {}),
        }))
        writeJson(res, 200, {
          ok: true,
          roots: listed.filter((root) => root.present),
          skills: view,
          projectRoots: projects,
        } satisfies ForeignListResponse)
      },
    },
    // ------------------------------------------------------ foreign/import
    // 按 agent + name + scope + projectRoot 收编。逐条独立成败，一条失败不影响其余。
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
        // 项目根在这里重推一次：POST 不能信前端给的 projectRoot —— 那是一个
        // 绝对路径，随便写一个就能让服务端去读别人的家目录。
        const projects = await knownProjectRoots(home)
        const known = new Set(projects.map((project) => project.root))
        const roots = [...foreignRoots(userHome), ...foreignProjectRoots([...known])]
        const available = await scanForeignRoots(roots, () => false)

        const imported: string[] = []
        const replaced: string[] = []
        const skipped: Array<{ name: string; reason: string }> = []
        const failed: Array<{ name: string; error: string }> = []
        const seen = new Set<string>()

        for (const raw of items) {
          const item = raw as ForeignImportItem | null
          const agent = item !== null && typeof item.agent === 'string' ? item.agent : ''
          const name = item !== null && typeof item.name === 'string' ? item.name : ''
          const scope: ForeignScope = item !== null && item.scope === 'project' ? 'project' : 'user'
          const projectRoot = item !== null && typeof item.projectRoot === 'string' ? item.projectRoot : ''
          if (agent === '' || name === '') { failed.push({ name, error: 'agent and name are required' }); continue }
          const key = scope + '/' + agent + '/' + name + '/' + projectRoot
          if (seen.has(key)) continue
          seen.add(key)

          // 项目级条目必须给出服务端已知的项目根：未知的（哪怕是绝对路径）一律拒。
          if (scope === 'project' && (projectRoot === '' || !known.has(projectRoot))) {
            failed.push({ name, error: 'unknown project root for a project-level skill' })
            continue
          }

          // 只认服务端自己扫出来的条目：名字要对得上，scope / projectRoot 也得对得上 ——
          // 否则一个名字就能把用户级技能装进别的项目。
          const skill = available.find((candidate) =>
            candidate.agent === agent
            && candidate.name === name
            && candidate.scope === scope
            && (scope === 'user' || candidate.projectRoot === projectRoot))
          if (skill === undefined) { failed.push({ name, error: 'skill not found under ' + agent }); continue }

          const targetRoot = targetRootOf(skill, home)
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
