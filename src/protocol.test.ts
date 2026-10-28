import { describe, expect, it } from 'vitest'
import { ANNOUNCEMENT_CHAR_BUDGET, computeAnnouncementBudget, type CatalogSkill } from './protocol.ts'

function skill(overrides: Partial<CatalogSkill> = {}): CatalogSkill {
  return {
    name: 'demo',
    description: 'does things',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem',
    writable: true,
    source: 'user-dsh',
    ...overrides,
  }
}

describe('computeAnnouncementBudget', () => {
  it('reports zero for an empty catalog', () => {
    expect(computeAnnouncementBudget([])).toEqual({
      skills: 0,
      chars: 0,
      approxTokens: 0,
      budget: ANNOUNCEMENT_CHAR_BUDGET,
      overBudget: false,
    })
  })

  it('sums name, description and whenToUse', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'abc', description: 'de', whenToUse: 'fg' }),
    ])
    expect(budget.skills).toBe(1)
    expect(budget.chars).toBe(7)
    expect(budget.approxTokens).toBe(3)
  })

  it('skips skills the model cannot invoke', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'model-visible', description: '' }),
      skill({ name: 'hidden', description: '', invocation: { modelInvocable: false, userInvocable: true } }),
    ])
    expect(budget.skills).toBe(1)
    expect(budget.chars).toBe('model-visible'.length)
  })

  it('flags a catalog over the budget', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'a', description: 'x'.repeat(ANNOUNCEMENT_CHAR_BUDGET) }),
    ])
    expect(budget.overBudget).toBe(true)
  })

  it('treats exactly the budget as within it', () => {
    const budget = computeAnnouncementBudget([
      skill({ name: 'a', description: 'x'.repeat(ANNOUNCEMENT_CHAR_BUDGET - 1) }),
    ])
    expect(budget.chars).toBe(ANNOUNCEMENT_CHAR_BUDGET)
    expect(budget.overBudget).toBe(false)
  })
})
