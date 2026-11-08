/**
 * 乐观开关的纯函数单测：flipSkillEnabled / rollbackSkillToSnapshot。
 * 这两个函数决定「点开关后 UI 立刻变、失败再弹回」的正确性，单独测。
 */

import { describe, expect, it } from 'vitest'
import { flipSkillEnabled, rollbackSkillToSnapshot } from './useCatalogFlow.ts'
import type { CatalogResponse, CatalogSkill } from '../../../protocol.ts'

function skill(name: string, modelOverride?: boolean): CatalogSkill {
  return {
    name,
    description: name + ' desc',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'test',
    writable: true,
    source: 'user-dsh',
    ...(modelOverride === undefined ? {} : { modelOverride }),
  }
}

function catalog(...skills: CatalogSkill[]): CatalogResponse {
  return { skills, disabled: [], diagnostics: [], complete: true, pluginVersion: '0.0.0' } as unknown as CatalogResponse
}

describe('flipSkillEnabled', () => {
  it('关闭：给目标行加上 modelOverride，其它行保持不变', () => {
    const before = catalog(skill('a'), skill('b'))
    const after = flipSkillEnabled(before, 'a', false)
    expect(after?.skills.find((s) => s.name === 'a')?.modelOverride).toBe(true)
    expect(after?.skills.find((s) => s.name === 'b')?.modelOverride).toBeUndefined()
    // 不可变：原对象没被改
    expect(before.skills[0].modelOverride).toBeUndefined()
  })

  it('打开：删掉目标行的 modelOverride', () => {
    const before = catalog(skill('a', true))
    const after = flipSkillEnabled(before, 'a', true)
    expect(after?.skills[0].modelOverride).toBeUndefined()
  })

  it('找不到该技能或 catalog 为 null 时原样返回', () => {
    const before = catalog(skill('a'))
    expect(flipSkillEnabled(before, 'zzz', false)).toBe(before)
    expect(flipSkillEnabled(null, 'a', false)).toBeNull()
  })
})

describe('rollbackSkillToSnapshot', () => {
  it('只把目标行恢复成快照，其它行保留当前值', () => {
    const snapshot = catalog(skill('a'), skill('b'))
    // 请求期间 b 被别的操作改了：当前 b 有 override
    const current = catalog(skill('a', true), skill('b', true))
    const restored = rollbackSkillToSnapshot(current, snapshot, 'a')
    expect(restored.skills.find((s) => s.name === 'a')?.modelOverride).toBeUndefined()
    expect(restored.skills.find((s) => s.name === 'b')?.modelOverride).toBe(true)
  })
})
