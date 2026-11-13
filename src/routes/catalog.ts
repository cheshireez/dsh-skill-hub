/**
 * 目录域路由：catalog / skill 详情 / skill 删除 / toggle / toggle-batch /
 * create / stats。从 routes.ts 原样搬出，handler 逻辑不变。
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import {
  SKILL_HUB_API,
  type CreateResponse,
  type DisabledSkill,
  type SkillDeleteResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type StatsResponse,
  type ToggleBatchResponse,
  type ToggleResponse,
  type WritableRoot,
} from '../protocol.ts'
import { createSkill, createSkillInDir, occupancyOf, parseFrontmatter, readSkillInterface, rootOfPath, rootPath, trashSkill } from '../skillfs.ts'
import { projectSkillsRoot } from '../skillfs/paths.ts'
import { errorText } from '../error-text.ts'
import {
  applyInterface,
  buildCatalog,
  configOf,
  homeOf,
  isWritableSource,
  pathExists,
  queryParam,
  readString,
  readStrings,
  resolveWritableSkill,
  toDetail,
  workspaceEntries,
  writeError,
  writeJson,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'

/**
 * 文件创建/修改时间 → 详情行的 addedAt/updatedAt（读取失败时省略字段，
 * 详情页不显示这两行）。禁用态与启用态详情共用。
 */
async function applyFileTimes(row: { addedAt?: number; updatedAt?: number }, path: string): Promise<void> {
  try {
    const times = await stat(path)
    row.addedAt = times.birthtimeMs
    row.updatedAt = times.mtimeMs
  } catch {
    // 文件不可读时省略时间字段。
  }
}

/** 目录域全部路由 spec（由 routes.ts 经 createRoute 包上统一围栏）。 */
/** 按 name（和可选 cwd）找到技能的发现文件路径；找不到返回 undefined。 */
async function discoveryPathOf(deps: SkillHubRouteDeps, name: string, cwd?: string): Promise<string | undefined> {
  try {
    const definition = await deps.skills.get(name, cwd !== undefined ? { cwd } : undefined)
    return definition?.path
  } catch {
    return undefined
  }
}

/**
 * The discovered path when it is outside the hub's writable roots (project or
 * external provider skill). Those are toggled through an invocation override,
 * never through a same-name disabled sidecar record.
 */
async function nonWritableDiscoveryPath(deps: SkillHubRouteDeps, name: string, cwd: string): Promise<string | undefined> {
  if (cwd === '') return undefined
  const discovered = await discoveryPathOf(deps, name, cwd)
  if (discovered === undefined) return undefined
  const path = resolve(discovered)
  return rootOfPath(path, homeOf(deps)) === undefined ? path : undefined
}

/**
 * 重新启用一条停用记录：删掉 invocation override 与台账记录，文件一个字节不动。
 *
 * 第一轮重构后 SKILL.md 始终在位，不再有「改名 → 改回来」这一步，因此也不需要
 * pathExists / 占位自愈那套 rename 时代的兜底。旧记录的 path 可能还带
 * `.disabled` 后缀（启动迁移器尚未运行或失败），两种形式都清一遍。
 */
async function enableDisabledRecord(deps: SkillHubRouteDeps, name: string, record: DisabledSkill): Promise<void> {
  const policyPath = resolve(record.path)
  await deps.store.removeInvocationOverride(policyPath)
  if (policyPath.endsWith('.disabled')) {
    await deps.store.removeInvocationOverride(policyPath.slice(0, -'.disabled'.length))
  }
  await deps.store.removeDisabled(name)
}

interface ToggleOutcome {
  ok: boolean
  /** A "nothing to do" state mismatch: /toggle reports it as 4xx, /toggle-batch skips it. */
  noOp?: boolean
  status?: number
  error?: string
}

/**
 * One enable/disable decision, shared by /toggle and /toggle-batch.
 *
 * The two handlers used to duplicate the whole "non-writable discovery →
 * invocation overrides → disabled sidecar record" chain and had already
 * drifted apart. One implementation means a new skill source only has to be
 * handled once; `noOp` preserves the batch route's historical silent-skip
 * semantics for state mismatches.
 */
async function applyToggle(deps: SkillHubRouteDeps, name: string, enabled: boolean, cwd: string): Promise<ToggleOutcome> {
  const lookupCwd = cwd !== '' ? cwd : undefined
  if (enabled) {
    // With a workspace cwd, a project/external skill is enabled through its
    // invocation override. Resolve that before consulting the disabled sidecar
    // so a same-name user record cannot hijack it.
    const invocationPath = await nonWritableDiscoveryPath(deps, name, cwd)
    if (invocationPath !== undefined) {
      if ((await deps.store.listInvocationOverrides()).includes(invocationPath)) {
        await deps.store.removeInvocationOverride(invocationPath)
        return { ok: true }
      }
      return { ok: false, noOp: true, status: 409, error: 'skill is already enabled: ' + name }
    }
    const record = await deps.store.getDisabled(name)
    if (record !== undefined) {
      await enableDisabledRecord(deps, name, record)
      return { ok: true }
    }
    const discovered = await discoveryPathOf(deps, name, lookupCwd)
    const overridePath = discovered === undefined ? undefined : resolve(discovered)
    if (overridePath === undefined || !(await deps.store.listInvocationOverrides()).includes(overridePath)) {
      return { ok: false, noOp: true, status: 404, error: 'skill is not hub-disabled: ' + name }
    }
    await deps.store.removeInvocationOverride(overridePath)
    return { ok: true }
  }
  const resolved = await resolveWritableSkill(deps, name, lookupCwd)
  if (!resolved.ok) {
    // Project / external read-only skills are paused through an invocation
    // override: not a single byte of the project is touched.
    const discovered = await discoveryPathOf(deps, name, lookupCwd)
    if (discovered === undefined) return { ok: false, status: resolved.status, error: resolved.error }
    await deps.store.addInvocationOverride(resolve(discovered))
    return { ok: true }
  }
  const policyPath = resolve(resolved.path)
  await deps.store.addInvocationOverride(policyPath)
  await deps.store.addDisabled({ name, description: resolved.skill.description, path: policyPath, root: resolved.root, disabledAt: Date.now() })
  return { ok: true }
}

export function catalogRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // ------------------------------------------------------------ catalog
    {
      path: SKILL_HUB_API.catalog,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const cwd = queryParam(url, 'cwd')
        writeJson(res, 200, await buildCatalog(deps, cwd))
      },
    },
    // -------------------------------------------------------------- detail
    {
      path: SKILL_HUB_API.skill,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const name = queryParam(url, 'name')
        if (name === undefined || name === '') { writeError(res, 400, 'name query parameter is required'); return }
        const cwd = queryParam(url, 'cwd')
        // 显式 cwd 只看该工作区；否则按已知工作区逐个查找（与目录默认视图
        // 一致），最后回退用户级根，保证默认视图里可见的项目技能能打开详情。
        let skill: SkillDefinition | undefined
        if (cwd !== undefined && cwd !== '') {
          skill = await deps.skills.get(name, { cwd })
        } else {
          for (const ws of await workspaceEntries(homeOf(deps))) {
            skill = await deps.skills.get(name, { cwd: ws.path })
            if (skill !== undefined) break
          }
          if (skill === undefined) skill = await deps.skills.get(name)
        }
        if (skill === undefined) {
          // A paused skill stays in registry discovery; this fallback only serves
          // a stale ledger record whose file was removed by hand.
          const record = await deps.store.getDisabled(name)
          if (record !== undefined) {
            try {
              const text = await readFile(record.path, 'utf8')
              const parsed = parseFrontmatter(text)
              if (!('error' in parsed)) {
                const disabledDetail: SkillDetail = {
                  name: record.name,
                  description: parsed.value.description,
                  ...(parsed.value.whenToUse !== undefined ? { whenToUse: parsed.value.whenToUse } : {}),
                  invocation: { ...parsed.value.invocation },
                  provider: 'skill-hub (disabled)',
                  path: record.path,
                  content: parsed.value.content,
                }
                await applyFileTimes(disabledDetail, record.path)
                writeJson(res, 200, { ok: true, skill: disabledDetail } satisfies SkillDetailResponse)
                return
              }
            } catch {
              // fall through to 404 below
            }
          }
          writeError(res, 404, 'skill not found: ' + name)
          return
        }
        const detail = toDetail(skill)
        if (skill.path !== undefined) {
          await applyFileTimes(detail, skill.path)
          // Claude Code 的 argument-hint 不在官方 SkillDefinition 里，详情接口
          // 单独从发现文件读出来，避免导入后这行元数据静默消失。
          try {
            const frontmatter = parseFrontmatter(await readFile(skill.path, 'utf8'))
            if (!('error' in frontmatter) && frontmatter.value.argumentHint !== undefined) detail.argumentHint = frontmatter.value.argumentHint
          } catch {
            // best-effort: 详情不该因为一个可选字段读失败而 500
          }
          // UI metadata: codex openai.yaml / workbuddy.json / frontmatter, in that order.
          try {
            const rb = skill.resourceBase as { kind?: string; path?: string } | undefined
            const dir = rb?.kind === 'directory' && typeof rb.path === 'string' ? rb.path : (skill.path.endsWith('SKILL.md') ? dirname(skill.path) : undefined)
            if (dir !== undefined) {
              const iface = await readSkillInterface(dir)
              if (iface !== undefined) applyInterface(detail, iface)
            }
          } catch {
            // best-effort
          }
        }
        writeJson(res, 200, { ok: true, skill: detail } satisfies SkillDetailResponse)
      },
    },
    // -------------------------------------------------------- skill/delete
    // 把单个技能（目录或平面文件）移入回收站（可恢复），并清理禁用记录、tag 成员与来源映射。
    {
      path: SKILL_HUB_API.skillDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const name = readString(body, 'name')
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const cwd = readString(body, 'cwd')
        const resolved = await resolveWritableSkill(deps, name, cwd !== '' ? cwd : undefined)
        // 已禁用的技能不在 registry 中，resolve 会 404，这里单独处理：允许整组删除未开启的技能
        let trashResult: { path: string; source: string } | null = null
        if (!resolved.ok) {
        const disabled = await deps.store.getDisabled(name)
        if (disabled !== undefined) {
          // sidecar 里的路径可能是外部写入/损坏的：移动前必须确认它落在
          // 可写根内（正常路径由 disableSkill 保证，这里只拦异常数据）。
          if (rootOfPath(disabled.path, homeOf(deps)) === undefined) {
            writeError(res, 409, 'disabled skill path is outside the hub writable roots')
            return
          }
          // 记录还在、文件已经不在（手工删了 / 从备份恢复过 sidecar）：这条记录
          // 只是残留，清掉即算删除完成，否则它会永久占住这个名字。
          if (!await pathExists(disabled.path)) {
            await deps.store.removeDisabled(name)
            await deps.store.removeSkillFromTags(name)
            deps.invalidate?.()
            writeJson(res, 200, { ok: true, name, path: disabled.path } satisfies SkillDeleteResponse)
            return
          }
          // 台账里的路径就是发现文件本身（停用不再改名），整体移入回收站。
          // trashSkill 按 SKILL.md / <name>.md 判定目录包还是扁平文件。
          trashResult = await trashSkill(disabled.path)
        } else {
            writeError(res, resolved.status, resolved.error); return
          }
        }
        // 入回收站前快照来源归属与角色成员：恢复时把它们加回来，否则恢复
        // 后的技能会丢失来源（变成「个人技能」）和角色分组。
        const tracked = await deps.store.getSourceForSkill(name)
        const tagIds = (await deps.store.listTags()).filter((tag) => tag.skillNames.includes(name)).map((tag) => tag.id)
        const { path, source } = trashResult ?? await trashSkill((resolved as { ok: true; path: string }).path)
        await deps.store.addTrash({
          name,
          path,
          movedAt: Date.now(),
          sourcePath: source,
          ...(tracked !== undefined
            ? { origin: { repo: tracked.repo, root: tracked.root, ...(tracked.ref !== undefined && tracked.ref !== '' ? { ref: tracked.ref } : {}), commitSha: tracked.commitSha } }
            : {}),
          ...(tagIds.length > 0 ? { tagIds } : {}),
        })
        // 停用策略按发现文件路径记录：删技能时一并清掉，否则同名技能下次
        // 装回来会被一条指向已删文件的 override 静默停用。
        const disabledRecord = await deps.store.getDisabled(name)
        if (disabledRecord !== undefined) await deps.store.removeInvocationOverride(resolve(disabledRecord.path))
        await deps.store.removeDisabled(name)
        await deps.store.removeSkillFromSources(name)
        await deps.store.removeSkillFromTags(name)
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, name, path } satisfies SkillDeleteResponse)
      },
    },
    // -------------------------------------------------------------- toggle
    // 所有技能的停用都走 invocation 覆盖（sidecar 策略），不再改磁盘文件：
    // 同名技能的 modelInvocable 被 provider 压成 false，文件一个字节不动。
    {
      path: SKILL_HUB_API.toggle,
      methods: ['POST'],
      jsonBody: true,
      serialize: true,
      handler: async ({ res, body }) => {
        const name = readString(body, 'name')
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const cwd = readString(body, 'cwd')
        const lookup = cwd !== '' ? { cwd } : undefined
        const enabled = body.enabled === true
        // 幂等：已是目标状态就直接回当前目录。连点/重试的第二个请求原本会撞
        // 409「already enabled」或 404「not hub-disabled」，前端把 4xx 转成红色
        // 错误条 —— 磁盘状态其实早就对了。与 toggle-batch 的 no-op 语义对齐。
        // catalog 里查不到该名字时不短路，交给原逻辑报真实错误，不掩盖「技能不存在」。
        const current = await buildCatalog(deps, lookup?.cwd)
        const active = current.skills.find((entry) => entry.name === name)
        const isOff = active !== undefined ? active.modelOverride === true : current.disabled.some((entry) => entry.name === name)
        const already = enabled ? (active !== undefined && !isOff) : isOff
        if (already) {
          writeJson(res, 200, { ok: true, catalog: current } satisfies ToggleResponse)
          return
        }
        const outcome = await applyToggle(deps, name, enabled, cwd)
        if (!outcome.ok) { writeError(res, outcome.status ?? 400, outcome.error ?? 'toggle failed'); return }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd) } satisfies ToggleResponse)
      },
    },
    // -------------------------------------------------------- toggle-batch
    // One write for a whole group: enables every hub-disabled name, or
    // disables every writable name. Skips already-target states as no-ops;
    // per-name failures are reported, never fatal.
    {
      path: SKILL_HUB_API.toggleBatch,
      methods: ['POST'],
      jsonBody: true,
      serialize: true,
      handler: async ({ res, body }) => {
        const names = readStrings(body, 'names')
        if (names.length === 0) { writeError(res, 400, 'names must be a non-empty array'); return }
        const enabled = body.enabled === true
        const cwd = readString(body, 'cwd')
        const lookup = cwd !== '' ? { cwd } : undefined
        const failures: Array<{ name: string; error: string }> = []
        for (const name of names) {
          try {
            const outcome = await applyToggle(deps, name, enabled, cwd)
            // State mismatches were always silent no-ops on the batch route;
            // real failures (unwritable / unknown) are still reported.
            if (!outcome.ok && outcome.noOp !== true) failures.push({ name, error: outcome.error ?? 'toggle failed' })
          } catch (error) {
            failures.push({ name, error: errorText(error) })
          }
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, catalog: await buildCatalog(deps, lookup?.cwd), failures } satisfies ToggleBatchResponse)
      },
    },
    // -------------------------------------------------------------- create
    {
      path: SKILL_HUB_API.create,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const name = readString(body, 'name').trim()
        if (!isSkillName(name)) { writeError(res, 400, 'skill name must be kebab-case (lowercase letters, digits, dashes)'); return }
        const workspaceText = body.workspace === undefined ? '' : readString(body, 'workspace')
        const home = homeOf(deps)
        let path: string
        let createdRoot: WritableRoot | undefined
        let createdWorkspace: string | undefined
        if (workspaceText !== '') {
          // 仅允许宿主已登记的工作区；创建目标固定为 <workspace>/.dsh/skills。
          const workspace = resolve(workspaceText)
          const known = await workspaceEntries(home)
          if (!known.some((entry) => resolve(entry.path) === workspace)) {
            writeError(res, 400, 'workspace is not registered: ' + workspace)
            return
          }
          const existing = await deps.skills.get(name, { cwd: workspace })
          if (existing !== undefined) { writeError(res, 409, 'skill name already exists: ' + name); return }
          // Check both project roots: .dsh/skills is the default target, but a
          // broken/disabled file in .agents/skills still occupies the name.
          for (const base of [projectSkillsRoot(workspace), join(workspace, '.agents', 'skills')]) {
            const occupancy = await occupancyOf(base, name)
            if (occupancy.enabled.length > 0) {
              writeError(res, 409, 'a skill file already occupies this name on disk: ' + name + ' (check the discovery diagnostics)')
              return
            }
            if (occupancy.disabled.length > 0 || occupancy.bareDir !== undefined) {
              writeError(res, 409, 'name is occupied by a disabled placeholder or an empty directory on disk: ' + name + ' (check the discovery diagnostics)')
              return
            }
          }
          path = await createSkillInDir(projectSkillsRoot(workspace), name, readString(body, 'description'), readString(body, 'body'))
          createdWorkspace = workspace
        } else {
          // 缺省根 = user-dsh；给了但类型/取值不合法时保持原样交给下面的校验拒绝。
          const rootText = body.root === undefined ? 'user-dsh' : readString(body, 'root')
          if (!isWritableSource(rootText)) { writeError(res, 400, 'root must be user-dsh or user-agents'); return }
          const root: WritableRoot = rootText
          const existing = await deps.skills.get(name)
          if (existing !== undefined) { writeError(res, 409, 'skill name already exists: ' + name); return }
          if (await deps.store.getDisabled(name) !== undefined) { writeError(res, 409, 'skill name is disabled: re-enable it from the disabled list first'); return }
          // 建档前先看磁盘：三种占位都会让新目录与旧文件并存成同名两形态 ——
          // 已启用的发现文件（frontmatter 坏了因此注册表看不见）、已禁用的占位
          // （目录包或扁平）、以及没有 SKILL.md 的空壳目录（正是发现诊断在报的东西）。
          const occupancy = await occupancyOf(rootPath(root, home), name)
          if (occupancy.enabled.length > 0) {
            writeError(res, 409, 'a skill file already occupies this name on disk: ' + name + ' (check the discovery diagnostics)')
            return
          }
          if (occupancy.disabled.length > 0 || occupancy.bareDir !== undefined) {
            writeError(res, 409, 'name is occupied by a disabled placeholder or an empty directory on disk: ' + name + ' (check the discovery diagnostics)')
            return
          }
          path = await createSkill(root, name, readString(body, 'description'), home, readString(body, 'body'))
          createdRoot = root
        }
        // 新技能自动归入默认角色（「通用」）。
        const defaultTag = await deps.store.getDefaultTag()
        if (defaultTag !== undefined) await deps.store.addSkillToTag(defaultTag.id, name)
        deps.invalidate?.()
        writeJson(res, 201, { ok: true, path, ...(createdRoot !== undefined ? { root: createdRoot } : {}), ...(createdWorkspace !== undefined ? { workspace: createdWorkspace } : {}) } satisfies CreateResponse)
      },
    },
    // ---------------------------------------------------------------- stats
    {
      path: SKILL_HUB_API.stats,
      methods: ['GET'],
      handler: async ({ res }) => {
        if (deps.stats === undefined) {
          writeJson(res, 200, { ok: true, available: false, stats: [] } satisfies StatsResponse)
          return
        }
        // All usage displays off means nobody reads statistics: answer
        // unavailable without invoking the reader, so no scan is triggered.
        const display = configOf(deps)
        if (display.showUseCount === false && display.showUseTime === false && display.showGroupSummary === false) {
          writeJson(res, 200, { ok: true, available: false, stats: [] } satisfies StatsResponse)
          return
        }
        const stats = await deps.stats()
        writeJson(res, 200, { ok: true, available: true, ...(deps.stats.source !== undefined ? { source: deps.stats.source } : {}), stats } satisfies StatsResponse)
      },
    },
  ]
}
