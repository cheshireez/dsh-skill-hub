/**
 * 角色（tag）编组。
 *
 * 身份是技能名，不是路径：成员列表存名字，路由层落盘前会拿实时目录过滤；
 * 名字在这里保留是为了「技能稍后才出现」也能算成员。
 */
import type { SkillTag } from '../protocol.ts'
import type { StoreCore } from './core.ts'
import { StoreError } from './errors.ts'

export interface TagSlice {
  /** All user-defined tag groups, in creation order. */
  listTags(): Promise<SkillTag[]>
  /** One tag by id (undefined when absent). */
  getTag(id: string): Promise<SkillTag | undefined>
  /** Create (no id) or rename (with id) a tag. Returns the saved tag. */
  saveTag(input: { id?: string; name: string }): Promise<SkillTag>
  /** Delete a tag by id (no-op when absent). The default role cannot be deleted. */
  deleteTag(id: string): Promise<void>
  /** The default role (「通用」), guaranteed to exist after ensureLoaded. */
  getDefaultTag(): Promise<SkillTag | undefined>
  /** Append one skill name to a tag (deduplicated; no-op when already a member). */
  addSkillToTag(id: string, name: string): Promise<SkillTag | undefined>
  /** Replace a tag's member list wholesale (idempotent). */
  setTagMembers(id: string, skillNames: readonly string[]): Promise<SkillTag | undefined>
  /** Remove one skill from every tag group (used when the skill is deleted). */
  removeSkillFromTags(name: string): Promise<void>
  /** Reorder tag groups by orderedIds (drag-and-drop). */
  reorderTags(orderedIds: string[]): Promise<SkillTag[]>
}

export function tagSlice(core: StoreCore): TagSlice {
  const { state } = core
  return {
    async listTags(): Promise<SkillTag[]> {
      await core.ensureLoaded()
      return [...state.tagsById.values()]
    },

    async getTag(id: string): Promise<SkillTag | undefined> {
      await core.ensureLoaded()
      return state.tagsById.get(id)
    },

    /**
     * 创建（无 id）或改名（有 id）。新建分配新 UUID；改名保留成员。
     */
    async saveTag(input: { id?: string; name: string }): Promise<SkillTag> {
      await core.ensureLoaded()
      const name = input.name.trim()
      if (name === '') throw new StoreError('validation', 'tag name must not be empty')
      let tag: SkillTag
      if (input.id !== undefined) {
        const existing = state.tagsById.get(input.id)
        if (existing === undefined) throw new StoreError('not-found', 'tag not found: ' + input.id)
        tag = { ...existing, name }
      } else {
        tag = { id: crypto.randomUUID(), name, skillNames: [] }
      }
      state.tagsById.set(tag.id, tag)
      await core.persist()
      return tag
    },

    async deleteTag(id: string): Promise<void> {
      await core.ensureLoaded()
      const tag = state.tagsById.get(id)
      if (tag?.default === true) throw new StoreError('conflict', 'the default role cannot be deleted')
      if (!state.tagsById.delete(id)) return
      await core.persist()
    },

    async getDefaultTag(): Promise<SkillTag | undefined> {
      await core.ensureLoaded()
      return [...state.tagsById.values()].find((tag) => tag.default === true)
    },

    async addSkillToTag(id: string, name: string): Promise<SkillTag | undefined> {
      await core.ensureLoaded()
      const existing = state.tagsById.get(id)
      if (existing === undefined || name.trim() === '' || existing.skillNames.includes(name)) return existing
      const tag: SkillTag = { ...existing, skillNames: [...existing.skillNames, name] }
      state.tagsById.set(id, tag)
      await core.persist()
      return tag
    },

    /**
     * 整体替换成员列表（幂等）。去重、丢弃空名；未知技能名保留（它可能稍后
     * 才出现），路由层落盘前会拿实时目录过滤。
     */
    async setTagMembers(id: string, skillNames: readonly string[]): Promise<SkillTag | undefined> {
      await core.ensureLoaded()
      const existing = state.tagsById.get(id)
      if (existing === undefined) return undefined
      const names = [...new Set(skillNames.filter((n) => n.trim() !== ''))]
      const tag: SkillTag = { ...existing, skillNames: names }
      state.tagsById.set(id, tag)
      await core.persist()
      return tag
    },

    async removeSkillFromTags(name: string): Promise<void> {
      await core.ensureLoaded()
      let changed = false
      for (const tag of state.tagsById.values()) {
        if (!tag.skillNames.includes(name)) continue
        tag.skillNames = tag.skillNames.filter((n) => n !== name)
        changed = true
      }
      if (changed) await core.persist()
    },

    async reorderTags(orderedIds: string[]): Promise<SkillTag[]> {
      await core.ensureLoaded()
      const currentIds = [...state.tagsById.keys()]
      if (orderedIds.length !== currentIds.length) throw new StoreError('validation', 'orderedIds length mismatch')
      const seen = new Set<string>()
      for (const id of orderedIds) {
        if (typeof id !== 'string' || id === '') throw new StoreError('validation', 'invalid tag id')
        if (seen.has(id)) throw new StoreError('validation', 'duplicate tag id: ' + id)
        if (!state.tagsById.has(id)) throw new StoreError('not-found', 'tag not found: ' + id)
        seen.add(id)
      }
      const newMap = new Map<string, SkillTag>()
      for (const id of orderedIds) newMap.set(id, state.tagsById.get(id)!)
      state.tagsById = newMap
      await core.persist()
      return [...state.tagsById.values()]
    },
  }
}
