/**
 * useSkillHub — the panel's state owner. Everything the skill hub panel
 * knows (catalog, groups, sources, market, dialogs, drafts) plus every
 * async flow lives here; the panel itself only renders. All hooks run
 * unconditionally at the top, so the panel may early-return for the detail
 * and tag-editor views without violating the rules of hooks.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  CatalogResponse,
  CatalogSkill,
  DisabledSkill,
  GroupsResponse,
  HubConfig,
  MarketCheckResponse,
  MarketSourceRecord,
  RepoDiscoverResponse,
  RepoImportResponse,
  SkillDetail,
  SkillTag,
  SourceCheckResult,
  SourcesResponse,
  UpdateCheckResponse,
  WritableRoot,
} from '../../protocol.ts'
import type { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import { conflictsOnClose, isProjectSource, PRIVATE_SOURCE, sortSkills, type SortKey, type GroupSwitchState } from '../grouping.ts'
import type { BranchChoiceState, ConfirmDialogState, ConflictDialogState, MarketSyncDialogState } from './dialogs.tsx'

/** Catalog poll interval while the panel is mounted (the provider watcher feeds this). */
const POLL_MS = 5000
/** Relaxed poll for slower-changing data (stats, groups, sources, config). */
const SLOW_POLL_MS = 60_000

/** localStorage key of the last daily auto-check timestamp (survives sessions). */
const AUTO_CHECK_KEY = 'skill-hub.last-auto-check'
/** Daily auto-check interval: at most one network round per day. */
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60_000

/** Whether the daily auto-check should run now (first visit or ≥24h since the last). */
function shouldAutoCheck(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_CHECK_KEY)
    const last = raw === null ? NaN : Number(raw)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= AUTO_CHECK_INTERVAL_MS
  } catch {
    // 无 localStorage（隐私模式等）：每次打开都尝试，服务端 5 分钟节流兜底。
    return true
  }
}

/** Record that the daily auto-check ran. */
function markAutoChecked(): void {
  try {
    localStorage.setItem(AUTO_CHECK_KEY, String(Date.now()))
  } catch {
    // 无 localStorage：不记录，下次打开仍会尝试（服务端节流兜底）。
  }
}

/** One-shot self-update check state. */
type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; data: UpdateCheckResponse }
  | { status: 'error'; message: string }

/** Repo scanner/import state (drives the market source preview). */
type RepoDiscoverState =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'ready'; data: RepoDiscoverResponse }
  | { status: 'error'; message: string }

/** Market sources list state. */
type MarketState = { status: 'loading' | 'ready' | 'error'; repos: MarketSourceRecord[] }

/** One market source's update-check outcome. */
type MarketCheckResult = MarketCheckResponse['results'][number]

/** The hook's result: the panel's complete state + action surface. */
export type SkillHubState = ReturnType<typeof useSkillHub>

export function useSkillHub(api: SkillHubApi) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Green success banner (create finished); shown outside the closing form. */
  const [successBanner, setSuccessBanner] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [repoDiscoverState, setRepoDiscoverState] = useState<RepoDiscoverState>({ status: 'idle' })
  /** Market repo currently being scanned (null when idle); per-row busy state. */
  const [scanningRepo, setScanningRepo] = useState<string | null>(null)
  const [repoSelected, setRepoSelected] = useState<ReadonlySet<string>>(new Set())
  const [repoImporting, setRepoImporting] = useState(false)
  const [repoResult, setRepoResult] = useState<RepoImportResponse | null>(null)
  const [search, setSearch] = useState('')
  /** 工作区（项目）路径；空 = 只看用户级技能。 */
  const [workspace, setWorkspace] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formRoot, setFormRoot] = useState<WritableRoot>('user-dsh')
  const [formBusy, setFormBusy] = useState(false)
  const [formMessage, setFormMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [uses, setUses] = useState<ReadonlyMap<string, { count: number; lastUsed?: number }>>(new Map())
  const [hubConfig, setHubConfig] = useState<HubConfig | null>(null)
  const [tab, setTab] = useState<'sources' | 'scenes' | 'market'>('sources')
  const [skillView, setSkillView] = useState<'flat' | 'groups'>('groups')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [marketState, setMarketState] = useState<MarketState>({ status: 'loading', repos: [] })
  const [marketCheck, setMarketCheck] = useState<Readonly<Record<string, MarketCheckResult>>>({})
  const [branchChoice, setBranchChoice] = useState<BranchChoiceState | null>(null)
  const [branchBusy, setBranchBusy] = useState(false)
  const [marketSyncDialog, setMarketSyncDialog] = useState<MarketSyncDialogState | null>(null)
  const [syncingMarket, setSyncingMarket] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [newSourceName, setNewSourceName] = useState('')
  const [groupsState, setGroupsState] = useState<GroupsResponse | null>(null)
  const [sourcesState, setSourcesState] = useState<SourcesResponse | null>(null)
  const [sourceCheck, setSourceCheck] = useState<Readonly<Record<string, SourceCheckResult>>>({})
  const [checkingSource, setCheckingSource] = useState<string | null>(null)
  const [syncingSource, setSyncingSource] = useState<string | null>(null)
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [deleteSkillDialog, setDeleteSkillDialog] = useState<string | null>(null)
  const [confirmClearTrash, setConfirmClearTrash] = useState(false)
  /** 「全部更新」确认对话框（市场 tab）。 */
  const [updateAllDialog, setUpdateAllDialog] = useState(false)
  const [editingTag, setEditingTag] = useState<SkillTag | null>(null)
  const [editName, setEditName] = useState('')
  const [membersDraft, setMembersDraft] = useState<ReadonlySet<string>>(new Set())
  const [newTagName, setNewTagName] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [editSearch, setEditSearch] = useState('')
  /** 分组视图里收起的分组（key 为 tag:<id>、col:<name> 或 project 树键）。 */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())
  /** 项目级三级树里已细分（按 .dsh/.agents）的项目键。 */
  const [subdividedProjects, setSubdividedProjects] = useState<ReadonlySet<string>>(new Set())
  const [showLegend, setShowLegend] = useState(false)

  const toggleGroupCollapse = useCallback((key: string): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleSubdivide = useCallback((key: string): void => {
    setSubdividedProjects((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.catalog(workspace !== '' ? { cwd: workspace } : undefined)
      setCatalog(next)
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [api, workspace])

  const loadUses = useCallback(async (): Promise<void> => {
    try {
      const result = await api.stats()
      if (result.available) setUses(new Map(result.stats.map((stat) => [stat.name, { count: stat.count, ...(stat.lastUsed !== undefined ? { lastUsed: stat.lastUsed } : {}) }])))
    } catch {
      // Invocation counts are best-effort; a stats failure must not disturb the catalog.
    }
  }, [api])

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      setHubConfig((await api.config()).config)
    } catch {
      // Dot colors are cosmetic; a config failure falls back to the defaults.
    }
  }, [api])

  /** Check the hub's own GitHub release once, and again on demand. */
  const checkUpdate = useCallback(async (): Promise<void> => {
    setUpdateState({ status: 'checking' })
    try {
      setUpdateState({ status: 'ready', data: await api.updateCheck() })
    } catch (error) {
      setUpdateState({ status: 'error', message: errorMessage(error) })
    }
  }, [api])

  /** 加载用户 tag 分组 + 系统集合组 + origin 映射。 */
  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      setGroupsState(await api.groups())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 加载来源记录 + 回收站。 */
  const loadSources = useCallback(async (): Promise<void> => {
    try {
      setSourcesState(await api.sources())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 加载市场源列表。 */
  const loadMarket = useCallback(async (): Promise<void> => {
    try {
      const next = await api.market()
      setMarketState({ status: 'ready', repos: next.repos })
    } catch (error) {
      setMarketState({ status: 'error', repos: [] })
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 把最新的 tag 列表合并进 groups 状态（tags 以外的字段保持原样）。 */
  const applyTags = useCallback((tags: SkillTag[]): void => {
    setGroupsState((previous) => previous === null
      ? { ok: true, tags, collections: [], origins: {} }
      : { ...previous, tags })
  }, [])

  // 初始全量加载 + 双速轮询：目录是「活视图」（文件变化要 5 秒内可见），
  // 统计/分组/来源/配置变化慢，60 秒一次足够；写操作本身会触发即时刷新。
  // 更新检查、来源检查、市场检查全部改为手动按钮触发，打开面板不再自动
  // 打三路 GitHub 请求。
  useEffect(() => {
    void load()
    void loadUses()
    void loadGroups()
    void loadSources()
    void loadConfig()
    const fast = window.setInterval(() => { void load() }, POLL_MS)
    const slow = window.setInterval(() => { void loadUses(); void loadGroups(); void loadSources(); void loadConfig() }, SLOW_POLL_MS)
    return () => { window.clearInterval(fast); window.clearInterval(slow) }
  }, [load, loadUses, loadGroups, loadSources, loadConfig])

  const openDetail = useCallback(async (name: string): Promise<void> => {
    setDetailLoading(true)
    setLoadError(null)
    try {
      setDetail(await api.skill(name, workspace !== '' ? { cwd: workspace } : undefined))
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setDetailLoading(false)
    }
  }, [api, workspace])

  const toggle = useCallback(async (skill: CatalogSkill, enabled: boolean): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(skill.name))
    setLoadError(null)
    try {
      const next = await api.toggle(skill.name, enabled)
      setCatalog(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(skill.name)
        return next
      })
    }
  }, [api])

  const enableDisabled = useCallback(async (record: DisabledSkill): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(record.name))
    setLoadError(null)
    try {
      const next = await api.toggle(record.name, true)
      setCatalog(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(record.name)
        return next
      })
    }
  }, [api])

  /** Toggle an explicit name set in one write (enables disabled members too). */
  const batchToggleNames = useCallback(async (names: string[], enabled: boolean): Promise<void> => {
    if (names.length === 0) return
    setBatchBusy(true)
    setLoadError(null)
    try {
      const next = await api.toggleBatch(names, enabled)
      setCatalog(next.catalog)
      if (next.failures.length > 0) {
        setLoadError('toggle-batch: ' + next.failures.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBatchBusy(false)
    }
  }, [api])

  // -------------------------------------------------------- group switches

  /** 所有分组：key → 成员名（tag 与来源集合）。 */
  const groupMap = useCallback((): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    for (const tag of groupsState?.tags ?? []) map.set('tag:' + tag.id, tag.skillNames)
    for (const collection of groupsState?.collections ?? []) map.set('col:' + collection.name, collection.skillNames)
    return map
  }, [groupsState])

  /** 当前启用且可写的技能名（组开关只作用于它们）。 */
  const actionNames = useMemo(() => new Set((catalog?.skills ?? []).filter((skill) => skill.writable).map((skill) => skill.name)), [catalog])

  /** 当前启用的全部技能名（含只读，用于派生开关状态）。 */
  const viewNames = useMemo(() => new Set((catalog?.skills ?? []).map((skill) => skill.name)), [catalog])

  /**
   * Toggle a whole group via its tri-state switch. Closing with members that
   * are enabled in other groups opens the conflict dialog instead.
   */
  const toggleGroup = useCallback((key: string, name: string, view: GroupSwitchState): void => {
    const members = groupMap().get(key) ?? []
    if (members.length === 0) return
    if (view === 'off') {
      void batchToggleNames(members, true)
      return
    }
    const others = [...groupMap().entries()].filter(([otherKey]) => otherKey !== key).map(([, memberNames]) => ({ members: memberNames }))
    const conflicts = conflictsOnClose(members, actionNames, others)
    if (conflicts.length > 0) {
      setConflictDialog({ key, name, conflicts })
    } else {
      void batchToggleNames(members.filter((member) => actionNames.has(member)), false)
    }
  }, [groupMap, actionNames, batchToggleNames])

  /** Resolve the open conflict dialog. */
  const resolveConflict = useCallback(async (closeAll: boolean): Promise<void> => {
    const dialog = conflictDialog
    if (dialog === null) return
    setConflictDialog(null)
    const members = groupMap().get(dialog.key) ?? []
    if (closeAll) {
      await batchToggleNames(members.filter((member) => actionNames.has(member)), false)
    } else {
      await batchToggleNames(
        members.filter((member) => actionNames.has(member) && !dialog.conflicts.includes(member)),
        false,
      )
    }
  }, [conflictDialog, groupMap, actionNames, batchToggleNames])

  /** Dismiss a confirm dialog and run the pending source action. */
  const runConfirmed = useCallback(async (): Promise<void> => {
    const dialog = confirmDialog
    if (dialog === null) return
    setConfirmDialog(null)
    if (dialog.kind === 'sync') {
      setSyncingSource(dialog.repo)
      setLoadError(null)
      try {
        const result = await api.syncSource(dialog.repo, dialog.skills)
        await Promise.all([load(), loadGroups(), loadSources()])
        if (result.failed.length > 0) {
          setLoadError('sync: ' + result.failed.map((failure) => failure.name + ': ' + failure.error).join('; '))
        }
      } catch (error) {
        setLoadError(errorMessage(error))
      } finally {
        setSyncingSource(null)
      }
    } else {
      setLoadError(null)
      try {
        await api.confirmDeleteSource(dialog.repo, dialog.skills)
        await Promise.all([load(), loadGroups(), loadSources()])
      } catch (error) {
        setLoadError(errorMessage(error))
      }
    }
  }, [confirmDialog, api, load, loadGroups, loadSources])

  // ---------------------------------------------------------- source ops

  /** 检查全部来源的上游更新（服务端 5 分钟节流）。 */
  const checkSources = useCallback(async (repo?: string): Promise<void> => {
    setCheckingSource(repo ?? 'all')
    setLoadError(null)
    try {
      const result = await api.checkSources(repo)
      const next: Record<string, SourceCheckResult> = { ...sourceCheck }
      for (const item of result.results) next[item.repo] = item
      setSourceCheck(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setCheckingSource(null)
    }
  }, [api, sourceCheck])

  /** 请求同步某个来源的所选技能（弹确认，因为会覆盖本地修改）。 */
  const requestSync = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'sync', repo, skills })
  }, [])

  /** 请求跟进上游删除（弹确认，移入回收站）。 */
  const requestDelete = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'delete', repo, skills })
  }, [])

  /** 从回收站恢复一个技能。 */
  const restoreTrash = useCallback(async (name: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      await api.restoreSource(name)
      await Promise.all([load(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, load, loadGroups, loadSources])

  /** 确认后永久删除回收站里的全部技能。 */
  const clearTrash = useCallback(async (): Promise<void> => {
    setConfirmClearTrash(false)
    setTagBusy(true)
    setLoadError(null)
    try {
      const result = await api.clearTrash()
      if (result.failed.length > 0) {
        setLoadError('clear trash: ' + result.failed.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
      await Promise.all([load(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, load, loadSources])

  /** 打开单个技能的删除确认（移入回收站，可恢复）。 */
  const requestDeleteSkill = useCallback((name: string): void => {
    setDeleteSkillDialog(name)
  }, [])

  /** 执行删除确认后的回收站迁移。 */
  const runDeleteSkill = useCallback(async (): Promise<void> => {
    const name = deleteSkillDialog
    if (name === null) return
    setDeleteSkillDialog(null)
    setTagBusy(true)
    setLoadError(null)
    try {
      await api.deleteSkill(name)
      await Promise.all([load(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, deleteSkillDialog, load, loadGroups, loadSources])

  // ----------------------------------------------------------- tag editing

  /** 新建一个空 tag 分组。 */
  const createTag = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newTagName.trim()
    if (name === '') return
    setTagBusy(true)
    setLoadError(null)
    try {
      applyTags(await api.saveTag({ name }))
      setNewTagName('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags, newTagName])

  /** 删除一个 tag 分组（不影响技能文件）。 */
  const deleteTag = useCallback(async (id: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      applyTags(await api.deleteTag(id))
      setEditingTag(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags])

  /** 重命名 tag，或保存成员勾选后回到列表。 */
  const saveTag = useCallback(async (id: string, name: string, memberNames: string[] | null): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const safeName = name.trim()
      let tags: SkillTag[] | null = null
      if (safeName !== '') tags = await api.saveTag({ id, name: safeName })
      if (memberNames !== null) tags = await api.setTagMembers(id, memberNames)
      if (tags === null) return
      applyTags(tags)
      setEditingTag(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags])

  // -------------------------------------------------------------- market

  /** 添加一个市场源（内置市场目录与手动输入共用），并立即扫描它。 */
  const addSource = useCallback(async (input: string): Promise<void> => {
    const value = input.trim()
    if (value === '') return
    setLoadError(null)
    try {
      const result = await api.addMarketSource(value)
      setMarketState({ status: 'ready', repos: result.repos })
      setNewSourceName('')
      setRepoResult(null)
      setRepoSelected(new Set())
      // 用服务端归一化后的 slug 扫描（URL/owner@repo 输入都能对上记录）。
      const slug = result.repos[result.repos.length - 1].repo
      setScanningRepo(slug)
      setRepoDiscoverState({ status: 'scanning' })
      try {
        const data = await api.repoDiscover(slug)
        setRepoDiscoverState({ status: 'ready', data })
      } catch (error) {
        setRepoDiscoverState({ status: 'error', message: errorMessage(error) })
      } finally {
        setScanningRepo(null)
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 手动输入框的添加动作。 */
  const addMarketSource = useCallback(async (): Promise<void> => {
    await addSource(newSourceName)
  }, [addSource, newSourceName])

  /** 删除一个市场源（不影响已装技能）。 */
  const removeMarketSource = useCallback(async (repo: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const result = await api.removeMarketSource(repo)
      setMarketState({ status: 'ready', repos: result.repos })
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api])

  /** 扫描一个市场源（或手动输入）的仓库。 */
  const scanRepo = useCallback(async (input: string): Promise<void> => {
    const value = input.trim()
    if (value === '') return
    setRepoResult(null)
    setRepoSelected(new Set())
    setScanningRepo(value)
    setRepoDiscoverState({ status: 'scanning' })
    setLoadError(null)
    try {
      const data = await api.repoDiscover(value)
      if (data.ref === null) {
        // 无 release 且未定版：让用户选分支（默认第一项，通常是 main）。
        setBranchChoice({ repo: data.repo, branches: data.branches ?? [], selected: (data.branches ?? [])[0] ?? 'main' })
        setRepoDiscoverState({ status: 'idle' })
        return
      }
      setRepoDiscoverState({ status: 'ready', data })
    } catch (error) {
      setRepoDiscoverState({ status: 'error', message: errorMessage(error) })
    } finally {
      setScanningRepo(null)
    }
  }, [api])

  /** 确认分支选择：持久化 ref 后重新扫描。 */
  const confirmBranchChoice = useCallback(async (): Promise<void> => {
    if (branchChoice === null) return
    setBranchBusy(true)
    setLoadError(null)
    try {
      await api.setMarketSourceRef(branchChoice.repo, branchChoice.selected)
      setBranchChoice(null)
      await scanRepo(branchChoice.repo)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBranchBusy(false)
    }
  }, [api, branchChoice, scanRepo])

  /** Toggle one repo preview row. */
  const toggleRepoSelected = useCallback((path: string, checked: boolean): void => {
    setRepoSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  /** Import every checked, non-existing repo skill, then refresh the hub. */
  const importRepo = useCallback(async (): Promise<void> => {
    if (repoDiscoverState.status !== 'ready') return
    setRepoImporting(true)
    setRepoResult(null)
    setLoadError(null)
    try {
      const result = await api.repoImport(repoDiscoverState.data.repo, [...repoSelected], repoDiscoverState.data.ref ?? undefined)
      setRepoResult(result)
      await Promise.all([load(), loadMarket(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setRepoImporting(false)
    }
  }, [api, repoDiscoverState, repoSelected, load, loadMarket, loadGroups, loadSources])

  /** 检查所有市场源的上游更新（服务端节流）。 */
  const checkMarket = useCallback(async (): Promise<void> => {
    try {
      const result = await api.marketCheck()
      const next: Record<string, MarketCheckResult> = {}
      for (const item of result.results) next[item.repo] = item
      setMarketCheck(next)
    } catch {
      // 检查失败不打扰市场列表本身。
    }
  }, [api])

  /** 市场源同步：版本对齐后询问是否批量更新本地技能。 */
  const syncMarketSource = useCallback(async (repo: string): Promise<void> => {
    setSyncingMarket(repo)
    setLoadError(null)
    try {
      const result = await api.marketSync(repo)
      setMarketSyncDialog({ repo: result.repo, ref: result.ref, skills: result.skills, selected: new Set(result.skills) })
      await loadMarket()
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setSyncingMarket(null)
    }
  }, [api, loadMarket])

  /** 批量更新本地技能到市场源当前版本（复用来源同步路径）。 */
  const confirmMarketSync = useCallback(async (): Promise<void> => {
    if (marketSyncDialog === null) return
    const selected = [...marketSyncDialog.selected]
    setSyncBusy(true)
    setLoadError(null)
    try {
      if (selected.length > 0) {
        const result = await api.syncSource(marketSyncDialog.repo, selected)
        if (result.failed.length > 0) setLoadError(result.failed.map((item) => item.name + ': ' + item.error).join('\n'))
      }
      setMarketSyncDialog(null)
      await Promise.all([load(), loadGroups(), loadSources()])
      void checkMarket()
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setSyncBusy(false)
    }
  }, [api, marketSyncDialog, load, loadGroups, loadSources, checkMarket])

  /**
   * 一键全部更新：把每个「有可更新技能」的来源逐个同步到上游最新版本
   * （复用来源同步路径，覆盖本地修改），随后刷新并重新检查。
   */
  const updateAll = useCallback(async (): Promise<void> => {
    setUpdateAllDialog(false)
    setBatchBusy(true)
    setLoadError(null)
    const failures: string[] = []
    let done = 0
    try {
      for (const [repo, check] of Object.entries(sourceCheck)) {
        if (!check.changed || check.updated.length === 0) continue
        try {
          const result = await api.syncSource(repo, check.updated)
          done += 1
          if (result.failed.length > 0) {
            failures.push(tt('market.updateAllItem', { repo, count: result.failed.length }) + ': ' + result.failed.map((item) => item.name + ': ' + item.error).join('; '))
          }
        } catch (error) {
          failures.push(repo + ': ' + errorMessage(error))
        }
      }
      await Promise.all([load(), loadGroups(), loadSources()])
      await checkSources()
      void checkMarket()
      if (failures.length > 0) setLoadError(failures.join('\n'))
      else if (done > 0) setSuccessBanner(tt('market.updateAllDone', { count: done }))
    } finally {
      setBatchBusy(false)
    }
  }, [api, sourceCheck, checkSources, checkMarket, load, loadGroups, loadSources])

  // ------------------------------------------------- daily auto-check
  // 打开面板时每天最多自动检查一次（自身更新 + 全部来源 + 全部市场源），
  // 时间戳存 localStorage 跨会话生效；手动按钮随时可用，不受节流限制。
  useEffect(() => {
    if (!shouldAutoCheck()) return
    markAutoChecked()
    void checkUpdate()
    void checkSources()
    void checkMarket()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- create

  const create = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setFormBusy(true)
    setFormMessage(null)
    setSuccessBanner(null)
    try {
      const result = await api.create({ name: formName, description: formDesc, root: formRoot })
      // The form closes on success, so the confirmation lives in the green
      // banner outside it (a success message inside the closing form is
      // never visible).
      setSuccessBanner(tt('form.success') + result.path)
      setFormName('')
      setFormDesc('')
      setShowForm(false)
      await load()
    } catch (error) {
      setFormMessage({ kind: 'error', text: tt('form.error') + errorMessage(error) })
    } finally {
      setFormBusy(false)
    }
  }, [api, formName, formDesc, formRoot, load])

  // ------------------------------------------------------------- derived

  const normalized = search.trim().toLocaleLowerCase()
  /** skillName → origin repo（无来源记录的技能不在此映射中，筛选中视为 private）。 */
  const origins = groupsState?.origins ?? {}
  /** 来源筛选选项：来源记录中的仓库（排序）+ 末尾的「个人」；没有技能的仓库不列。 */
  const sourceOptions = useMemo(() => {
    const skills = catalog?.skills ?? []
    const repos = [...new Set(skills.map((skill) => origins[skill.name]).filter((repo): repo is string => repo !== undefined))].sort()
    // 项目级技能（有 workspace 归属）不算「个人」。
    const hasPrivate = skills.some((skill) => origins[skill.name] === undefined && !isProjectSource(skill.source))
    return [...repos, ...(hasPrivate ? [PRIVATE_SOURCE] : [])]
  }, [catalog, origins])
  const filtered = useMemo(() => (catalog?.skills ?? []).filter((skill) =>
    normalized.length === 0 || skill.name.toLocaleLowerCase().includes(normalized) || skill.description.toLocaleLowerCase().includes(normalized),
  ), [catalog, normalized])
  /** 排序后的技能列表（所有视图共用；调用次数未知按 0 处理）。 */
  const sorted = useMemo(() => sortSkills(filtered, sortKey, (name) => uses.get(name)?.count), [filtered, sortKey, uses])

  return {
    // state
    catalog, loading, loadError, successBanner, updateState, repoDiscoverState, scanningRepo, repoSelected, repoImporting, repoResult,
    search, workspace, detail, detailLoading, busyNames, batchBusy, showForm, formName, formDesc, formRoot, formBusy, formMessage,
    uses, hubConfig, tab, skillView, sourceFilter, sortKey, marketState, marketCheck, branchChoice, branchBusy,
    marketSyncDialog, syncingMarket, syncBusy, newSourceName, groupsState, sourcesState, sourceCheck, checkingSource, syncingSource,
    conflictDialog, confirmDialog, deleteSkillDialog, confirmClearTrash, updateAllDialog, editingTag, editName, membersDraft, newTagName, tagBusy,
    editSearch, collapsedGroups, subdividedProjects, showLegend,
    // derived
    actionNames, viewNames, normalized, origins, sourceOptions, filtered, sorted,
    // actions + setters
    setLoadError, setSuccessBanner, setSearch, setWorkspace, setDetail, setShowForm, setFormName, setFormDesc, setFormRoot, setFormMessage,
    setRepoSelected, setTab, setSkillView,
    setSourceFilter, setSortKey, setBranchChoice, setMarketSyncDialog, setNewSourceName, setConflictDialog, setConfirmDialog,
    setDeleteSkillDialog, setConfirmClearTrash, setUpdateAllDialog, setEditingTag, setEditName, setMembersDraft, setNewTagName, setEditSearch, setShowLegend,
    toggleGroupCollapse, toggleSubdivide, checkUpdate, loadMarket, openDetail, toggle, enableDisabled, batchToggleNames, toggleGroup, resolveConflict,
    runConfirmed, checkSources, requestSync, requestDelete, restoreTrash, clearTrash, requestDeleteSkill, runDeleteSkill, createTag,
    deleteTag, saveTag, addSource, addMarketSource, removeMarketSource, scanRepo, confirmBranchChoice, toggleRepoSelected, importRepo,
    checkMarket, syncMarketSource, confirmMarketSync, updateAll, create,
  }
}
