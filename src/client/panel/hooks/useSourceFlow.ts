/**
 * useSourceFlow — 来源域：来源列表/更新检查/同步确认/跟进删除/回收站恢复/
 * 清空回收站，以及单个技能/整组的删除确认流。目录与分组的刷新经聚合根
 * 传入的 reload 回调，不直接碰其他域的 state。
 */

import { useCallback, useState } from 'react'
import type {
  SourceCheckResult,
  SourcesResponse,
} from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage } from '../../helpers.ts'
import type { FlowNotices } from './shared.ts'
import type { ConfirmDialogState } from '../dialogs.tsx'

export function useSourceFlow(
  api: SkillHubApi,
  shared: FlowNotices,
  /** 目录重载（技能增删后刷新列表，目录域提供）。 */
  reloadCatalog: () => Promise<void>,
  /** 分组重载（来源/成员变化后刷新，分组域提供）。 */
  reloadGroups: () => Promise<void>,
) {
  const [sourcesState, setSourcesState] = useState<SourcesResponse | null>(null)
  const [sourceCheck, setSourceCheck] = useState<Readonly<Record<string, SourceCheckResult>>>({})
  const [checkingSource, setCheckingSource] = useState<string | null>(null)
  const [syncingSource, setSyncingSource] = useState<string | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [deleteSkillDialog, setDeleteSkillDialog] = useState<string | null>(null)
  const [deleteGroupDialog, setDeleteGroupDialog] = useState<{ name: string; skillNames: string[] } | null>(null)
  const [confirmClearTrash, setConfirmClearTrash] = useState(false)

  /** 加载来源记录 + 回收站。 */
  const loadSources = useCallback(async (): Promise<void> => {
    try {
      setSourcesState(await api.sources())
    } catch (error) {
      shared.fail(errorMessage(error))
    }
  }, [api, shared])

  /** 检查全部来源的上游更新（服务端 5 分钟节流）。 */
  const checkSources = useCallback(async (repo?: string): Promise<void> => {
    setCheckingSource(repo ?? 'all')
    shared.clearFail()
    try {
      const result = await api.checkSources(repo)
      const next: Record<string, SourceCheckResult> = { ...sourceCheck }
      for (const item of result.results) next[item.repo] = item
      setSourceCheck(next)
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      setCheckingSource(null)
    }
  }, [api, sourceCheck, shared])

  /** 请求同步某个来源的所选技能（弹确认，因为会覆盖本地修改）。 */
  const requestSync = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'sync', repo, skills })
  }, [])

  /** 请求跟进上游删除（弹确认，移入回收站）。 */
  const requestDelete = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'delete', repo, skills })
  }, [])

  /** Dismiss a confirm dialog and run the pending source action. */
  const runConfirmed = useCallback(async (): Promise<void> => {
    const dialog = confirmDialog
    if (dialog === null) return
    setConfirmDialog(null)
    if (dialog.kind === 'sync') {
      setSyncingSource(dialog.repo)
      shared.clearFail()
      try {
        const result = await api.syncSource(dialog.repo, dialog.skills)
        await Promise.all([reloadCatalog(), reloadGroups(), loadSources()])
        if (result.failed.length > 0) {
          shared.fail('sync: ' + result.failed.map((failure) => failure.name + ': ' + failure.error).join('; '))
        }
      } catch (error) {
        shared.fail(errorMessage(error))
      } finally {
        setSyncingSource(null)
      }
    } else {
      shared.clearFail()
      try {
        await api.confirmDeleteSource(dialog.repo, dialog.skills)
        await Promise.all([reloadCatalog(), reloadGroups(), loadSources()])
      } catch (error) {
        shared.fail(errorMessage(error))
      }
    }
  }, [confirmDialog, api, reloadCatalog, reloadGroups, loadSources, shared])

  /** 从回收站恢复一个技能。 */
  const restoreTrash = useCallback(async (name: string): Promise<void> => {
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      await api.restoreSource(name)
      await Promise.all([reloadCatalog(), reloadGroups(), loadSources()])
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, reloadCatalog, reloadGroups, loadSources, shared])

  /** 确认后永久删除回收站里的全部技能。 */
  const clearTrash = useCallback(async (): Promise<void> => {
    setConfirmClearTrash(false)
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      const result = await api.clearTrash()
      if (result.failed.length > 0) {
        shared.fail('clear trash: ' + result.failed.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
      await Promise.all([reloadCatalog(), loadSources()])
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, reloadCatalog, loadSources, shared])

  /** 打开单个技能的删除确认（移入回收站，可恢复）。 */
  const requestDeleteSkill = useCallback((name: string): void => {
    setDeleteSkillDialog(name)
  }, [])

  /** 执行删除确认后的回收站迁移。 */
  const runDeleteSkill = useCallback(async (): Promise<void> => {
    const name = deleteSkillDialog
    if (name === null) return
    setDeleteSkillDialog(null)
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      await api.deleteSkill(name)
      await Promise.all([reloadCatalog(), reloadGroups(), loadSources()])
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, deleteSkillDialog, reloadCatalog, reloadGroups, loadSources, shared])

  /** 打开整组删除确认（来源分组一键删除）。 */
  const requestDeleteGroup = useCallback((name: string, skillNames: string[]): void => {
    setDeleteGroupDialog({ name, skillNames })
  }, [])

  /** 执行整组删除（逐个移入回收站，跳过只读）。 */
  const runDeleteGroup = useCallback(async (): Promise<void> => {
    const dialog = deleteGroupDialog
    if (dialog === null) return
    setDeleteGroupDialog(null)
    shared.setTagBusy(true)
    shared.clearFail()
    const failures: string[] = []
    let done = 0
    for (const name of dialog.skillNames) {
      try {
        await api.deleteSkill(name)
        done += 1
      } catch (error) {
        // 只读/不存在的跳过并记录
        failures.push(name + ': ' + errorMessage(error))
      }
    }
    await Promise.all([reloadCatalog(), reloadGroups(), loadSources()])
    shared.setTagBusy(false)
    if (failures.length > 0) {
      shared.fail(`删除整组 "${dialog.name}"：成功 ${done} 个，失败 ${failures.length} 个：` + failures.join('; '))
    } else if (done > 0) {
      shared.succeed(`已删除整组 "${dialog.name}"：${done} 个技能已移入回收站`)
    }
  }, [api, deleteGroupDialog, reloadCatalog, reloadGroups, loadSources, shared])

  return {
    sourcesState, sourceCheck, checkingSource, syncingSource, confirmDialog,
    deleteSkillDialog, deleteGroupDialog, confirmClearTrash,
    setConfirmDialog, setDeleteSkillDialog, setDeleteGroupDialog, setConfirmClearTrash,
    loadSources, checkSources, requestSync, requestDelete, runConfirmed,
    restoreTrash, clearTrash, requestDeleteSkill, runDeleteSkill,
    requestDeleteGroup, runDeleteGroup,
  }
}
