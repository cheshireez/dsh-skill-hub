/**
 * 目录域路由：catalog / skill 详情 / skill 删除 / toggle / toggle-batch /
 * create / stats。从 routes.ts 原样搬出，handler 逻辑不变。
 */

import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import {
  SKILL_HUB_API,
  type CreateResponse,
  type SkillDeleteResponse,
  type SkillDetail,
  type SkillDetailResponse,
  type StatsResponse,
  type ToggleBatchResponse,
  type ToggleResponse,
  type WritableRoot,
} from '../protocol.ts'
import { createSkill, disableSkill, enableSkill, parseFrontmatter, readSkillInterface, rootPath, trashSkill } from '../skillfs.ts'
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
          // Hub-disabled skills live outside registry discovery (renamed to .disabled);
          // serve their detail straight from the sidecar record + file.
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
          // UI metadata from agents/openai.yaml beside the skill directory (codex).
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
            // 禁用态：SKILL.md.disabled 或 *.md.disabled，直接将其所在技能整体移入回收站
            const isBundleDisabled = disabled.path.endsWith('SKILL.md.disabled')
            const sourceToTrash = isBundleDisabled ? dirname(disabled.path) : disabled.path
            const trashDir = join(dirname(sourceToTrash), '.trash')
            await mkdir(trashDir, { recursive: true })
            const target = join(trashDir, basename(sourceToTrash) + '-' + Date.now())
            await rename(sourceToTrash, target)
            trashResult = { path: target, source: sourceToTrash }
          } else {
            writeError(res, resolved.status, resolved.error); return
          }
        }
        // 入回收站前快照来源归属与场景成员：恢复时把它们加回来，否则恢复
        // 后的技能会丢失来源（变成「个人技能」）和场景分组。
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
        await deps.store.removeDisabled(name)
        await deps.store.removeSkillFromSources(name)
        await deps.store.removeSkillFromTags(name)
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, name, path } satisfies SkillDeleteResponse)
      },
    },
    // -------------------------------------------------------------- toggle
    {
      path: SKILL_HUB_API.toggle,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const name = readString(body, 'name')
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const cwd = readString(body, 'cwd')
        const lookup = cwd !== '' ? { cwd } : undefined
        if (body.enabled === true) {
          const record = await deps.store.getDisabled(name)
          if (record === undefined) { writeError(res, 404, 'skill is not hub-disabled: ' + name); return }
          try {
            await enableSkill(record.path)
          } catch (error) {
            // The renamed file may have vanished (external cleanup); report
            // precisely instead of a generic 500, like toggle-batch does.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              writeError(res, 409, 'disabled skill file is missing on disk: ' + record.path)
              return
            }
            throw error
          }
          await deps.store.removeDisabled(name)
        } else {
          const resolved = await resolveWritableSkill(deps, name, cwd !== '' ? cwd : undefined)
          if (!resolved.ok) { writeError(res, resolved.status, resolved.error); return }
          const disabledPath = await disableSkill(resolved.path)
          await deps.store.addDisabled({
            name,
            description: resolved.skill.description,
            path: disabledPath,
            root: resolved.root,
            disabledAt: Date.now(),
          })
        }
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
      handler: async ({ res, body }) => {
        const names = readStrings(body, 'names')
        if (names.length === 0) { writeError(res, 400, 'names must be a non-empty array'); return }
        const enabled = body.enabled === true
        const cwd = readString(body, 'cwd')
        const lookup = cwd !== '' ? { cwd } : undefined
        const failures: Array<{ name: string; error: string }> = []
        for (const name of names) {
          try {
            if (enabled) {
              const record = await deps.store.getDisabled(name)
              if (record === undefined) continue // already enabled: no-op
              await enableSkill(record.path)
              await deps.store.removeDisabled(name)
            } else {
              const resolved = await resolveWritableSkill(deps, name, cwd !== '' ? cwd : undefined)
              if (!resolved.ok) { failures.push({ name, error: resolved.error }); continue }
              const disabledPath = await disableSkill(resolved.path)
              await deps.store.addDisabled({ name, description: resolved.skill.description, path: disabledPath, root: resolved.root, disabledAt: Date.now() })
            }
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
        // 缺省根 = user-dsh；给了但类型/取值不合法时保持原样交给下面的校验拒绝。
        const rootText = body.root === undefined ? 'user-dsh' : readString(body, 'root')
        if (!isWritableSource(rootText)) { writeError(res, 400, 'root must be user-dsh or user-agents'); return }
        const root: WritableRoot = rootText
        const existing = await deps.skills.get(name)
        if (existing !== undefined) { writeError(res, 409, 'skill name already exists: ' + name); return }
        if (await deps.store.getDisabled(name) !== undefined) { writeError(res, 409, 'skill name is disabled: re-enable it from the disabled list first'); return }
        // A directory may exist without producing a registry entry (invalid
        // frontmatter — exactly what the diagnostics section reports).
        // Refuse to overwrite it instead of silently truncating its SKILL.md.
        const target = join(rootPath(root, homeOf(deps)), name)
        if (await pathExists(target)) {
          writeError(res, 409, 'skill directory already exists on disk: ' + name + ' (check the discovery diagnostics)')
          return
        }
        const path = await createSkill(root, name, readString(body, 'description'), homeOf(deps))
        // 新技能自动归入默认场景（「通用」）。
        const defaultTag = await deps.store.getDefaultTag()
        if (defaultTag !== undefined) await deps.store.addSkillToTag(defaultTag.id, name)
        deps.invalidate?.()
        writeJson(res, 201, { ok: true, path, root } satisfies CreateResponse)
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
