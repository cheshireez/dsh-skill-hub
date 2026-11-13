/**
 * 并发工具：有界并发的 map。原先 repo.ts 与 stats.ts 各有一份实现，
 * 这里统一为一份（采用 stats 版本的 limit 夹取，调用点 limit≥1 行为不变）。
 */

/**
 * Run an async worker over items with a bounded concurrency, preserving index order.
 *
 * On the first failure, stop handing out new work but wait for every in-flight
 * runner to settle before rejecting. `Promise.all` used to reject immediately
 * while the other workers were still writing into a temp dir, so the caller's
 * `finally { rm(tempDir) }` raced with `writeFile` (worked around with a 60ms
 * sleep). Settling first makes that cleanup deterministic.
 */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let firstError: unknown
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      if (firstError !== undefined) return
      const index = cursor
      cursor += 1
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        if (firstError === undefined) firstError = error
        return
      }
    }
  })
  await Promise.allSettled(runners)
  if (firstError !== undefined) throw firstError
  return results
}
