/**
 * useMarketFlow — 市场域：市场源增删、更新检查、星标统计、版本同步、全部
 * 更新；仓库扫描/分支选择/导入任务在 useRepoImportFlow（这里组装它并透传
 * 同样的返回字段）。目录/分组/来源的刷新与来源检查经聚合根传入，不直接
 * 碰其他域的 state。
 */

import { useCallback, useState } from 'react'
import type {
  MarketStatsResponse,
  SourceCheckResult,
} from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage, tt } from '../../helpers.ts'
import { runFlow, type FlowNotices, type MarketCheckResult, type MarketState } from './shared.ts'
import { useRepoImportFlow } from './useRepoImportFlow.ts'
import type { MarketSyncDialogState, VersionChoiceState } from '../dialogs.tsx'

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
  const [marketSyncDialog, setMarketSyncDialog] = useState<MarketSyncDialogState | null>(null)
  const [syncingMarket, setSyncingMarket] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [newSourceName, setNewSourceName] = useState('')
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

  // 仓库扫描/分支选择/导入任务子域：scanRepo 定版后刷新市场列表，导入完成
  // 后刷新目录/分组/来源，故把 loadMarket 与三个重载一起注入。
  const repoImport = useRepoImportFlow(api, shared, loadMarket, reloadCatalog, reloadGroups, reloadSources)
  const {
    repoDiscoverState, scanningRepo, repoSelected, repoImporting, repoResult, importJobId,
    branchChoice, branchBusy, setBranchChoice, setRepoSelected,
    setRepoDiscoverState, setScanningRepo, setRepoResult,
    scanRepo, confirmBranchChoice, toggleRepoSelected, importRepo, cancelImport, clearScan,
  } = repoImport

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
    await runFlow(shared, async () => {
      const result = await api.removeMarketSource(repo)
      setMarketState({ status: 'ready', repos: result.repos })
    }, () => shared.setTagBusy(false))
  }, [api, shared])

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
    await runFlow(shared, async () => {
      await api.setMarketSourceRef(versionDialog.repo, ref)
      setVersionDialog(null)
      await loadMarket()
      await scanRepo(versionDialog.repo)
    }, () => setVersionBusy(false))
  }, [api, versionDialog, loadMarket, scanRepo, shared])

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
    await runFlow(shared, async () => {
      const result = await api.marketSync(repo)
      setMarketSyncDialog({ repo: result.repo, ref: result.ref, skills: result.skills, selected: new Set(result.skills) })
      await loadMarket()
    }, () => setSyncingMarket(null))
  }, [api, loadMarket, shared])

  /** 批量更新本地技能到市场源当前版本（复用来源同步路径）。 */
  const confirmMarketSync = useCallback(async (): Promise<void> => {
    if (marketSyncDialog === null) return
    const selected = [...marketSyncDialog.selected]
    setSyncBusy(true)
    await runFlow(shared, async () => {
      if (selected.length > 0) {
        const result = await api.syncSource(marketSyncDialog.repo, selected)
        if (result.failed.length > 0) shared.fail(result.failed.map((item) => item.name + ': ' + item.error).join('\n'))
      }
      setMarketSyncDialog(null)
      await Promise.all([reloadCatalog(), reloadGroups(), reloadSources()])
      void checkMarket()
    }, () => setSyncBusy(false))
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
