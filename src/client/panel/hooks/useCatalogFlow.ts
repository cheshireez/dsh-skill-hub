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
import { sortSkills, type SortKey } from '../../grouping.ts'
import type { FlowNotices, UsesMap } from './shared.ts'

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
  const [search, setSearch] = useState('')
  /** 工作区（项目）路径；空 = 只看用户级技能。 */
  const [workspace, setWorkspace] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formRoot, setFormRoot] = useState<WritableRoot>('user-dsh')
  const [formBusy, setFormBusy] = useState(false)
  const [formMessage, setFormMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [fixingPaths, setFixingPaths] = useState<ReadonlySet<string>>(new Set())
  const [invocationFilter, setInvocationFilter] = useState<'all' | 'model' | 'user'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('name')

  const autoCollapsedPersonal = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.catalog(workspace !== '' ? { cwd: workspace } : undefined)
      setCatalog(next)
      if (!autoCollapsedPersonal.current && next.skills.length + next.disabled.length > 80) {
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

  const openDetail = useCallback(async (name: string): Promise<void> => {
    setDetailLoading(true)
    shared.clearFail()
    try {
      setDetail(await api.skill(name, workspace !== '' ? { cwd: workspace } : undefined))
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setDetailLoading(false)
    }
  }, [api, workspace, shared])

  const toggle = useCallback(async (skill: CatalogSkill, enabled: boolean): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(skill.name))
    shared.clearFail()
    try {
      const next = await api.toggle(skill.name, enabled)
      setCatalog(next)
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(skill.name)
        return next
      })
    }
  }, [api, shared])

  const enableDisabled = useCallback(async (record: DisabledSkill): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(record.name))
    shared.clearFail()
    try {
      const next = await api.toggle(record.name, true)
      setCatalog(next)
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(record.name)
        return next
      })
    }
  }, [api, shared])

  /** Toggle an explicit name set in one write (enables disabled members too). */
  const batchToggleNames = useCallback(async (names: string[], enabled: boolean): Promise<void> => {
    if (names.length === 0) return
    shared.setBatchBusy(true)
    shared.clearFail()
    try {
      const next = await api.toggleBatch(names, enabled)
      setCatalog(next.catalog)
      if (next.failures.length > 0) {
        shared.fail('toggle-batch: ' + next.failures.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setBatchBusy(false)
    }
  }, [api, shared])

  const fixDiagnostic = useCallback(async (path: string): Promise<void> => {
    setFixingPaths((previous) => new Set(previous).add(path))
    shared.clearFail()
    try {
      const confirmed = window.confirm(tt('diag.fixConfirm', { path }))
      if (!confirmed) return
      await api.fixDiagnostic(path)
      await load()
      shared.succeed(tt('diag.fixed'))
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setFixingPaths((previous) => {
        const next = new Set(previous)
        next.delete(path)
        return next
      })
    }
  }, [api, load, shared])

  const create = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setFormBusy(true)
    setFormMessage(null)
    shared.succeed(null)
    try {
      const result = await api.create({ name: formName, description: formDesc, root: formRoot })
      // The form closes on success, so the confirmation lives in the green
      // banner outside it (a success message inside the closing form is
      // never visible).
      shared.succeed(tt('form.success') + result.path)
      setFormName('')
      setFormDesc('')
      setShowForm(false)
      await load()
    } catch (error) {
      setFormMessage({ kind: 'error', text: tt('form.error') + errorMessage(error) })
    } finally {
      setFormBusy(false)
    }
  }, [api, formName, formDesc, formRoot, load, shared])

  // ------------------------------------------------------------- derived

  const normalized = search.trim().toLocaleLowerCase()

  /** 当前启用且可写的技能名（组开关只作用于它们）。 */
  const actionNames = useMemo(() => new Set((catalog?.skills ?? []).filter((skill) => skill.writable).map((skill) => skill.name)), [catalog])

  /** 当前启用的全部技能名（含只读，用于派生开关状态）。 */
  const viewNames = useMemo(() => new Set((catalog?.skills ?? []).map((skill) => skill.name)), [catalog])

  const filtered = useMemo(() => (catalog?.skills ?? []).filter((skill) => {
    if (invocationFilter === 'model' && !skill.invocation.modelInvocable) return false
    if (invocationFilter === 'user' && !skill.invocation.userInvocable) return false
    if (normalized.length === 0) return true
    return skill.name.toLocaleLowerCase().includes(normalized)
      || skill.description.toLocaleLowerCase().includes(normalized)
      || skill.displayName?.toLocaleLowerCase().includes(normalized)
      || skill.shortDescription?.toLocaleLowerCase().includes(normalized)
  }), [catalog, normalized, invocationFilter])
  /** Rows actually rendered with a shortened description (shortDescription in use). */
  const shortenedCount = useMemo(() => filtered.filter((skill) => skill.shortDescription !== undefined).length, [filtered])
  /** 排序后的技能列表（所有视图共用；调用次数未知按 0 处理）。 */
  const sorted = useMemo(() => sortSkills(filtered, sortKey, (name) => uses.get(name)?.count), [filtered, sortKey, uses])

  /** Clear the list filters (search + source + invocation) back to the full view. */
  const clearListFilters = useCallback((): void => {
    setSearch('')
    clearSourceFilter()
    setInvocationFilter('all')
  }, [clearSourceFilter])

  return {
    catalog, loading, detail, detailLoading, busyNames, search, workspace,
    showForm, formName, formDesc, formRoot, formBusy, formMessage, fixingPaths,
    invocationFilter, sortKey, normalized, actionNames, viewNames,
    filtered, sorted, shortenedCount,
    setDetail, setSearch, setWorkspace, setShowForm, setFormName, setFormDesc,
    setFormRoot, setFormMessage, setInvocationFilter, setSortKey,
    load, openDetail, toggle, enableDisabled, batchToggleNames, fixDiagnostic, create, clearListFilters,
  }
}
