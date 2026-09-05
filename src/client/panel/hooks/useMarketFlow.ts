/**
 * useMarketFlow — 市场域：市场源增删、仓库扫描、分支/版本选择、导入任务
 * （轮询+取消）、更新检查、星标统计、版本同步、全部更新。目录/分组/来源
 * 的刷新与来源检查经聚合根传入，不直接碰其他域的 state。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MarketStatsResponse,
  RepoImportProgressResponse,
  SourceCheckResult,
} from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage, tt } from '../../helpers.ts'
import type { FlowNotices, MarketCheckResult, MarketState, RepoDiscoverState } from './shared.ts'
import type { BranchChoiceState, MarketSyncDialogState, VersionChoiceState } from '../dialogs.tsx'

export function useMarketFlow(
  api: SkillHubApi,
  shared: FlowNotices,
  /** 目录重载（导入/同步后刷新列表，目录域提供）。 */
  reloadCatalog: () => Promise<void>,
  /** 分组重载（导入后刷新，分组域提供）。 */
  reloadGroups: () => Promise<void>,
  /** 来源重载（导入/同步后刷新，来源域提供）。 */
  reloadSources: () => Promise<void>,
  /** 来源更新检查（全部更新后重查，来源域提供）。 */
  checkSources: (repo?: string) => Promise<void>,
  /** 各来源的上游检查结果（全部更新遍历它，来源域提供）。 */
  sourceCheck: Readonly<Record<string, SourceCheckResult>>,
) {
  const [marketState, setMarketState] = useState<MarketState>({ status: 'loading', repos: [] })
  const [marketCheck, setMarketCheck] = useState<Readonly<Record<string, MarketCheckResult>>>({})
  const [branchChoice, setBranchChoice] = useState<BranchChoiceState | null>(null)
  const [branchBusy, setBranchBusy] = useState(false)
  const [marketSyncDialog, setMarketSyncDialog] = useState<MarketSyncDialogState | null>(null)
  const [syncingMarket, setSyncingMarket] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [newSourceName, setNewSourceName] = useState('')
  const [repoDiscoverState, setRepoDiscoverState] = useState<RepoDiscoverState>({ status: 'idle' })
  /** Market repo currently being scanned (null when idle); per-row busy state. */
  const [scanningRepo, setScanningRepo] = useState<string | null>(null)
  const [repoSelected, setRepoSelected] = useState<ReadonlySet<string>>(new Set())
  const [repoImporting, setRepoImporting] = useState(false)
  const [repoResult, setRepoResult] = useState<RepoImportProgressResponse | null>(null)
  const [importJobId, setImportJobId] = useState<string | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  /** 市场源星星/下载数（SWR 缓存）。 */
  const [marketStats, setMarketStats] = useState<Readonly<Record<string, { stars: number; downloads: number }>>>({})
  /** 版本对话框：打开时拉 releases + branches，确认后定版并重扫。 */
  const [versionDialog, setVersionDialog] = useState<VersionChoiceState | null>(null)
  const [versionBusy, setVersionBusy] = useState(false)
  const [updateAllDialog, setUpdateAllDialog] = useState(false)

  /** 加载市场源列表。 */
  const loadMarket = useCallback(async (): Promise<void> => {
    try {
      const next = await api.market()
      setMarketState({ status: 'ready', repos: next.repos })
    } catch (error) {
      setMarketState({ status: 'error', repos: [] })
      shared.fail(errorMessage(error))
    }
  }, [api, shared])

  /** 添加一个市场源（内置市场目录与手动输入共用），并立即扫描它。 */
  const addSource = useCallback(async (input: string): Promise<void> => {
    const value = input.trim()
    if (value === '') return
    shared.clearFail()
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
      shared.fail(errorMessage(error))
    }
  }, [api, shared])

  /** 手动输入框的添加动作。 */
  const addMarketSource = useCallback(async (): Promise<void> => {
    await addSource(newSourceName)
  }, [addSource, newSourceName])

  /** 删除一个市场源（不影响已装技能）。 */
  const removeMarketSource = useCallback(async (repo: string): Promise<void> => {
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      const result = await api.removeMarketSource(repo)
      setMarketState({ status: 'ready', repos: result.repos })
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, shared])

  /** 扫描一个市场源（或手动输入）的仓库。 */
  const scanRepo = useCallback(async (input: string): Promise<void> => {
    const value = input.trim()
    if (value === '') return
    setRepoResult(null)
    setRepoSelected(new Set())
    setScanningRepo(value)
    setRepoDiscoverState({ status: 'scanning' })
    shared.clearFail()
    try {
      const data = await api.repoDiscover(value)
      if (data.ref === null) {
        // 无 release 且未定版：让用户选分支（默认第一项，通常是 main）。
        setBranchChoice({ repo: data.repo, branches: data.branches ?? [], selected: (data.branches ?? [])[0] ?? 'main' })
        setRepoDiscoverState({ status: 'idle' })
        return
      }
      setRepoDiscoverState({ status: 'ready', data })
      // The discover route may have auto-pinned the release; refresh the list so the ref badge shows.
      void loadMarket()
    } catch (error) {
      setRepoDiscoverState({ status: 'error', message: errorMessage(error) })
    } finally {
      setScanningRepo(null)
    }
  }, [api, loadMarket, shared])

  /** 确认分支选择：持久化 ref 后重新扫描。 */
  const confirmBranchChoice = useCallback(async (): Promise<void> => {
    if (branchChoice === null) return
    setBranchBusy(true)
    shared.clearFail()
    try {
      await api.setMarketSourceRef(branchChoice.repo, branchChoice.selected)
      setBranchChoice(null)
      await scanRepo(branchChoice.repo)
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setBranchBusy(false)
    }
  }, [api, branchChoice, scanRepo, shared])

  const openVersionDialog = useCallback(async (repo: string): Promise<void> => {
    const current = marketState.repos.find((item) => item.repo === repo)?.ref
    setVersionDialog({ repo, ...(current !== undefined ? { current } : {}), releases: [], branches: [], selected: current ?? '', custom: '', loading: true })
    shared.clearFail()
    try {
      const data = await api.marketSourceVersions(repo)
      setVersionDialog({
        repo,
        ...(data.current !== undefined ? { current: data.current } : {}),
        releases: data.releases,
        branches: data.branches,
        selected: data.current ?? data.releases[0] ?? data.branches[0] ?? '',
        custom: '',
        loading: false,
      })
    } catch (error) {
      shared.fail(errorMessage(error))
      setVersionDialog(null)
    }
  }, [api, marketState, shared])

  const confirmVersionDialog = useCallback(async (): Promise<void> => {
    if (versionDialog === null) return
    const ref = versionDialog.custom.trim() !== '' ? versionDialog.custom.trim() : versionDialog.selected
    if (ref === '') return
    setVersionBusy(true)
    shared.clearFail()
    try {
      await api.setMarketSourceRef(versionDialog.repo, ref)
      setVersionDialog(null)
      await loadMarket()
      await scanRepo(versionDialog.repo)
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setVersionBusy(false)
    }
  }, [api, versionDialog, loadMarket, scanRepo, shared])

  /** Toggle one repo preview row. */
  const toggleRepoSelected = useCallback((path: string, checked: boolean): void => {
    setRepoSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  /** Import every checked, non-existing repo skill (B方案：job+轮询+进度). */
  const importRepo = useCallback(async (): Promise<void> => {
    if (repoDiscoverState.status !== 'ready') return
    setRepoImporting(true)
    setRepoResult(null)
    setImportJobId(null)
    shared.clearFail()
    let finalProgress: RepoImportProgressResponse | null = null
    try {
      const created = await api.repoImport(repoDiscoverState.data.repo, [...repoSelected], repoDiscoverState.data.ref ?? undefined)
      setImportJobId(created.jobId)
      // 初始占位，让进度卡片立刻出现（带真实 totalBytes）
      setRepoResult({ ok: true, jobId: created.jobId, status: 'running', total: created.total, done: 0, totalBytes: created.totalBytes, downloadedBytes: 0, imported: [], skipped: [], failed: [] })
      // 轮询直到 done/cancelled/error（800ms 起步 + 退避，避免 276 技能 900 次请求）
      pollAbortRef.current?.abort()
      pollAbortRef.current = new AbortController()
      const signal = pollAbortRef.current.signal
      let attempt = 0
      for (;;) {
        if (signal.aborted) break
        const delay = Math.min(2000, 800 + attempt * 200)
        await new Promise((r) => setTimeout(r, delay))
        if (signal.aborted) break
        try {
          const progress = await api.repoImportProgress(created.jobId)
          setRepoResult(progress)
          finalProgress = progress
          if (progress.status !== 'running') {
            break
          }
          attempt = 0
        } catch (pollError) {
          // 轮询失败退避重试
          const msg = errorMessage(pollError)
          if (msg.includes('not found')) break
          attempt += 1
          if (attempt > 8) break
        }
      }
      await Promise.all([reloadCatalog(), loadMarket(), reloadGroups(), reloadSources()])
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      // 导入完成后把已导入/已跳过的项从勾选中移除，并把扫描快照里的 existing 置为 true，避免“仍可勾选已导入”的错觉
      if (finalProgress !== null && (finalProgress.imported.length > 0 || finalProgress.skipped.length > 0)) {
        const doneNames = new Set([...finalProgress.imported.map((r) => r.name), ...finalProgress.skipped.map((r) => r.name)])
        const donePaths = new Set(
          repoDiscoverState.data.entries.filter((e) => doneNames.has(e.name)).map((e) => e.path),
        )
        setRepoSelected((prev) => {
          const next = new Set(prev)
          for (const p of donePaths) next.delete(p)
          return next
        })
        setRepoDiscoverState((prev) => {
          if (prev.status !== 'ready') return prev
          return {
            ...prev,
            data: {
              ...prev.data,
              entries: prev.data.entries.map((e) => doneNames.has(e.name) ? { ...e, existing: true } : e),
            },
          }
        })
      }
      setRepoImporting(false)
    }
  }, [api, repoDiscoverState, repoSelected, reloadCatalog, loadMarket, reloadGroups, reloadSources, shared])

  // 卸载时中断轮询，避免泄露
  useEffect(() => {
    return () => { pollAbortRef.current?.abort() }
  }, [])

  /** 取消正在进行的导入（选项2：唯有取消才停） */
  const cancelImport = useCallback(async (): Promise<void> => {
    if (importJobId === null) return
    pollAbortRef.current?.abort()
    try {
      const res = await api.repoImportCancel(importJobId)
      // 立刻刷新一次进度
      try {
        const progress = await api.repoImportProgress(importJobId)
        setRepoResult(progress)
      } catch {
        setRepoResult((prev) => prev !== null ? { ...prev, status: res.status as 'cancelled' } : prev)
      }
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setRepoImporting(false)
    }
  }, [api, importJobId, shared])

  /** 清空扫描结果（关闭归属卡片） */
  const clearScan = useCallback((): void => {
    setRepoDiscoverState({ status: 'idle' })
    setScanningRepo(null)
    setRepoResult(null)
    setRepoSelected(new Set())
    setImportJobId(null)
    pollAbortRef.current?.abort()
  }, [])

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

  /** 市场源星星/下载数（SWR：先即时缓存渲染，后台刷新后合并，失败静默）。 */
  const loadMarketStats = useCallback(async (): Promise<void> => {
    const merge = (results: MarketStatsResponse['results']): void => {
      const partial: Record<string, { stars: number; downloads: number }> = {}
      for (const item of results) {
        if (item.error === undefined) partial[item.repo] = { stars: item.stars, downloads: item.downloads }
      }
      if (Object.keys(partial).length > 0) setMarketStats((previous) => ({ ...previous, ...partial }))
    }
    try {
      merge((await api.marketStats()).results)
    } catch {
      // 统计失败不打扰市场列表本身。
    }
    try {
      merge((await api.marketStats(true)).results)
    } catch {
      // 后台刷新失败时保留缓存值。
    }
  }, [api])

  /** 市场源同步：版本对齐后询问是否批量更新本地技能。 */
  const syncMarketSource = useCallback(async (repo: string): Promise<void> => {
    setSyncingMarket(repo)
    shared.clearFail()
    try {
      const result = await api.marketSync(repo)
      setMarketSyncDialog({ repo: result.repo, ref: result.ref, skills: result.skills, selected: new Set(result.skills) })
      await loadMarket()
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setSyncingMarket(null)
    }
  }, [api, loadMarket, shared])

  /** 批量更新本地技能到市场源当前版本（复用来源同步路径）。 */
  const confirmMarketSync = useCallback(async (): Promise<void> => {
    if (marketSyncDialog === null) return
    const selected = [...marketSyncDialog.selected]
    setSyncBusy(true)
    shared.clearFail()
    try {
      if (selected.length > 0) {
        const result = await api.syncSource(marketSyncDialog.repo, selected)
        if (result.failed.length > 0) shared.fail(result.failed.map((item) => item.name + ': ' + item.error).join('\n'))
      }
      setMarketSyncDialog(null)
      await Promise.all([reloadCatalog(), reloadGroups(), reloadSources()])
      void checkMarket()
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setSyncBusy(false)
    }
  }, [api, marketSyncDialog, reloadCatalog, reloadGroups, reloadSources, checkMarket, shared])

  /**
   * 一键全部更新：把每个「有可更新技能」的来源逐个同步到上游最新版本
   * （复用来源同步路径，覆盖本地修改），随后刷新并重新检查。
   */
  const updateAll = useCallback(async (): Promise<void> => {
    setUpdateAllDialog(false)
    shared.setBatchBusy(true)
    shared.clearFail()
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
      await Promise.all([reloadCatalog(), reloadGroups(), reloadSources()])
      await checkSources()
      void checkMarket()
      if (failures.length > 0) shared.fail(failures.join('\n'))
      else if (done > 0) shared.succeed(tt('market.updateAllDone', { count: done }))
    } finally {
      shared.setBatchBusy(false)
    }
  }, [api, sourceCheck, checkSources, checkMarket, reloadCatalog, reloadGroups, reloadSources, shared])

  return {
    marketState, marketCheck, branchChoice, branchBusy, marketSyncDialog, syncingMarket,
    syncBusy, newSourceName, repoDiscoverState, scanningRepo, repoSelected, repoImporting,
    repoResult, importJobId, marketStats, versionDialog, versionBusy, updateAllDialog,
    setBranchChoice, setMarketSyncDialog, setNewSourceName, setRepoSelected,
    setUpdateAllDialog, setVersionDialog,
    loadMarket, addSource, addMarketSource, removeMarketSource, scanRepo, confirmBranchChoice,
    openVersionDialog, confirmVersionDialog, toggleRepoSelected, importRepo, cancelImport,
    clearScan, checkMarket, loadMarketStats, syncMarketSource, confirmMarketSync, updateAll,
  }
}
