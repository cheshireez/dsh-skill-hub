/**
 * useGroupFlow — 分组域：groups 加载、tag 新建/删除/成员/重排、集合重排、
 * 来源顶层重排、组开关与冲突解决。目录侧只消费 batchToggleNames +
 * actionNames（聚合根传入），不碰目录 state。
 */

import { useCallback, useState, type FormEvent } from 'react'
import type {
  CollectionReorderRequest,
  GroupsResponse,
  SkillTag,
  SourceGroupReorderRequest,
  TagDeleteRequest,
  TagMembersRequest,
  TagReorderRequest,
} from '../../../protocol.ts'
import type { SkillHubApi } from '../../api.ts'
import { errorMessage } from '../../helpers.ts'
import { conflictsOnClose, type GroupSwitchState } from '../../grouping.ts'
import type { FlowNotices } from './shared.ts'
import type { ConflictDialogState } from '../dialogs.tsx'

export function useGroupFlow(
  api: SkillHubApi,
  shared: FlowNotices,
  /** 整组开关的执行器（目录域提供，stable）。 */
  batchToggleNames: (names: string[], enabled: boolean) => Promise<void>,
  /** 当前启用且可写的技能名（目录域派生）。 */
  actionNames: ReadonlySet<string>,
) {
  const [groupsState, setGroupsState] = useState<GroupsResponse | null>(null)
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState | null>(null)
  const [editingTag, setEditingTag] = useState<SkillTag | null>(null)
  const [editName, setEditName] = useState('')
  const [membersDraft, setMembersDraft] = useState<ReadonlySet<string>>(new Set())
  const [newTagName, setNewTagName] = useState('')
  const [editSearch, setEditSearch] = useState('')

  /** 加载用户 tag 分组 + 系统集合组 + origin 映射。 */
  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      setGroupsState(await api.groups())
    } catch (error) {
      shared.fail(errorMessage(error))
    }
  }, [api, shared])

  /** 把最新的 tag 列表合并进 groups 状态（tags 以外的字段保持原样）。 */
  const applyTags = useCallback((tags: SkillTag[]): void => {
    setGroupsState((previous) => previous === null
      ? { ok: true, tags, collections: [], origins: {} }
      : { ...previous, tags })
  }, [])

  /** 所有分组：key → 成员名（tag 与来源集合）。 */
  const groupMap = useCallback((): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    for (const tag of groupsState?.tags ?? []) map.set('tag:' + tag.id, tag.skillNames)
    for (const collection of groupsState?.collections ?? []) map.set('col:' + collection.name, collection.skillNames)
    return map
  }, [groupsState])

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

  /** 新建一个空 tag 分组。 */
  const createTag = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newTagName.trim()
    if (name === '') return
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      applyTags(await api.saveTag({ name }))
      setNewTagName('')
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, applyTags, newTagName, shared])

  /** 删除一个 tag 分组（不影响技能文件）。 */
  const deleteTag = useCallback(async (id: string): Promise<void> => {
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      applyTags(await api.deleteTag(id))
      setEditingTag(null)
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, applyTags, shared])

  /** 重命名 tag，或保存成员勾选后回到列表。 */
  const saveTag = useCallback(async (id: string, name: string, memberNames: string[] | null): Promise<void> => {
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      const safeName = name.trim()
      let tags: SkillTag[] | null = null
      if (safeName !== '') tags = await api.saveTag({ id, name: safeName })
      if (memberNames !== null) tags = await api.setTagMembers(id, memberNames)
      if (tags === null) return
      applyTags(tags)
      setEditingTag(null)
    } catch (error) {
      shared.fail(errorMessage(error))
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, applyTags, shared])

  /** 拖拽重排场景分组 */
  const reorderTags = useCallback(async (orderedIds: string[]): Promise<void> => {
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      const tags = await api.reorderTags(orderedIds)
      applyTags(tags)
    } catch (error) {
      const msg = errorMessage(error)
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        // 旧宿主无此路由：本地重排
        const byId = new Map(groupsState?.tags.map((t) => [t.id, t] as const) ?? [])
        const reordered = orderedIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => t !== undefined)
        if (reordered.length === orderedIds.length) {
          applyTags(reordered as typeof groupsState extends { tags: infer T } ? T : never)
          shared.succeed('已临时调整顺序（本地生效，重启宿主后持久化）')
        } else {
          shared.fail(msg)
        }
      } else {
        shared.fail(msg)
      }
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, applyTags, groupsState, shared])

  /** 拖拽重排来源集合 */
  const reorderCollections = useCallback(async (orderedNames: string[]): Promise<void> => {
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      const collections = await api.reorderCollections(orderedNames)
      setGroupsState((prev) => prev === null ? prev : { ...prev, collections })
      void loadGroups()
    } catch (error) {
      const msg = errorMessage(error)
      // 404 说明宿主仍在跑旧版（需重启后才有新路由），降级为本地即时生效
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        setGroupsState((prev) => {
          if (prev === null) return prev
          const map = new Map(prev.collections.map((c) => [c.name, c] as const))
          const reordered = orderedNames.map((n) => map.get(n)).filter((c): c is NonNullable<typeof c> => c !== undefined)
          // 补上未在 orderedNames 中的集合（新出现的）
          for (const c of prev.collections) if (!reordered.some((r) => r.name === c.name)) reordered.push(c)
          return { ...prev, collections: reordered }
        })
        shared.succeed('已临时调整顺序（本地生效，重启宿主后持久化）')
      } else {
        shared.fail(msg)
      }
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, loadGroups, shared])

  /** 拖拽重排来源顶层分组（project / col:xxx / personal 全量可拖） */
  const reorderSourceGroups = useCallback(async (orderedKeys: string[]): Promise<void> => {
    shared.setTagBusy(true)
    shared.clearFail()
    try {
      await api.reorderSourceGroups(orderedKeys)
      await loadGroups()
    } catch (error) {
      const msg = errorMessage(error)
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        // 旧宿主无此路由：本地重排顶层顺序，提示重启后持久化
        setGroupsState((prev) => {
          if (prev === null) return prev
          // 本地重排 collections 以匹配 topOrderedKeys 中的 col:xxx 顺序
          const colOrder = orderedKeys.filter((k) => k.startsWith('col:')).map((k) => k.slice(4))
          const map = new Map(prev.collections.map((c) => [c.name, c] as const))
          const reordered = colOrder.map((n) => map.get(n)).filter((c): c is NonNullable<typeof c> => c !== undefined)
          for (const c of prev.collections) if (!reordered.some((r) => r.name === c.name)) reordered.push(c)
          return { ...prev, collections: reordered, sourceGroupOrder: orderedKeys }
        })
        shared.succeed('已临时调整顺序（本地生效，重启宿主后持久化）')
      } else {
        shared.fail(msg)
      }
    } finally {
      shared.setTagBusy(false)
    }
  }, [api, loadGroups, shared])

  return {
    groupsState, conflictDialog, editingTag, editName, membersDraft, newTagName, editSearch,
    setConflictDialog, setEditingTag, setEditName, setMembersDraft, setNewTagName, setEditSearch,
    loadGroups, applyTags, groupMap, toggleGroup, resolveConflict,
    createTag, deleteTag, saveTag, reorderTags, reorderCollections, reorderSourceGroups,
  }
}
