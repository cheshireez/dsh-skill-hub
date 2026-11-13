/**
 * 回收站记录。
 *
 * 键是「被移动后的路径」而不是名字：同名技能可能被删两次（重复删除、
 * 两种发现形态），按名字键会静默丢掉上一条记录，让它的目录变成孤儿。
 */
import type { TrashEntry } from '../protocol.ts'
import type { StoreCore } from './core.ts'

export interface TrashSlice {
  /** All trashed skills, newest first. */
  listTrash(): Promise<TrashEntry[]>
  /** One trash entry by skill name — the newest when a name has several. */
  getTrash(name: string): Promise<TrashEntry | undefined>
  /** Record a trashed skill, keyed by its trashed path. */
  addTrash(entry: TrashEntry): Promise<void>
  /** Remove a trash record by its trashed path (after restore or permanent clear). */
  removeTrash(path: string): Promise<void>
}

export function trashSlice(core: StoreCore): TrashSlice {
  const { state } = core
  return {
    async listTrash(): Promise<TrashEntry[]> {
      await core.ensureLoaded()
      return [...state.trashByPath.values()].sort((a, b) => b.movedAt - a.movedAt)
    },

    async getTrash(name: string): Promise<TrashEntry | undefined> {
      await core.ensureLoaded()
      let newest: TrashEntry | undefined
      for (const entry of state.trashByPath.values()) {
        if (entry.name !== name) continue
        if (newest === undefined || entry.movedAt > newest.movedAt) newest = entry
      }
      return newest
    },

    async addTrash(entry: TrashEntry): Promise<void> {
      await core.ensureLoaded()
      state.trashByPath.set(entry.path, entry)
      await core.persist()
    },

    async removeTrash(path: string): Promise<void> {
      await core.ensureLoaded()
      if (!state.trashByPath.delete(path)) return
      await core.persist()
    },
  }
}
