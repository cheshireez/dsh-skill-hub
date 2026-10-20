/**
 * routes 共享状态：各类节流表、市场统计内存缓存、异步导入任务表。
 * 从 routes.ts 原样搬出，行为不变；各域 handler 从这里 import。
 */

import { rm, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { errorText } from '../error-text.ts'
import { moveIntoTrash, occupancyOf, trashSourceOf } from '../skillfs.ts'
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
  /**
   * 被安全审查拦截的技能（刻意拒绝，不是下载失败）。与 failed 分开上报：failed
   * 可以重试，blocked 重试只会再撞一次同样的规则。
   */
  blocked: Array<{ name: string; reason: string }>
  /**
   * 导入时被移入回收站让位的「已禁用同名占位」名字（issue #16）。占位已挪走
   * 即计入，即使随后的下载失败也在列 —— 否则用户不知道自己的占位不见了。
   */
  replaced: string[]
  status: 'running' | 'done' | 'cancelled' | 'error'
  error?: string
  controller: AbortController
  createdAt: number
}
export const importJobs = new Map<string, ImportJob>()
export const IMPORT_JOB_TTL_MS = 5 * 60_000
export const IMPORT_JOB_MAX = 100
export function gcImportJobs(): void {
  const now = Date.now()
  for (const [id, job] of importJobs) {
    if (job.status !== 'running' && now - job.createdAt > IMPORT_JOB_TTL_MS) importJobs.delete(id)
  }
  if (importJobs.size > IMPORT_JOB_MAX) {
    // 只淘汰已结束的任务：删掉运行中的任务会让 /progress、/cancel 变成 404，
    // 而下载仍在后台跑。
    const finished = [...importJobs.entries()]
      .filter(([, job]) => job.status !== 'running')
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (let i = 0; i < finished.length && importJobs.size > IMPORT_JOB_MAX; i++) importJobs.delete(finished[i][0])
  }
}

/**
 * Replace whatever currently occupies a skill slot with a fresh download;
 * restores the previous state on failure.
 *
 * `target` is the entry to move aside — a bundle **directory** or a flat
 * `<name>.md` file, whichever the download is replacing (the rename/rm below
 * are form-neutral). The backup is dot-prefixed (discovery skips dot entries),
 * so even a failed cleanup can never register as a duplicate skill.
 */
export async function replaceInPlace(target: string, download: () => Promise<unknown>): Promise<void> {
  const backup = join(dirname(target), '.' + basename(target) + '.sync-bak-' + Date.now())
  await rename(target, backup)
  try {
    await download()
  } catch (error) {
    await rename(backup, target).catch((rollbackError) => {
      // 回滚失败会让技能只剩点前缀的备份：必须留痕。
      console.warn('[dsh-skill-hub] restoring ' + target + ' from ' + backup + ' failed:', errorText(rollbackError))
    })
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

/**
 * 让位：把一个名字下的「非启用态占位」移入回收站并清掉它的 sidecar 禁用记录。
 * 只动这两类，**启用的技能一律不碰**：
 * - 禁用发现文件（`<name>/SKILL.md.disabled` 或 `<name>.md.disabled`，两种形态都认）；
 * - 同名目录存在但既无 `SKILL.md` 也无 `SKILL.md.disabled`（导入中断/手工删除的空壳）。
 *
 * 回收站按名字索引，所以多形态只会记下最后一条的恢复指针；其余的那份会在
 * 「清空回收站」时被孤儿回收扫掉（见 sourceTrashClear）。
 *
 * @returns 被移入回收站的路径列表，没有可让位的东西时 undefined。
 */
export async function retireNamePlaceholders(deps: SkillHubRouteDeps, base: string, name: string): Promise<string[] | undefined> {
  const occupancy = await occupancyOf(base, name)
  // trashSourceOf 让「目录包禁用件」与「空壳目录」自然去重（同一个目录只搬一次）。
  const sources = [...new Set([
    ...occupancy.disabled.map((path) => trashSourceOf(path)),
    ...(occupancy.bareDir !== undefined ? [occupancy.bareDir] : []),
  ])]
  if (sources.length === 0) return undefined
  const trashed: string[] = []
  for (const source of sources) {
    const moved = await moveIntoTrash(source)
    await deps.store.addTrash({ name, path: moved.path, movedAt: Date.now(), sourcePath: moved.source })
    trashed.push(moved.path)
  }
  await deps.store.removeDisabled(name)
  return trashed
}
