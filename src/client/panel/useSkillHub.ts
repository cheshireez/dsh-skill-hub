/**
 * useSkillHub — 面板的状态聚合根：只持有跨域共享的通知状态与纯视图状态，
 * 各域状态与动作分散在 ./hooks/*，这里按依赖顺序组装（meta → 目录 →
 * 分组 → 来源 → 市场），轮询与派生组装在此。返回形状与拆分前完全一致，
 * 所有视图无需改动。All hooks run unconditionally at the top, so the panel
 * may early-return for the detail and tag-editor views without violating
 * the rules of hooks.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillHubApi } from '../api.ts'
import { isProjectSource, PRIVATE_SOURCE } from '../grouping.ts'
import { useMetaFlow } from './hooks/useMetaFlow.ts'
import { useCatalogFlow } from './hooks/useCatalogFlow.ts'
import { useGroupFlow } from './hooks/useGroupFlow.ts'
import { useSourceFlow } from './hooks/useSourceFlow.ts'
import { useMarketFlow } from './hooks/useMarketFlow.ts'
import { markAutoChecked, shouldAutoCheck, type FlowNotices } from './hooks/shared.ts'

/** The hook's result: the panel's complete state + action surface. */
export type SkillHubState = ReturnType<typeof useSkillHub>

export function useSkillHub(api: SkillHubApi) {
  // ------------------------------------------------------- shared notices
  // 多域共用的报错/成功条幅与忙碌开关：setter 本身引用稳定，memo 常驻后
  // 各域回调依赖它不会失稳。
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Green success banner (create finished); shown outside the closing form. */
  const [successBanner, setSuccessBanner] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  const shared = useMemo<FlowNotices>(() => ({
    fail: (message: string) => setLoadError(message),
    clearFail: () => setLoadError(null),
    succeed: (message: string | null) => setSuccessBanner(message),
    setTagBusy,
    setBatchBusy,
  }), [])

  // ------------------------------------------------------------ view state
  // 纯视图状态：不触发数据加载，只影响渲染。
  const [tab, setTab] = useState<'sources' | 'scenes' | 'market'>('sources')
  const [skillView, setSkillView] = useState<'flat' | 'groups'>('groups')
  const [sourceFilter, setSourceFilter] = useState('all')
  /** 分组视图里收起的分组（key 为 tag:<id>、col:<name> 或 project 树键）。技能总数 >80 时首次加载自动折叠 personal。 */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())
  /** 项目级三级树里已细分（按 .dsh/.agents）的项目键。 */
  const [subdividedProjects, setSubdividedProjects] = useState<ReadonlySet<string>>(new Set())
  const [showLegend, setShowLegend] = useState(false)
  const [editMode, setEditMode] = useState(false)

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

  const collapsePersonal = useCallback((): void => {
    setCollapsedGroups((previous) => new Set(previous).add('uncategorized-source'))
  }, [])

  const clearSourceFilter = useCallback((): void => {
    setSourceFilter('all')
  }, [])

  // ------------------------------------------------------------ meta first
  // 更新检查/统计/配置只依赖 api，最先组装。
  const meta = useMetaFlow(api)

  // ---------------------------------------------------------------- catalog
  const catalogFlow = useCatalogFlow(api, meta.uses, shared, collapsePersonal, clearSourceFilter)

  // ----------------------------------------------------------------- groups
  const groupFlow = useGroupFlow(api, shared, catalogFlow.batchToggleNames, catalogFlow.actionNames)

  // ----------------------------------------------------------------- sources
  const sourceFlow = useSourceFlow(api, shared, catalogFlow.load, groupFlow.loadGroups)

  // ------------------------------------------------------------------ market
  const marketFlow = useMarketFlow(
    api,
    shared,
    catalogFlow.load,
    groupFlow.loadGroups,
    sourceFlow.loadSources,
    sourceFlow.checkSources,
    sourceFlow.sourceCheck,
  )

  // ------------------------------------------------------------- derived
  /** skillName → origin repo（无来源记录的技能不在此映射中，筛选中视为 private）。 */
  const origins = groupFlow.groupsState?.origins ?? {}
  /** 来源筛选选项：来源记录中的仓库（排序）+ 末尾的「个人」；没有技能的仓库不列。 */
  const sourceOptions = useMemo(() => {
    const skills = catalogFlow.catalog?.skills ?? []
    const repos = [...new Set(skills.map((skill) => origins[skill.name]).filter((repo): repo is string => repo !== undefined))].sort()
    // 项目级技能（有 workspace 归属）不算「个人」。
    const hasPrivate = skills.some((skill) => origins[skill.name] === undefined && !isProjectSource(skill.source))
    return [...repos, ...(hasPrivate ? [PRIVATE_SOURCE] : [])]
  }, [catalogFlow.catalog, origins])

  // 初始全量加载 + 双速轮询：目录是「活视图」（文件变化要 5 秒内可见），
  // 统计/分组/来源/配置变化慢，60 秒一次足够；写操作本身会触发即时刷新。
  // 更新检查、来源检查、市场检查全部改为手动按钮触发，打开面板不再自动
  // 打三路 GitHub 请求。
  useEffect(() => {
    void catalogFlow.load()
    void meta.loadUses()
    void groupFlow.loadGroups()
    void sourceFlow.loadSources()
    void meta.loadConfig()
    const fast = window.setInterval(() => { void catalogFlow.load() }, 5000)
    const slow = window.setInterval(() => { void meta.loadUses(); void groupFlow.loadGroups(); void sourceFlow.loadSources(); void meta.loadConfig() }, 60_000)
    return () => { window.clearInterval(fast); window.clearInterval(slow) }
  }, [catalogFlow.load, meta.loadUses, groupFlow.loadGroups, sourceFlow.loadSources, meta.loadConfig])

  // ------------------------------------------------- daily auto-check
  // 打开面板时每天最多自动检查一次（自身更新 + 全部来源 + 全部市场源），
  // 时间戳存 localStorage 跨会话生效；手动按钮随时可用，不受节流限制。
  useEffect(() => {
    if (!shouldAutoCheck()) return
    markAutoChecked()
    void meta.checkUpdate()
    void sourceFlow.checkSources()
    void marketFlow.checkMarket()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    // state
    catalog: catalogFlow.catalog, loading: catalogFlow.loading, loadError, successBanner,
    updateState: meta.updateState,
    repoDiscoverState: marketFlow.repoDiscoverState, scanningRepo: marketFlow.scanningRepo,
    repoSelected: marketFlow.repoSelected, repoImporting: marketFlow.repoImporting,
    repoResult: marketFlow.repoResult, importJobId: marketFlow.importJobId,
    search: catalogFlow.search, workspace: catalogFlow.workspace,
    detail: catalogFlow.detail, detailLoading: catalogFlow.detailLoading,
    busyNames: catalogFlow.busyNames, batchBusy,
    showForm: catalogFlow.showForm, formName: catalogFlow.formName, formDesc: catalogFlow.formDesc,
    formRoot: catalogFlow.formRoot, formBusy: catalogFlow.formBusy, formMessage: catalogFlow.formMessage,
    uses: meta.uses, hubConfig: meta.hubConfig, tab, skillView, sourceFilter,
    invocationFilter: catalogFlow.invocationFilter, sortKey: catalogFlow.sortKey,
    marketState: marketFlow.marketState, marketCheck: marketFlow.marketCheck,
    marketStats: marketFlow.marketStats, branchChoice: marketFlow.branchChoice, branchBusy: marketFlow.branchBusy,
    marketSyncDialog: marketFlow.marketSyncDialog, syncingMarket: marketFlow.syncingMarket,
    syncBusy: marketFlow.syncBusy, newSourceName: marketFlow.newSourceName,
    groupsState: groupFlow.groupsState, sourcesState: sourceFlow.sourcesState,
    sourceCheck: sourceFlow.sourceCheck, checkingSource: sourceFlow.checkingSource,
    syncingSource: sourceFlow.syncingSource,
    conflictDialog: groupFlow.conflictDialog, confirmDialog: sourceFlow.confirmDialog,
    deleteSkillDialog: sourceFlow.deleteSkillDialog, deleteGroupDialog: sourceFlow.deleteGroupDialog,
    confirmClearTrash: sourceFlow.confirmClearTrash, updateAllDialog: marketFlow.updateAllDialog,
    editingTag: groupFlow.editingTag, editName: groupFlow.editName, membersDraft: groupFlow.membersDraft,
    newTagName: groupFlow.newTagName, tagBusy,
    editSearch: groupFlow.editSearch, collapsedGroups, subdividedProjects, showLegend, editMode,
    versionDialog: marketFlow.versionDialog, versionBusy: marketFlow.versionBusy,
    // derived
    actionNames: catalogFlow.actionNames, viewNames: catalogFlow.viewNames,
    normalized: catalogFlow.normalized, origins, sourceOptions,
    filtered: catalogFlow.filtered, sorted: catalogFlow.sorted, shortenedCount: catalogFlow.shortenedCount,
    // actions + setters
    setLoadError, setSuccessBanner, setSearch: catalogFlow.setSearch, setWorkspace: catalogFlow.setWorkspace,
    setDetail: catalogFlow.setDetail, setShowForm: catalogFlow.setShowForm, setFormName: catalogFlow.setFormName,
    setFormDesc: catalogFlow.setFormDesc, setFormRoot: catalogFlow.setFormRoot,
    setFormMessage: catalogFlow.setFormMessage,
    setRepoSelected: marketFlow.setRepoSelected, setTab, setSkillView,
    setSourceFilter, setInvocationFilter: catalogFlow.setInvocationFilter, setSortKey: catalogFlow.setSortKey,
    setBranchChoice: marketFlow.setBranchChoice, setMarketSyncDialog: marketFlow.setMarketSyncDialog,
    setNewSourceName: marketFlow.setNewSourceName, setConflictDialog: groupFlow.setConflictDialog,
    setConfirmDialog: sourceFlow.setConfirmDialog,
    setDeleteSkillDialog: sourceFlow.setDeleteSkillDialog, setDeleteGroupDialog: sourceFlow.setDeleteGroupDialog,
    setConfirmClearTrash: sourceFlow.setConfirmClearTrash, setUpdateAllDialog: marketFlow.setUpdateAllDialog,
    setEditingTag: groupFlow.setEditingTag, setEditName: groupFlow.setEditName,
    setMembersDraft: groupFlow.setMembersDraft, setNewTagName: groupFlow.setNewTagName,
    setEditSearch: groupFlow.setEditSearch, setShowLegend, setEditMode,
    setVersionDialog: marketFlow.setVersionDialog,
    toggleGroupCollapse, toggleSubdivide, checkUpdate: meta.checkUpdate, loadMarket: marketFlow.loadMarket,
    openDetail: catalogFlow.openDetail, toggle: catalogFlow.toggle, enableDisabled: catalogFlow.enableDisabled,
    batchToggleNames: catalogFlow.batchToggleNames, toggleGroup: groupFlow.toggleGroup,
    resolveConflict: groupFlow.resolveConflict,
    runConfirmed: sourceFlow.runConfirmed, checkSources: sourceFlow.checkSources,
    requestSync: sourceFlow.requestSync, requestDelete: sourceFlow.requestDelete,
    restoreTrash: sourceFlow.restoreTrash, clearTrash: sourceFlow.clearTrash,
    fixingPaths: catalogFlow.fixingPaths, fixDiagnostic: catalogFlow.fixDiagnostic,
    clearListFilters: catalogFlow.clearListFilters, openVersionDialog: marketFlow.openVersionDialog,
    confirmVersionDialog: marketFlow.confirmVersionDialog, requestDeleteSkill: sourceFlow.requestDeleteSkill,
    runDeleteSkill: sourceFlow.runDeleteSkill, requestDeleteGroup: sourceFlow.requestDeleteGroup,
    runDeleteGroup: sourceFlow.runDeleteGroup, createTag: groupFlow.createTag,
    deleteTag: groupFlow.deleteTag, saveTag: groupFlow.saveTag, reorderTags: groupFlow.reorderTags,
    reorderCollections: groupFlow.reorderCollections, reorderSourceGroups: groupFlow.reorderSourceGroups,
    addSource: marketFlow.addSource, addMarketSource: marketFlow.addMarketSource,
    removeMarketSource: marketFlow.removeMarketSource, scanRepo: marketFlow.scanRepo,
    confirmBranchChoice: marketFlow.confirmBranchChoice, toggleRepoSelected: marketFlow.toggleRepoSelected,
    importRepo: marketFlow.importRepo, cancelImport: marketFlow.cancelImport,
    clearScan: marketFlow.clearScan,
    checkMarket: marketFlow.checkMarket, loadMarketStats: marketFlow.loadMarketStats,
    syncMarketSource: marketFlow.syncMarketSource, confirmMarketSync: marketFlow.confirmMarketSync,
    updateAll: marketFlow.updateAll, create: catalogFlow.create,
  }
}
