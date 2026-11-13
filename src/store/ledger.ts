/**
 * 停用台账 + 模型调用覆盖。
 *
 * 两者是一件事的两面：`disabled[]` 记「谁被停用了」（供 UI 展示与恢复），
 * `invocationOverrides` 记真值（发现文件绝对路径，provider 据此关掉模型调用）。
 * 所有写入口都必须同时维护这两份，所以它们放在同一个 slice。
 */
import type { DisabledSkill } from '../protocol.ts'
import type { StoreCore } from './core.ts'

export interface SkillLedgerSlice {
  listDisabled(): Promise<DisabledSkill[]>
  getDisabled(name: string): Promise<DisabledSkill | undefined>
  addDisabled(entry: DisabledSkill): Promise<void>
  removeDisabled(name: string): Promise<void>
  listInvocationOverrides(): Promise<string[]>
  addInvocationOverride(discoveryPath: string): Promise<void>
  removeInvocationOverride(discoveryPath: string): Promise<void>
}

export function skillLedgerSlice(core: StoreCore): SkillLedgerSlice {
  const { state } = core
  return {
    async listDisabled(): Promise<DisabledSkill[]> {
      await core.ensureLoaded()
      return [...state.entries.values()].sort((a, b) => a.name.localeCompare(b.name))
    },

    async getDisabled(name: string): Promise<DisabledSkill | undefined> {
      await core.ensureLoaded()
      return state.entries.get(name)
    },

    async addDisabled(entry: DisabledSkill): Promise<void> {
      await core.ensureLoaded()
      state.entries.set(entry.name, entry)
      await core.persist()
    },

    async removeDisabled(name: string): Promise<void> {
      await core.ensureLoaded()
      if (!state.entries.delete(name)) return
      await core.persist()
    },

    /** 模型调用被 hub 关掉的项目技能（发现文件绝对路径）。 */
    async listInvocationOverrides(): Promise<string[]> {
      await core.ensureLoaded()
      return [...state.invocationOverrides]
    },

    async addInvocationOverride(discoveryPath: string): Promise<void> {
      await core.ensureLoaded()
      if (state.invocationOverrides.has(discoveryPath)) return
      state.invocationOverrides.add(discoveryPath)
      await core.persist()
    },

    async removeInvocationOverride(discoveryPath: string): Promise<void> {
      await core.ensureLoaded()
      if (!state.invocationOverrides.delete(discoveryPath)) return
      await core.persist()
    },
  }
}
