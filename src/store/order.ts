/**
 * 拖拽排序的持久化顺序。
 *
 * 只存顺序，不存分组本身：collection（来源分组）与 sourceGroup（顶层分组）
 * 都是派生视图，顺序是唯一需要用户拍板的部分。
 */
import type { StoreCore } from './core.ts'

export interface OrderSlice {
  /** Collection order for 来源分组拖拽 */
  getCollectionOrder(): Promise<string[]>
  /** Reorder collections by orderedNames (drag-and-drop). */
  reorderCollections(orderedNames: string[]): Promise<string[]>
  /** Source top-level group order for 来源分组（project / col:xxx / personal） */
  getSourceGroupOrder(): Promise<string[]>
  /** Reorder source top-level groups by orderedKeys */
  reorderSourceGroups(orderedKeys: string[]): Promise<string[]>
}

export function orderSlice(core: StoreCore): OrderSlice {
  const { state } = core
  return {
    async getCollectionOrder(): Promise<string[]> {
      await core.ensureLoaded()
      return [...state.collectionOrder]
    },

    async reorderCollections(orderedNames: string[]): Promise<string[]> {
      await core.ensureLoaded()
      const uniq = [...new Set(orderedNames.filter((n): n is string => typeof n === 'string' && n !== ''))]
      state.collectionOrder = uniq
      await core.persist()
      return [...state.collectionOrder]
    },

    async getSourceGroupOrder(): Promise<string[]> {
      await core.ensureLoaded()
      return [...state.sourceGroupOrder]
    },

    async reorderSourceGroups(orderedKeys: string[]): Promise<string[]> {
      await core.ensureLoaded()
      const uniq = [...new Set(orderedKeys.filter((k): k is string => typeof k === 'string' && k !== ''))]
      state.sourceGroupOrder = uniq
      await core.persist()
      return [...state.sourceGroupOrder]
    },
  }
}
