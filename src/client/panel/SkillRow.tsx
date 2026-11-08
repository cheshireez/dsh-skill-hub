/**
 * One enabled skill row: name + invocation dots + usage meta, delete and
 * disable actions. Shared by the flat list and both grouped views.
 */

import { useState, type JSX } from 'react'
import type { CatalogSkill, HubConfig } from '../../protocol.ts'
import type { SkillStatusFilter } from './hooks/useCatalogFlow.ts'
import { IconTrashOutline16 } from '../icons.tsx'
import { isDisplayNameDistinct, tt } from '../helpers.ts'
import { dotStyle, relativeTimeText } from './format.ts'
import { sourceLabel } from './source-label.ts'
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
  /** Status filter owned by the list shell; rows read it through SkillRows. */
  statusFilter?: SkillStatusFilter
  /** Hide the discovery-root badge — the by-location view already names it on the card. */
  hideSourceBadge?: boolean
  toggle: (skill: CatalogSkill, enabled: boolean) => Promise<void>
  openDetail: (name: string, workspace?: string) => Promise<void>
  requestDeleteSkill: (name: string) => void
}

export function SkillRow(props: SkillRowProps): JSX.Element {
  const { skill, uses, hubConfig, busyNames, editMode, tagBusy, duplicateNames, hideSourceBadge, toggle, openDetail, requestDeleteSkill } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const stat = uses.get(skill.name)
  const count = stat?.count ?? 0
  const lastUsed = stat?.lastUsed
  const isDuplicate = duplicateNames.has(skill.name)
  const externalSource = hideSourceBadge !== true && skill.source.startsWith('agent-') ? sourceLabel(skill.source) : null
  /** 单一状态圆点：模型可调 → 蓝；否则用户可调 → 绿。与聊天 / 菜单同规则。 */
  const dot = skill.invocation.modelInvocable
    ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} title={tt('legend.model')} />
    : skill.invocation.userInvocable
      ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} title={tt('legend.user')} />
      : null
  return (
    <div className={css.row + (skill.modelOverride === true ? ' ' + css.rowOff : '')}>
      <button
        type='button'
        className={css.rowMainButton}
        aria-label={tt('row.open', { name: skill.name })}
        onClick={() => { void openDetail(skill.name, skill.workspace) }}
      >
        <div className={css.rowMain}>
        <div className={css.rowName}>
          <span className={css.rowNameText}>{skill.name}</span>
          {externalSource !== null ? <span className={css.badge + ' ' + css.badgeSource} title={skill.source}>{externalSource}</span> : null}
          {isDisplayNameDistinct(skill.name, skill.displayName) ? <span className={css.displayName} title={skill.displayName}>{skill.displayName}</span> : null}
          {count > 0 && hubConfig?.showUseCount !== false ? <span className={css.useCount}>{count}</span> : null}
          {dot}
          {isDuplicate ? <span className={css.badge + ' ' + css.statusError} title={tt('row.duplicateHint')}>{tt('row.duplicate')}</span> : null}
          {lastUsed !== undefined && hubConfig?.showUseTime !== false ? <span className={css.useTime}>{relativeTimeText(lastUsed)}</span> : null}
        </div>
          <div className={css.rowDesc} title={skill.description}>{skill.shortDescription ?? skill.description}</div>
        </div>
      </button>
      {skill.writable || skill.toggleable === true
        ? <>
            <button
              type='button'
              role='switch'
              aria-checked={!(skill.modelOverride === true)}
              aria-label={tt(skill.modelOverride === true ? 'row.enable' : 'row.disable')}
              title={skill.toggleable === true && !skill.writable ? tt('row.disableProjectHint') : undefined}
              className={css.switch + (skill.modelOverride === true ? '' : ' ' + css.switchOn)}
              disabled={busyNames.has(skill.name)}
              onClick={(event) => { event.stopPropagation(); void toggle(skill, skill.modelOverride === true) }}
            ><span className={css.switchThumb} /></button>
            {skill.modelOverride === true ? <span className={css.badge + ' ' + css.statusLocal} title={tt('row.modelOverrideHint')}>{tt('row.modelOverride')}</span> : null}
          </>
        : <span className={css.badge + ' ' + css.badgeReadonly}>{tt('row.readonly')}</span>}
      <span className={css.menuAnchor} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false) }}>
        <button
          type='button'
          className={css.opBtn + ' ' + css.moreButton}
          aria-label={tt('row.more')}
          aria-haspopup='menu'
          aria-expanded={menuOpen}
          onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open) }}
        >⋯</button>
        {menuOpen ? <div className={css.menu} role='menu'>
          <button type='button' role='menuitem' className={css.menuItem} onClick={(event) => { event.stopPropagation(); setMenuOpen(false); void openDetail(skill.name, skill.workspace) }}>{tt('row.detail')}</button>
          {skill.writable || skill.toggleable === true ? <button type='button' role='menuitem' className={css.menuItem} disabled={busyNames.has(skill.name) || tagBusy} onClick={(event) => { event.stopPropagation(); setMenuOpen(false); void toggle(skill, skill.modelOverride === true) }}>{tt(skill.modelOverride === true ? 'row.enable' : 'row.disable')}</button> : null}
          {skill.writable ? <button type='button' role='menuitem' className={css.menuItem} disabled={busyNames.has(skill.name) || tagBusy} onClick={(event) => { event.stopPropagation(); setMenuOpen(false); requestDeleteSkill(skill.name) }}>{tt('row.delete')}</button> : null}
        </div> : null}
      </span>
      {editMode && skill.writable ? <button
        type='button'
        className={css.opBtn + ' ' + css.opDanger + ' ' + css.iconBtn}
        disabled={busyNames.has(skill.name) || tagBusy}
        title={tt('row.delete')}
        aria-label={tt('row.delete')}
        onClick={(event) => { event.stopPropagation(); requestDeleteSkill(skill.name) }}
      ><IconTrashOutline16 size={14} /></button> : null}
    </div>
  )
}
