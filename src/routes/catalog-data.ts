/**
 * routes 共享层 · 目录装配：已知工作区清单、完整目录响应（时间戳/interface
 * 元数据/重名诊断）与详情映射。从 helpers.ts 原样搬出，行为不变。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import {
  isProjectSource,
  type CatalogResponse,
  type CatalogSkill,
  type SkillDetail,
  type WritableRoot,
} from '../protocol.ts'
import { rootPath, readSkillInterface, scanDiagnostics, type SkillInterface } from '../skillfs.ts'
import { CURRENT_VERSION } from '../update.ts'
import { homeOf, isWritableSource, type SkillHubRouteDeps } from './deps.ts'

/** 目录中存在的技能名集合（tag 成员校验用）：启用目录 ∪ 已禁用名单，避免成员因禁用而丢失。 */
export async function knownSkillNames(deps: SkillHubRouteDeps): Promise<Set<string>> {
  const snapshot = await deps.skills.snapshot()
  const names = new Set(snapshot.skills.map((skill) => skill.name))
  for (const disabled of await deps.store.listDisabled()) names.add(disabled.name)
  return names
}

/** 已知工作区条目（dsh 的 workspace.json 表）。 */
export interface WorkspaceEntry {
  path: string
  title: string
}

/**
 * 读取 dsh 的已知工作区清单（~/.dsh/storages/workspace.json 的
 * tables.workspaces 表）。面板默认视图据此合并所有工作区的项目技能；
 * 文件缺失/损坏时返回空清单（回退为仅用户级视图）。
 */
export async function workspaceEntries(home: string): Promise<WorkspaceEntry[]> {
  try {
    const raw = await readFile(join(home, 'storages', 'workspace.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const tables = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).tables as Record<string, unknown> | undefined
      : undefined
    const workspaces = tables !== undefined && typeof tables === 'object'
      ? (tables as Record<string, unknown>).workspaces as Record<string, unknown> | undefined
      : undefined
    const entries: WorkspaceEntry[] = []
    if (workspaces !== undefined && typeof workspaces === 'object') {
      for (const record of Object.values(workspaces)) {
        const entry = record as { path?: unknown; title?: unknown } | null
        if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && entry.path !== '') {
          entries.push({
            path: entry.path,
            title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : entry.path,
          })
        }
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Build the full catalog response (shared by catalog/toggle/create handlers).
 * 显式 cwd 只看该工作区；否则合并所有已知工作区（workspace.json）的项目技能
 * + 用户级技能，同名技能先到先得；没有任何工作区时回退为仅用户级视图。
 */
export async function buildCatalog(deps: SkillHubRouteDeps, cwd?: string): Promise<CatalogResponse> {
  const home = homeOf(deps)
  let workspaces: WorkspaceEntry[]
  if (cwd !== undefined && cwd !== '') {
    workspaces = [{ path: cwd, title: cwd }]
  } else {
    workspaces = await workspaceEntries(home)
    if (workspaces.length === 0) workspaces = [{ path: '', title: '' }]
  }
  // Project skills with same name but different workspace are distinct entries (grouped by workspace in SourcesView), so key includes workspace for project sources.
  const byKey = new Map<string, { skill: SkillSummary; workspace?: string; workspaceTitle?: string }>()
  // Distinct identities per logical key: the same skill reappearing across
  // workspace snapshots (same source+provider) is one skill, not a duplicate.
  // Only different source/provider identities sharing a name are ambiguous.
  const identitiesByKey = new Map<string, Set<string>>()
  let complete = true
  for (const ws of workspaces) {
    const lookup = ws.path !== '' ? { cwd: ws.path } : undefined
    const snapshot = await deps.skills.snapshot(lookup)
    if (!snapshot.complete) complete = false
    for (const skill of snapshot.skills) {
      const logicalKey = isProjectSource(skill.source) && ws.path !== '' ? `${skill.name}\0${ws.path}\0${skill.source}` : skill.name
      let identities = identitiesByKey.get(logicalKey)
      if (identities === undefined) {
        identities = new Set()
        identitiesByKey.set(logicalKey, identities)
      }
      identities.add(skill.source + '\0' + skill.provider)
      if (byKey.has(logicalKey)) continue
      byKey.set(logicalKey, {
        skill,
        ...(isProjectSource(skill.source) && ws.path !== '' ? { workspace: ws.path, workspaceTitle: ws.title } : {}),
      })
    }
  }
  const disabled = await deps.store.listDisabled()
  const byName = byKey
  // A hub-disabled record whose name is also enabled elsewhere hides one
  // identity behind the toggle; flag it as well.
  for (const d of disabled) {
    let identities = identitiesByKey.get(d.name)
    if (identities === undefined) {
      identities = new Set()
      identitiesByKey.set(d.name, identities)
    }
    identities.add('hub-disabled\0' + d.root)
  }
  const duplicateNames = [...identitiesByKey.entries()]
    .filter(([, identities]) => identities.size > 1)
    .map(([key]) => key.split('\0')[0])
    .filter((name, idx, arr) => arr.indexOf(name) === idx)
    .sort((a, b) => a.localeCompare(b))
  // 添加/更新时间 = 用户级技能文件的创建/修改时间（排序与详情展示用）。
  // snapshot 只给 SkillSummary（无 path），所以按可写根推断路径；非用户级
  // 来源没有稳定路径，省略字段，客户端排序会把它放到末尾。
  // 全部技能并发收集（面板每 5 秒轮询一次，逐个串行 stat 会让响应随技能
  // 数量线性变慢）。
  const timesByName = new Map<string, { addedAt: number; updatedAt: number }>()
  await Promise.all([...byName.values()].map(async ({ skill }) => {
    if (!isWritableSource(skill.source)) return
    const base = rootPath(skill.source as WritableRoot, home)
    for (const candidate of [join(base, skill.name, 'SKILL.md'), join(base, skill.name), join(base, skill.name + '.md')]) {
      try {
        const times = await stat(candidate)
        timesByName.set(skill.name, { addedAt: times.birthtimeMs, updatedAt: times.mtimeMs })
        return
      } catch {
        // 目录/文件不存在则尝试下一个候选路径。
      }
    }
  }))
  // UI metadata from agents/openai.yaml (codex SkillInterface) — best-effort, no error if missing.
  // 按逻辑键（name[+workspace+source]）而非技能名缓存：两个工作区的同名项目
  // 技能是不同的行，否则会互相串显示最后读到的那份 interface。
  const interfaceByName = new Map<string, SkillInterface>()
  await Promise.all([...byName.entries()].map(async ([logicalKey, { skill, workspace }]) => {
    const candidates: string[] = []
    if (isWritableSource(skill.source as WritableRoot)) {
      candidates.push(join(rootPath(skill.source as WritableRoot, home), skill.name))
    } else if (isProjectSource(skill.source) && workspace !== undefined) {
      candidates.push(join(workspace, skill.source === 'project-dsh' ? '.dsh/skills' : '.agents/skills', skill.name))
    } else if (isProjectSource(skill.source)) {
      for (const ws of workspaces) if (ws.path !== '') candidates.push(join(ws.path, skill.source === 'project-dsh' ? '.dsh/skills' : '.agents/skills', skill.name))
    }
    for (const dir of candidates) {
      try {
        const iface = await readSkillInterface(dir)
        if (iface !== undefined) {
          interfaceByName.set(logicalKey, iface)
          return
        }
      } catch {
        // ignore
      }
    }
  }))
  const skills: CatalogSkill[] = [...byName.entries()].map(([logicalKey, { skill, workspace, workspaceTitle }]) => {
    const row: CatalogSkill = {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: {
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
      },
      provider: skill.provider,
      writable: isWritableSource(skill.source),
      source: skill.source,
      ...(workspace !== undefined ? { workspace, workspaceTitle: workspaceTitle ?? workspace } : {}),
    }
    const times = timesByName.get(skill.name)
    if (times !== undefined) {
      row.addedAt = times.addedAt
      row.updatedAt = times.updatedAt
    }
    const iface = interfaceByName.get(logicalKey)
    if (iface !== undefined) applyInterface(row, iface)
    return row
  })
  const diagnostics = [
    ...(await scanDiagnostics('user-dsh', home)),
    ...(await scanDiagnostics('user-agents', home)),
  ]
  return {
    ok: true,
    pluginVersion: CURRENT_VERSION,
    complete,
    skills,
    disabled,
    diagnostics,
    ...(duplicateNames.length > 0 ? { duplicateNames } : {}),
  }
}

/** agents/openai.yaml 的 interface 元数据 → 目录行/详情行（catalog 与详情共用）。 */
export function applyInterface<T extends SkillInterface>(row: T, iface: SkillInterface): void {
  if (iface.displayName !== undefined) row.displayName = iface.displayName
  if (iface.shortDescription !== undefined) row.shortDescription = iface.shortDescription
  if (iface.brandColor !== undefined) row.brandColor = iface.brandColor
  if (iface.iconSmall !== undefined) row.iconSmall = iface.iconSmall
  if (iface.iconLarge !== undefined) row.iconLarge = iface.iconLarge
  if (iface.defaultPrompt !== undefined) row.defaultPrompt = iface.defaultPrompt
}

/** Map a loaded definition onto the wire shape. */
export function toDetail(skill: SkillDefinition): SkillDetail {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    invocation: {
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    },
    provider: skill.provider,
    ...(skill.path !== undefined ? { path: skill.path } : {}),
    content: skill.content,
  }
}
