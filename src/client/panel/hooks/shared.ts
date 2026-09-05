/**
 * hooks 共享层：域 hooks 之间传递的通知接口、状态机类型、轮询常量、
 * 每日自动检查 helpers。从 useSkillHub.ts 原样搬出，行为不变。
 */

import type { MarketCheckResponse, MarketSourceRecord, RepoDiscoverResponse, UpdateCheckResponse } from '../../../protocol.ts'

/**
 * 跨域共享的通知原语：聚合根用稳定的 setState setter 实现一次，
 * 各域 hooks 只调接口，不直接碰别人的 state。对象本身经 useMemo
 * 常驻，域回调的 useCallback 依赖它不会失稳。
 */
export interface FlowNotices {
  /** 报错条幅（覆盖旧报错）。 */
  fail: (message: string) => void
  /** 清掉报错条幅。 */
  clearFail: () => void
  /** 成功条幅（null = 清掉）。 */
  succeed: (message: string | null) => void
  /** tag 域忙碌开关（多域共用）。 */
  setTagBusy: (busy: boolean) => void
  /** 整组操作忙碌开关（toggle-batch 与全部更新共用）。 */
  setBatchBusy: (busy: boolean) => void
}

/** Catalog poll interval while the panel is mounted (the provider watcher feeds this). */
export const POLL_MS = 5000
/** Relaxed poll for slower-changing data (stats, groups, sources, config). */
export const SLOW_POLL_MS = 60_000
/** 空统计补捞上限：冷启动全量扫描（数十 MB 会话日志）可能超过 2 分钟，72 次约 6 分钟内保持 5 秒粒度，之后交回 60 秒慢轮询。 */
export const USES_CATCH_UP_MAX = 72

/** localStorage key of the last daily auto-check timestamp (survives sessions). */
export const AUTO_CHECK_KEY = 'skill-hub.last-auto-check'
/** Daily auto-check interval: at most one network round per day. */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60_000

/** Whether the daily auto-check should run now (first visit or ≥24h since the last). */
export function shouldAutoCheck(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_CHECK_KEY)
    const last = raw === null ? NaN : Number(raw)
    if (!Number.isFinite(last)) return true
    return Date.now() - last >= AUTO_CHECK_INTERVAL_MS
  } catch {
    // 无 localStorage（隐私模式等）：每次打开都尝试，服务端 5 分钟节流兜底。
    return true
  }
}

/** Record that the daily auto-check ran. */
export function markAutoChecked(): void {
  try {
    localStorage.setItem(AUTO_CHECK_KEY, String(Date.now()))
  } catch {
    // 无 localStorage：不记录，下次打开仍会尝试（服务端节流兜底）。
  }
}

/** One-shot self-update check state. */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; data: UpdateCheckResponse }
  | { status: 'error'; message: string }

/** Repo scanner/import state (drives the market source preview). */
export type RepoDiscoverState =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'ready'; data: RepoDiscoverResponse }
  | { status: 'error'; message: string }

/** Market sources list state. */
export type MarketState = { status: 'loading' | 'ready' | 'error'; repos: MarketSourceRecord[] }

/** One market source's update-check outcome. */
export type MarketCheckResult = MarketCheckResponse['results'][number]

/** skillName → 调用次数/末次使用（统计域产出，目录排序消费）。 */
export type UsesMap = ReadonlyMap<string, { count: number; lastUsed?: number }>
