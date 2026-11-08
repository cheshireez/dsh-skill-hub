/**
 * useCatalogFlow — 目录域：catalog 加载、详情、开关（单个/禁用态/批量）、
 * 新建、诊断修复，以及列表过滤/排序派生。跨域刷新只通过 shared 通知，
 * 不直接碰其他域的 state。
 */

import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  CatalogResponse,
  CatalogSkill,
  DisabledSkill,
  SkillDetail,
  WritableRoot,
} from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage, tt } from '../../helpers.ts'
import { filterSkillsByQuery, filterSkillsByStatus, sortSkills, type InvocationFilter, type SkillStatusFilter, type SortKey } from '../../grouping.ts'
import { runFlow, type FlowNotices, type UsesMap } from './shared.ts'

export type { SkillStatusFilter }

export function useCatalogFlow(
  api: SkillHubApi,
  uses: UsesMap,
  shared: FlowNotices,
  /** 技能总数 >80 时折叠 personal 分组（聚合根实现，状态归它）。 */
  collapsePersonal: () => void,
  /** 清掉来源筛选（状态归聚合根，这里只在清空筛选项时调用）。 */
  clearSourceFilter: () => void,
) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(new Set())
  /** 同步门闩：busyNames 是异步 state，挡不住同一帧内的连点。 */
  const pendingToggles = useRef<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  /** 工作区（项目）路径；空 = 只看用户级技能。 */
  const [workspace, setWorkspace] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formBody, setFormBody] = useState('')
  const [formRoot, setFormRoot] = useState<WritableRoot>('user-dsh')
  const [formWorkspace, setFormWorkspace] = useState('')
  const [formBusy, setFormBusy] = useState(false)
  const [formMessage, setFormMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [fixingPaths, setFixingPaths] = useState<ReadonlySet<string>>(new Set())
  const [invocationFilter, setInvocationFilter] = useState<InvocationFilter>('all')
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('name')

  const autoCollapsedPersonal = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    // 有开关写在途时别用旧快照盖掉乐观 UI（5 秒轮询正好会撞上）。
    if (pendingToggles.current.size > 0) return
    try {
      const next = await api.catalog(workspace !== '' ? { cwd: workspace } : undefined)
      setCatalog(next)
      // 停用技能已在 next.skills 里，台账 disabled[] 不能再加一遍。
      if (!autoCollapsedPersonal.current && next.skills.length > 80) {
        autoCollapsedPersonal.current = true
        collapsePersonal()
      }
      shared.clearFail()
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [api, workspace, shared, collapsePersonal])

  const openDetail = useCallback(async (name: string, skillWorkspace?: string): Promise<void> => {
    const target = skillWorkspace !== undefined && skillWorkspace !== '' ? skillWorkspace : workspace
    setDetailLoading(true)
    await runFlow(shared, async () => {
      setDetail(await api.skill(name, target !== '' ? { cwd: target } : undefined))
    }, () => setDetailLoading(false))
  }, [api, workspace, shared])

  const toggle = useCallback(async (skill: CatalogSkill, enabled: boolean): Promise<void> => {
    const key = skill.name + '\0' + (skill.workspace ?? '')
    // 同步门闩先挡连点：busyNames 要等下一次 render 才生效，同一帧内两次点击都会放行。
    if (pendingToggles.current.has(key)) return
    pendingToggles.current.add(key)
    setBusyNames((previous) => new Set(previous).add(skill.name))
    // 乐观更新：先把界面那一行切到目标状态，成功用服务端整份 catalog 覆盖。
    // 回滚只能在 catch 里做 —— 之前放在 runFlow 的 settle（finally）里，成功后
    // 又把刚拿到的服务端真值盖回点击前的快照，开关看起来「点了没反应」；
    // 用户再点一次就撞上状态冲突 4xx，弹出红色错误条。这就是连点爆红的根因。
    const snapshot = catalog
    setCatalog((previous) => flipSkillEnabled(previous, skill.name, enabled))
    shared.clearFail()
    try {
      const next = await api.toggle(skill.name, enabled, skill.workspace !== undefined && skill.workspace !== '' ? { cwd: skill.workspace } : undefined)
      setCatalog(next)
    } catch (error) {
      // 只把目标行恢复成快照，其余行保留期间被别的操作改过的值。
      setCatalog((current) => (current === null || snapshot === null ? current : rollbackSkillToSnapshot(current, snapshot, skill.name)))
      shared.fail(errorMessage(error))
    } finally {
      pendingToggles.current.delete(key)
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(skill.name)
        return next
      })
    }
  }, [api, shared, catalog])

  const enableDisabled = useCallback(async (record: DisabledSkill): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(record.name))
    await runFlow(shared, async () => {
      const next = await api.toggle(record.name, true)
      setCatalog(next)
    }, () => {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(record.name)
        return next
      })
    })
  }, [api, shared])

  /** Toggle an explicit name set in one write (enables disabled members too). */
  const batchToggleNames = useCallback(async (names: string[], enabled: boolean): Promise<void> => {
    if (names.length === 0) return
    shared.setBatchBusy(true)
    await runFlow(shared, async () => {
      const next = await api.toggleBatch(names, enabled)
      setCatalog(next.catalog)
      if (next.failures.length > 0) {
        shared.fail('toggle-batch: ' + next.failures.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
    }, () => shared.setBatchBusy(false))
  }, [api, shared])

  const fixDiagnostic = useCallback(async (path: string): Promise<void> => {
    setFixingPaths((previous) => new Set(previous).add(path))
    await runFlow(shared, async () => {
      const confirmed = window.confirm(tt('diag.fixConfirm', { path }))
      if (!confirmed) return
      await api.fixDiagnostic(path)
      await load()
      shared.succeed(tt('diag.fixed'))
    }, () => {
      setFixingPaths((previous) => {
        const next = new Set(previous)
        next.delete(path)
        return next
      })
    })
  }, [api, load, shared])

  const create = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setFormBusy(true)
    setFormMessage(null)
    shared.succeed(null)
    try {
      const target = formWorkspace !== '' ? { workspace: formWorkspace } : { root: formRoot }
      const result = await api.create({ name: formName, description: formDesc, body: formBody, ...target })
      // The form closes on success, so the confirmation lives in the green
      // banner outside it (a success message inside the closing form is
      // never visible).
      shared.succeed(tt('form.success') + result.path)
      setFormName('')
      setFormDesc('')
      setFormBody('')
      setFormWorkspace('')
      setShowForm(false)
      await load()
    } catch (error) {
      setFormMessage({ kind: 'error', text: tt('form.error') + errorMessage(error) })
    } finally {
      setFormBusy(false)
    }
  }, [api, formName, formDesc, formBody, formRoot, formWorkspace, load, shared])

  // ------------------------------------------------------------- derived

  const workspaces = useMemo(() => catalog?.workspaces ?? [], [catalog])

  /** 当前可安全切换的技能名（文件可写或可走 invocation 覆盖）。 */
  const actionNames = useMemo(() => new Set((catalog?.skills ?? []).filter((skill) => skill.writable || skill.toggleable === true).map((skill) => skill.name)), [catalog])

  /**
   * 当前**启用中**的技能名（含只读），用于派生分组三态开关。停用技能仍留在
   * `catalog.skills` 里（带 `modelOverride`），必须排除 —— 否则每组都算「全开」，
   * 组开关就只剩关闭一条路，点第二次永远开不回来。
   */
  const viewNames = useMemo(() => new Set((catalog?.skills ?? []).filter((skill) => skill.modelOverride !== true).map((skill) => skill.name)), [catalog])

  /**
   * Search + invocation filters. These are view-independent: every view honours
   * them, so they live above the status split.
   */
  const searched = useMemo(
    () => filterSkillsByQuery(catalog?.skills ?? [], search, invocationFilter),
    [catalog, search, invocationFilter],
  )
  /**
   * `searched` plus the status filter — the row source for list views. Role
   * cards deliberately skip this (they read `searchedSorted`): a persisted
   * "enabled only" filter must never shrink a roster, because a role is a named
   * list the user curated.
   */
  const filtered = useMemo(() => filterSkillsByStatus(searched, statusFilter), [searched, statusFilter])
  /**
   * Rows carrying a shortened description, over the search-filtered set. That
   * is a view-independent upper bound: the roles view also renders paused rows,
   * so counting `filtered` would under-report there.
   */
  const shortenedCount = useMemo(() => searched.filter((skill) => skill.shortDescription !== undefined).length, [searched])
  /** 排序后的技能列表（列表视图共用；调用次数未知按 0 处理）。 */
  const sorted = useMemo(() => sortSkills(filtered, sortKey, (name) => uses.get(name)?.count), [filtered, sortKey, uses])
  /** Same ordering without the status filter — the roles view's row source. */
  const searchedSorted = useMemo(() => sortSkills(searched, sortKey, (name) => uses.get(name)?.count), [searched, sortKey, uses])

  /** Clear the list filters (search + source + invocation + status) back to the full view. */
  const clearListFilters = useCallback((): void => {
    setSearch('')
    clearSourceFilter()
    setInvocationFilter('all')
    setStatusFilter('all')
  }, [clearSourceFilter])

  return {
    catalog, loading, detail, detailLoading, busyNames, search, workspace,
    showForm, formName, formDesc, formBody, formRoot, formWorkspace, workspaces, formBusy, formMessage, fixingPaths,
    invocationFilter, statusFilter, sortKey, actionNames, viewNames,
    filtered, sorted, searchedSorted, shortenedCount,
    setDetail, setSearch, setWorkspace, setShowForm, setFormName, setFormDesc, setFormBody,
    setFormRoot, setFormWorkspace, setFormMessage, setInvocationFilter, setStatusFilter, setSortKey,
    load, openDetail, toggle, enableDisabled, batchToggleNames, fixDiagnostic, create, clearListFilters,
  }
}

/* ---------------------------------------------------------------- 乐观更新辅助 */

/**
 * 返回一份「把指定技能切到 enabled」的新 catalog（纯函数，不改入参）。
 * 语义与后端一致：`enabled === false` 表示关掉模型调用（modelOverride = true），
 * `enabled === true` 表示打开（清掉 modelOverride）。找不到该技能时原样返回。
 */
export function flipSkillEnabled(catalog: CatalogResponse | null, name: string, enabled: boolean): CatalogResponse | null {
  if (catalog === null) return null
  let changed = false
  const skills = catalog.skills.map((skill) => {
    if (skill.name !== name) return skill
    changed = true
    if (enabled) {
      if (skill.modelOverride === undefined) return skill
      const next = { ...skill }
      delete next.modelOverride
      return next
    }
    return skill.modelOverride === true ? skill : { ...skill, modelOverride: true }
  })
  return changed ? { ...catalog, skills } : catalog
}

/**
 * 失败回滚：把 `name` 这一行恢复成 `snapshot` 里的状态，其余行保留
 * （因为请求期间其它技能可能已被其它操作更新，不能整体盖回去）。
 * 只在 toggle 的 catch 里调用；成功路径用服务端返回的整份 catalog 覆盖。
 */
export function rollbackSkillToSnapshot(current: CatalogResponse, snapshot: CatalogResponse, name: string): CatalogResponse {
  const before = snapshot.skills.find((skill) => skill.name === name)
  if (before === undefined) return current
  return {
    ...current,
    skills: current.skills.map((skill) => (skill.name === name ? before : skill)),
  }
}
