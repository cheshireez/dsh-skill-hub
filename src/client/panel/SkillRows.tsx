/**
 * SkillRows — 统一的技能行列表。停用技能已在 `catalog.skills` 里带
 * `modelOverride` 呈现，不再有单独的 disabled 行，也不再需要「同名墓碑遮蔽」。
 */

import type { JSX } from 'react'
import type { CatalogSkill } from '../../protocol.ts'
import { SkillRow, type SkillRowProps } from './SkillRow.tsx'

export interface SkillRowsProps {
  skills: CatalogSkill[]
  rowProps: Omit<SkillRowProps, 'skill'>
}

export function SkillRows(props: SkillRowsProps): JSX.Element {
  const { skills, rowProps } = props
  const status = rowProps.statusFilter ?? 'all'
  const visible = status === 'disabled'
    ? skills.filter((skill) => skill.modelOverride === true)
    : status === 'enabled'
      ? skills.filter((skill) => skill.modelOverride !== true)
      : skills
  return <>{visible.map((skill) => <SkillRow key={skill.name} skill={skill} {...rowProps} />)}</>
}
