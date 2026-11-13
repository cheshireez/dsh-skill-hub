import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DisabledSkill, HubConfig, MarketSourceRecord, MarketStatsSnapshot, SkillStatsCheckpoint, SkillTag, SourceRecord, TrashEntry } from '../protocol.ts'

/** 默认角色名（系统预置的兜底角色，新技能自动归入）。 */
export const DEFAULT_SCENE_NAME = '通用'

/** Wire shape persisted on disk. */
export interface StoreFile {
  version: number
  disabled: DisabledSkill[]
  /** Runtime configuration edited from the web settings card (hub-owned, not settings-service). */
  config?: Partial<HubConfig>
  /** User-defined tag groups (pure organization; skill files untouched). */
  tags?: SkillTag[]
  /** Upstream source tracking records (repo + commit snapshot). */
  sources?: SourceRecord[]
  /** User-added market sources (owner/repo slugs + optional pinned ref). */
  marketSources?: MarketSourceRecord[]
  /** Trashed skills (removed after upstream deletion, restorable). */
  trash?: TrashEntry[]
  /** Usage-statistics incremental-scan checkpoint (frozen watermark + totals). */
  skillStats?: SkillStatsCheckpoint
  /** Market-stats snapshot (stars/downloads per repo, hourly TTL). */
  marketStats?: MarketStatsSnapshot
  /** Drag-reorder: collection name order for 来源分组 */
  collectionOrder?: string[]
  /** Drag-reorder: 来源顶层分组整体顺序（project / col:xxx / uncategorized-source） */
  sourceGroupOrder?: string[]
  /**
   * 模型调用覆盖：发现文件绝对路径 → 该技能的模型自动调用被 hub 关掉。
   *
   * 所有技能的停用都走这里（第一轮重构后统一）：覆盖只改 invocation
   * （模型不自动调，`/name` 仍可用），文件一个字节都不动，项目根也不会被
   * 污染。台账 `disabled[]` 记「谁被停用了」，真值在这份路径集合里。
   */
  invocationOverrides?: string[]
}

/** Resolve the DSH home directory (the filesystem provider's user-dsh root base). */
export function dshHome(): string {
  // A blank override must behave like an unset one: `??` alone would resolve
  // the home to a relative path and write the sidecar into the current cwd.
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Resolve the sidecar state path (injectable in tests). */
export function statePath(home = dshHome()): string {
  return join(home, 'dsh-skill-hub.json')
}

/** Current sidecar schema version. Bump on breaking shape changes and add a migration below. */
export const STORE_VERSION = 4
