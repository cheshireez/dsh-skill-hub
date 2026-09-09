import { describe, expect, it } from 'vitest'
import { mapConcurrent } from './concurrency.ts'

describe('mapConcurrent', () => {
  it('preserves index order and runs every item', async () => {
    const items = [5, 1, 4, 2, 3]
    const result = await mapConcurrent(items, 2, async (item) => item * 10)
    expect(result).toEqual([50, 10, 40, 20, 30])
  })

  it('never exceeds the limit concurrently', async () => {
    let active = 0
    let peak = 0
    await mapConcurrent(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return undefined
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('clamps a non-positive limit to one runner', async () => {
    const seen: number[] = []
    await mapConcurrent([1, 2, 3], 0, async (item) => { seen.push(item) })
    expect(seen).toEqual([1, 2, 3])
  })

  it('returns an empty array for empty input', async () => {
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([])
  })
})
