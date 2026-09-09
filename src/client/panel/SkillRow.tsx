/**
 * One enabled skill row: name + invocation dots + usage meta, delete and
 * disable actions. Shared by the flat list and both grouped views.
 */

import type { JSX, KeyboardEvent } from 'react'
import type { CatalogSkill, HubConfig } from '../../protocol.ts'
import { IconTrashOutline16 } from '../icons.tsx'
import { isDisplayNameDistinct, tt } from '../helpers.ts'
import { dotStyle, relativeTimeText } from './format.ts'
import css from './panel.module.css'

/** The narrowed hub surface one skill row consumes. */
export interface SkillRowProps {
  skill: CatalogSkill
  /** skillName → usage stats. */
  uses: ReadonlyMap<string, { count: number; lastUsed?: number }>
  /** Effective hub config; null while it has not loaded. */
  hubConfig: HubConfig | null
  /** Names with an in-flight toggle/delete. */
  busyNames: ReadonlySet<string>
  /** Whether the edit affordances (delete) are shown. */
  editMode: boolean
  /** True while a tag operation runs (also blocks row deletes). */
  tagBusy: boolean
  /** Names that collide with another skill (duplicate badge). */
  duplicateNames: ReadonlySet<string>
  toggle: (skill: CatalogSkill, enabled: boolean) => Promise<void>
  openDetail: (name: string) => Promise<void>
  requestDeleteSkill: (name: string) => void
}

export function SkillRow(props: SkillRowProps): JSX.Element {
  const { skill, uses, hubConfig, busyNames, editMode, tagBusy, duplicateNames, toggle, openDetail, requestDeleteSkill } = props
  const stat = uses.get(skill.name)
  const count = stat?.count ?? 0
  const lastUsed = stat?.lastUsed
  const isDuplicate = duplicateNames.has(skill.name)
  /** 单一状态圆点：模型可调 → 蓝；否则用户可调 → 绿。与聊天 / 菜单同规则。 */
  const dot = skill.invocation.modelInvocable
    ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} title={tt('legend.model')} />
    : skill.invocation.userInvocable
      ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} title={tt('legend.user')} />
      : null
  /** 键盘打开详情：Enter 或空格。仅当焦点在行本身（而非行内按钮）时生效。 */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void openDetail(skill.name)
    }
  }
  return (
    <div
      className={css.row}
      role='button'
      tabIndex={0}
      aria-label={tt('row.open', { name: skill.name })}
      onClick={() => { void openDetail(skill.name) }}
      onKeyDown={onKeyDown}
    >
      <div className={css.rowMain}>
        <div className={css.rowName}>
          <span className={css.rowNameText}>{skill.name}</span>
          {isDisplayNameDistinct(skill.name, skill.displayName) ? <span className={css.displayName} title={skill.displayName}>{skill.displayName}</span> : null}
          {count > 0 && hubConfig?.showUseCount !== false ? <span className={css.useCount}>{count}</span> : null}
          {dot}
          {isDuplicate ? <span className={css.badge + ' ' + css.statusError} title={tt('row.duplicateHint')}>{tt('row.duplicate')}</span> : null}
          {lastUsed !== undefined && hubConfig?.showUseTime !== false ? <span className={css.useTime}>{relativeTimeText(lastUsed)}</span> : null}
        </div>
        <div className={css.rowDesc} title={skill.description}>{skill.shortDescription ?? skill.description}</div>
      </div>
      {skill.writable
        ? <>
            <button
              type='button'
              role='switch'
              aria-checked={true}
              aria-label={tt('row.disable')}
              className={css.switch + ' ' + css.switchOn}
              disabled={busyNames.has(skill.name)}
              onClick={(event) => { event.stopPropagation(); void toggle(skill, false) }}
            ><span className={css.switchThumb} /></button>
            {editMode ? <button
              type='button'
              className={css.opBtn + ' ' + css.opDanger + ' ' + css.iconBtn}
              disabled={busyNames.has(skill.name) || tagBusy}
              title={tt('row.delete')}
              aria-label={tt('row.delete')}
              onClick={(event) => { event.stopPropagation(); requestDeleteSkill(skill.name) }}
            ><IconTrashOutline16 size={14} /></button> : null}
          </>
        : <span className={css.badge + ' ' + css.badgeReadonly}>{tt('row.readonly')}</span>}
    </div>
  )
}
