/**
 * 使用统计的增量扫描检查点。
 *
 * 字段是「上一次扫描到哪」的水位（frozenBefore / frozenSessions / 累计总量），
 * 不是展示数据 —— 展示由 stats 服务实时计算。
 */
import type { SkillStatsCheckpoint } from '../protocol.ts'
import type { StoreCore } from './core.ts'

export interface StatsSlice {
  /** The persisted usage-statistics checkpoint (undefined until first saved). */
  getSkillStatsState(): Promise<SkillStatsCheckpoint | undefined>
  /** Persist a usage-statistics checkpoint (after every completed scan). */
  saveSkillStatsState(state: SkillStatsCheckpoint): Promise<void>
}

export function statsSlice(core: StoreCore): StatsSlice {
  const { state } = core
  return {
    async getSkillStatsState(): Promise<SkillStatsCheckpoint | undefined> {
      await core.ensureLoaded()
      return state.skillStats !== undefined
        ? {
            ...state.skillStats,
            frozenSessions: { ...state.skillStats.frozenSessions },
            ...(state.skillStats.lastTotals !== undefined ? { lastTotals: [...state.skillStats.lastTotals] } : {}),
            ...(state.skillStats.coldRevisions !== undefined ? { coldRevisions: { ...state.skillStats.coldRevisions } } : {}),
          }
        : undefined
    },

    async saveSkillStatsState(next: SkillStatsCheckpoint): Promise<void> {
      await core.ensureLoaded()
      state.skillStats = {
        windowDays: next.windowDays,
        frozenBefore: next.frozenBefore,
        frozenSessions: { ...next.frozenSessions },
        lastFullReconcile: next.lastFullReconcile,
        ...(next.lastTotals !== undefined ? { lastTotals: [...next.lastTotals] } : {}),
        ...(next.coldRevisions !== undefined ? { coldRevisions: { ...next.coldRevisions } } : {}),
      }
      await core.persist()
    },
  }
}
