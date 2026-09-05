/**
 * routes 共享状态：各类节流表、市场统计内存缓存、异步导入任务表。
 * 从 routes.ts 原样搬出，行为不变；各域 handler 从这里 import。
 */

import { rm, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SkillHubRouteDeps } from './helpers.ts'

/** Minimum interval between network update checks per source (GitHub rate limits). */
export const MIN_CHECK_INTERVAL_MS = 5 * 60_000

/** Last successful check time per repo (in-memory throttle for GitHub rate limits). */
export const lastSourceCheck = new Map<string, number>()
/** Last successful market update check per repo (same throttle). */
export const lastMarketCheck = new Map<string, number>()
/** Market stats (stars/downloads) throttle: hourly, plus a fallback cache. */
export const lastMarketStats = new Map<string, number>()
export const marketStatsCache = new Map<string, { stars: number; downloads: number }>()
export const MARKET_STATS_TTL_MS = 60 * 60_000
/** One-time seed of the in-memory stats cache from the sidecar (survives restarts). */
let marketStatsSeeded = false
export async function seedMarketStats(deps: SkillHubRouteDeps): Promise<void> {
  if (marketStatsSeeded) return
  marketStatsSeeded = true
  try {
    const saved = await deps.store.getMarketStatsState()
    if (saved === undefined) return
    for (const [repo, stats] of Object.entries(saved.stats)) {
      if (!marketStatsCache.has(repo)) {
        marketStatsCache.set(repo, stats)
        lastMarketStats.set(repo, saved.fetchedAt)
      }
    }
  } catch {
    // A bad snapshot just means one cold fetch; never fail the request.
  }
}

/** Async import job (B方案：jobId + 轮询，选项2后台继续) */
export interface ImportJob {
  jobId: string
  repo: string
  ref: string
  total: number
  done: number
  current?: string
  currentFile?: string
  totalBytes: number
  downloadedBytes: number
  startTime: number
  imported: Array<{ name: string; origin: string; path: string }>
  skipped: Array<{ name: string; reason: 'exists' }>
  failed: Array<{ name: string; error: string }>
  status: 'running' | 'done' | 'cancelled' | 'error'
  error?: string
  controller: AbortController
  createdAt: number
}
export const importJobs = new Map<string, ImportJob>()
export const IMPORT_JOB_TTL_MS = 5 * 60_000
export const IMPORT_JOB_MAX = 100
export function gcImportJobs(): void {
  if (importJobs.size > 500) importJobs.clear()
  const now = Date.now()
  for (const [id, job] of importJobs) {
    if (job.status !== 'running' && now - job.createdAt > IMPORT_JOB_TTL_MS) importJobs.delete(id)
  }
  if (importJobs.size > IMPORT_JOB_MAX) {
    const sorted = [...importJobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (let i = 0; i < sorted.length - IMPORT_JOB_MAX; i++) importJobs.delete(sorted[i][0])
  }
}

/** Replace one skill directory with a fresh download; restores the old dir on failure. */
export async function replaceSkillDir(targetDir: string, download: () => Promise<void>): Promise<void> {
  // 点前缀：发现扫描跳过点开头的目录（与导入临时目录 .<name>.import- 同一
  // 约定），备份即使删除失败残留下来，也不会混进目录/发现诊断，更不会
  // 造成同名技能重复注册。
  const backup = join(dirname(targetDir), '.' + basename(targetDir) + '.sync-bak-' + Date.now())
  await rename(targetDir, backup)
  try {
    await download()
  } catch (error) {
    await rename(backup, targetDir).catch(() => {})
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}
