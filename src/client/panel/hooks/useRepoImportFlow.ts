/**
 * useRepoImportFlow — 市场子域：仓库扫描/分支选择/导入任务（轮询+取消）。
 * 从 useMarketFlow 原样搬出：状态、动作、卸载中断与依赖顺序不变；市场源
 * 列表刷新（loadMarket）与目录/分组/来源重载经参数注入，不直接碰其他域。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepoImportProgressResponse } from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage } from '../../helpers.ts'
import { runFlow, type FlowNotices, type RepoDiscoverState } from './shared.ts'
import type { BranchChoiceState } from '../dialogs.tsx'

export function useRepoImportFlow(
  api: SkillHubApi,
  shared: FlowNotices,
  /** 市场源列表刷新（扫描定版后刷新 ref 徽章，导入完成后刷新列表）。 */
  loadMarket: () => Promise<void>,
  /** 目录重载（导入完成后刷新列表，目录域提供）。 */
  reloadCatalog: () => Promise<void>,
  /** 分组重载（导入后刷新，分组域提供）。 */
  reloadGroups: () => Promise<void>,
  /** 来源重载（导入后刷新，来源域提供）。 */
  reloadSources: () => Promise<void>,
) {
  const [repoDiscoverState, setRepoDiscoverState] = useState<RepoDiscoverState>({ status: 'idle' })
  /** Market repo currently being scanned (null when idle); per-row busy state. */
  const [scanningRepo, setScanningRepo] = useState<string | null>(null)
  const [repoSelected, setRepoSelected] = useState<ReadonlySet<string>>(new Set())
  const [repoImporting, setRepoImporting] = useState(false)
  const [repoResult, setRepoResult] = useState<RepoImportProgressResponse | null>(null)
  const [importJobId, setImportJobId] = useState<string | null>(null)
  const [branchChoice, setBranchChoice] = useState<BranchChoiceState | null>(null)
  const [branchBusy, setBranchBusy] = useState(false)
  const pollAbortRef = useRef<AbortController | null>(null)

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
    await runFlow(shared, async () => {
      await api.setMarketSourceRef(branchChoice.repo, branchChoice.selected)
      setBranchChoice(null)
      await scanRepo(branchChoice.repo)
    }, () => setBranchBusy(false))
  }, [api, branchChoice, scanRepo, shared])

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

  return {
    repoDiscoverState, scanningRepo, repoSelected, repoImporting, repoResult, importJobId,
    branchChoice, branchBusy,
    setBranchChoice, setRepoSelected,
    // 供 useMarketFlow 的 addSource 内联扫描使用（不对外暴露）。
    setRepoDiscoverState, setScanningRepo, setRepoResult,
    scanRepo, confirmBranchChoice, toggleRepoSelected, importRepo, cancelImport, clearScan,
  }
}
