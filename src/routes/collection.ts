/**
 * routes 共享层 · 集合装配：origin 映射 + 集合顺序 → 集合组，以及 groups
 * 路由的数据源。从 helpers.ts 原样搬出，行为不变。
 */

import type { CollectionGroup, GroupsResponse } from '../protocol.ts'
import type { SkillHubRouteDeps } from './deps.ts'

/**
 * 由 origin 映射（skillName → 仓库）+ 集合顺序构建集合组。
 * catalog/groups 与 sources 路由共用这一份排序语义。
 */
export function buildCollections(origins: Readonly<Record<string, string>>, collectionOrder: readonly string[]): CollectionGroup[] {
  const byCollection = new Map<string, string[]>()
  for (const [skillName, origin] of Object.entries(origins)) {
    const list = byCollection.get(origin)
    if (list === undefined) byCollection.set(origin, [skillName])
    else list.push(skillName)
  }
  const orderIndex = new Map(collectionOrder.map((name, i) => [name, i] as const))
  return [...byCollection.entries()]
    .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => {
      const ai = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Infinity
      const bi = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Infinity
      if (ai !== bi) return ai - bi
      return a.name.localeCompare(b.name)
    })
}

/** 系统集合组 + 用户 tag + origin 映射（groups 路由的数据源）。 */
export async function buildGroups(deps: SkillHubRouteDeps): Promise<GroupsResponse> {
  const [tags, origins, collectionOrder, sourceGroupOrder] = await Promise.all([deps.store.listTags(), deps.store.listOrigins(), deps.store.getCollectionOrder(), deps.store.getSourceGroupOrder()])
  const collections = buildCollections(origins, collectionOrder)
  return { ok: true, tags, collections, origins, ...(sourceGroupOrder.length > 0 ? { sourceGroupOrder } : {}), ...(collectionOrder.length > 0 ? { collectionOrder } : {}) }
}
