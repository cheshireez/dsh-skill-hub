/**
 * 并发工具：有界并发的 map。原先 repo.ts 与 stats.ts 各有一份实现，
 * 这里统一为一份（采用 stats 版本的 limit 夹取，调用点 limit≥1 行为不变）。
 */

/** Run an async worker over items with a bounded concurrency, preserving index order. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
