/**
 * useMarketFlow — 市场域：市场源增删、更新检查、星标统计、版本同步、全部
 * 更新；仓库扫描/分支选择/导入任务在 useRepoImportFlow（这里组装它并透传
 * 同样的返回字段）。目录/分组/来源的刷新与来源检查经聚合根传入，不直接
 * 碰其他域的 state。
 */

import { useCallback, useRef, useState } from 'react'
import type {
  MarketSkillsShEntry,
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
  /** 移除市场源的确认框（破坏性操作，和删除技能一样先确认）。 */
  const [removeMarketDialog, setRemoveMarketDialog] = useState<string | null>(null)
  /** 批量更新防重入：按钮被连点或两个窗口同时触发时只跑一轮。 */
  const updatingAllRef = useRef(false)

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
      // 用服务端回传的归一化 slug 扫描（URL/owner@repo 输入都能对上记录）。
      // 不能猜 `repos` 的位置：重复添加一个已存在的源只改它的 ref、不重排，
      // 取末位会扫到另一个源。
      const slug = result.repo
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
      // Drop stale per-repo check/stats so「全部更新」never targets a source
      // that was just removed (the server would answer 404 forever).
      setMarketCheck((previous) => {
        if (previous[repo] === undefined) return previous
        const next = { ...previous }
        delete next[repo]
        return next
      })
      setMarketStats((previous) => {
        if (previous[repo] === undefined) return previous
        const next = { ...previous }
        delete next[repo]
        return next
      })
    }, () => shared.setTagBusy(false))
  }, [api, shared])

  const requestRemoveMarketSource = useCallback((repo: string): void => { setRemoveMarketDialog(repo) }, [])
  const cancelRemoveMarketSource = useCallback((): void => { setRemoveMarketDialog(null) }, [])
  const confirmRemoveMarketSource = useCallback(async (): Promise<void> => {
    const repo = removeMarketDialog
    if (repo === null) return
    setRemoveMarketDialog(null)
    await removeMarketSource(repo)
  }, [removeMarketDialog, removeMarketSource])

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
      const repo = versionDialog.repo
      await api.setMarketSourceRef(repo, ref)
      // 旧 ref 的 release 检查结果不能再挂在行上，否则「全部更新」可能按
      // 旧目标把用户刚切换的版本又钉回去。
      setMarketCheck((previous) => {
        if (previous[repo] === undefined) return previous
        const next = { ...previous }
        delete next[repo]
        return next
      })
      setVersionDialog(null)
      await loadMarket()
      await scanRepo(repo)
    }, () => setVersionBusy(false))
  }, [api, versionDialog, loadMarket, scanRepo, shared])

  /** 检查所有市场源的上游更新（服务端节流）。节流结果保留旧的检查结果，
   * 避免「刚刚检查过」把上一次发现的更新覆盖成「已是最新」。 */
  const checkMarket = useCallback(async (): Promise<void> => {
    try {
      const result = await api.marketCheck()
      setMarketCheck((previous) => {
        const next: Record<string, MarketCheckResult> = { ...previous }
        for (const item of result.results) {
          // 节流表示这次没访问网络，旧结果才是已知的最新事实。
          if (item.throttled === true && previous[item.repo] !== undefined) continue
          next[item.repo] = item
        }
        return next
      })
    } catch (error) {
      shared.fail(errorMessage(error))
    }
  }, [api, shared])

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

  /** 市场源同步：版本对齐后询问是否批量更新本地技能。`ref` = 检查到的
   * 新版本标签，先钉住再同步，否则被钉住的旧 ref 会让「更新」原地打转。 */
  const syncMarketSource = useCallback(async (repo: string, ref?: string): Promise<void> => {
    setSyncingMarket(repo)
    await runFlow(shared, async () => {
      const result = await api.marketSync(repo, ref)
      const localModified = sourceCheck[repo]?.localModified ?? []
      // 服务端会带上「这次版本变化涉及的技能」；旧服务端没有该字段时退回全选。
      const updated = result.updated
      const selected = updated !== undefined
        ? new Set(result.skills.filter((name) => updated.includes(name)))
        : new Set(result.skills)
      setMarketSyncDialog({ repo: result.repo, ref: result.ref, skills: result.skills, selected, localModified })
      // 市场源已切到新 ref，旧的 release 检查结果立刻失效（尤其是用户点
      // 「跳过」时，不能留下「新版本」或误显示「已是最新」）。
      setMarketCheck((previous) => {
        if (previous[result.repo] === undefined) return previous
        const next = { ...previous }
        delete next[result.repo]
        return next
      })
      // 重新核对来源侧（服务端在成功同步后会清掉检查节流）；没有 tracked
      // source 的纯市场源不能调 checkSources，否则会得到 404 红条。
      if (result.skills.length > 0) void checkSources(result.repo)
      await loadMarket()
    }, () => setSyncingMarket(null))
  }, [api, checkSources, loadMarket, shared, sourceCheck])

  /** 批量更新本地技能到市场源当前版本（复用来源同步路径）。 */
  const confirmMarketSync = useCallback(async (): Promise<void> => {
    if (marketSyncDialog === null) return
    const repo = marketSyncDialog.repo
    const selected = [...marketSyncDialog.selected]
    setSyncBusy(true)
    await runFlow(shared, async () => {
      const issues: string[] = []
      if (selected.length > 0) {
        const result = await api.syncSource(repo, selected)
        if (result.failed.length > 0) issues.push(result.failed.map((item) => item.name + ': ' + item.error).join('\n'))
        if (result.overwritten !== undefined && result.overwritten.length > 0) {
          issues.push(tt('market.syncOverwritten', { names: result.overwritten.join(', ') }))
        }
      }
      setMarketSyncDialog(null)
      // 本地技能已与市场源对齐；旧的 release 检查结果立刻失效。
      setMarketCheck((previous) => {
        if (previous[repo] === undefined) return previous
        const next = { ...previous }
        delete next[repo]
        return next
      })
      await Promise.all([reloadCatalog(), reloadGroups(), reloadSources()])
      // checkSources 内部会 clearFail，提示必须放在它之后再发，避免被清掉。
      await checkSources(repo)
      void checkMarket()
      if (issues.length > 0) shared.fail(issues.join('\n'))
    }, () => setSyncBusy(false))
  }, [api, marketSyncDialog, reloadCatalog, reloadGroups, reloadSources, checkSources, checkMarket, shared])

  /**
   * 一键全部更新：市场 release 更新先重钉并同步，再处理来源侧技能更新
   * （复用来源同步路径，覆盖本地修改），随后刷新并重新检查。
   */
  const updateAll = useCallback(async (): Promise<void> => {
    if (updatingAllRef.current) { setUpdateAllDialog(false); return }
    updatingAllRef.current = true
    setUpdateAllDialog(false)
    shared.setBatchBusy(true)
    shared.clearFail()
    const failures: string[] = []
    const processed = new Set<string>()
    const liveRepos = new Set(marketState.repos.map((item) => item.repo))
    let done = 0
    try {
      for (const [repo, check] of Object.entries(marketCheck)) {
        if (!liveRepos.has(repo)) continue
        if (check.updateAvailable !== true) continue
        try {
          const sync = await api.marketSync(repo, check.latestTag)
          // 市场源已重钉成功；后续 sourceCheck 分支不再重复处理同一 repo。
          processed.add(repo)
          // 新服务端会告诉本次版本变化涉及的技能；旧服务端退回全部技能。
          const updated = sync.updated
          const skills = updated !== undefined
            ? sync.skills.filter((name) => updated.includes(name))
            : sync.skills
          if (skills.length > 0) {
            const result = await api.syncSource(repo, skills)
            if (result.failed.length > 0) {
              failures.push(tt('market.updateAllItem', { repo, count: result.failed.length }) + ': ' + result.failed.map((item) => item.name + ': ' + item.error).join('; '))
            }
            if (result.overwritten !== undefined && result.overwritten.length > 0) {
              failures.push(tt('market.syncOverwritten', { names: result.overwritten.join(', ') }))
            }
          }
          done += 1
        } catch (error) {
          failures.push(repo + ': ' + errorMessage(error))
        }
      }
      for (const [repo, check] of Object.entries(sourceCheck)) {
        if (processed.has(repo)) continue
        if (!check.changed || check.updated.length === 0) continue
        try {
          const result = await api.syncSource(repo, check.updated)
          done += 1
          if (result.failed.length > 0) {
            failures.push(tt('market.updateAllItem', { repo, count: result.failed.length }) + ': ' + result.failed.map((item) => item.name + ': ' + item.error).join('; '))
          }
          if (result.overwritten !== undefined && result.overwritten.length > 0) {
            failures.push(tt('market.syncOverwritten', { names: result.overwritten.join(', ') }))
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
      updatingAllRef.current = false
    }
  }, [api, marketCheck, marketState.repos, sourceCheck, checkSources, checkMarket, reloadCatalog, reloadGroups, reloadSources, shared])

  /**
   * skills.sh 搜索状态。
   *
   * 与市场列表分开存放：搜索结果是一次性的「发现」结果，用户点「添加」后
   * 就变成普通市场源，不需要留在状态里；把两者混在一起会让空结果、出错、
   * 重新搜索三种情况互相覆盖。
   */
  const [skillsShQuery, setSkillsShQuery] = useState('')
  const [skillsShState, setSkillsShState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; skills: MarketSkillsShEntry[]; message?: string }>({ status: 'idle', skills: [] })

  /** 在 skills.sh 索引里搜技能。上游要求至少 2 个字符，短查询直接不发。 */
  const runSkillsShSearch = useCallback(async (): Promise<void> => {
    const query = skillsShQuery.trim()
    if (query.length < 2) return
    setSkillsShState({ status: 'loading', skills: [] })
    try {
      const result = await api.searchSkillsSh(query)
      setSkillsShState({ status: 'ready', skills: result.skills })
    } catch (error) {
      setSkillsShState({ status: 'error', skills: [], message: errorMessage(error) })
    }
  }, [api, skillsShQuery])

  /** 正在直装的技能键（`source/skillId`）；同时只允许一个，避免并发写同名目录。 */
  const [skillsShInstalling, setSkillsShInstalling] = useState<string | null>(null)

  /**
   * 直装 skills.sh 里的单个技能。
   *
   * 与「加为源」是两种诉求：这条路一步到位但不登记来源（上游不给仓库内
   * 路径，无法确定 root），所以装完不跟踪更新。失败原因（审计阻断、同名
   * 已存在）原样透出 —— 用户需要知道是被审计拒了还是重名了。
   */
  const installSkillsSh = useCallback(async (source: string, skillId: string): Promise<void> => {
    const key = source + '/' + skillId
    setSkillsShInstalling(key)
    shared.clearFail()
    try {
      const result = await api.installSkillsShSkill(source, skillId)
      if (result.status === 'installed') {
        await reloadCatalog()
        shared.succeed(tt('market.skillsShInstalled', { name: result.name }))
      } else {
        shared.fail(tt('market.skillsShInstallFailed', { name: result.name, error: result.error ?? result.status }))
      }
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setSkillsShInstalling(null)
    }
  }, [api, reloadCatalog, shared])

  return {
    marketState, marketCheck, branchChoice, branchBusy, marketSyncDialog, syncingMarket,
    syncBusy, newSourceName, repoDiscoverState, scanningRepo, repoSelected, repoImporting,
    repoResult, importJobId, marketStats, versionDialog, versionBusy, updateAllDialog,
    skillsShQuery, skillsShState, skillsShInstalling,
    setBranchChoice, setMarketSyncDialog, setNewSourceName, setRepoSelected,
    setUpdateAllDialog, setVersionDialog, setSkillsShQuery,
    loadMarket, addSource, addMarketSource, removeMarketSource, requestRemoveMarketSource, cancelRemoveMarketSource, confirmRemoveMarketSource, removeMarketDialog, scanRepo, confirmBranchChoice,
    openVersionDialog, confirmVersionDialog, toggleRepoSelected, importRepo, cancelImport,
    clearScan, checkMarket, loadMarketStats, syncMarketSource, confirmMarketSync, updateAll,
    runSkillsShSearch, installSkillsSh,
  }
}
