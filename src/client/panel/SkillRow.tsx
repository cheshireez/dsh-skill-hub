/**
 * One enabled skill row: name + invocation dots + usage meta, delete and
 * disable actions. Shared by the flat list and both grouped views.
 */

import type { JSX } from 'react'
import type { CatalogSkill } from '../../protocol.ts'
import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { tt } from '../helpers.ts'
import { dotStyle, relativeTimeText } from './format.ts'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function SkillRow(props: { skill: CatalogSkill; hub: SkillHubState }): JSX.Element {
  const { skill, hub } = props
  const stat = hub.uses.get(skill.name)
  const count = stat?.count ?? 0
  const lastUsed = stat?.lastUsed
  return (
    <div className={css.row} onClick={() => { void hub.openDetail(skill.name) }}>
      <div className={css.rowMain}>
        <div className={css.rowName}>
          <span className={css.rowNameText}>{skill.name}</span>
          {count > 0 && hub.hubConfig?.showUseCount !== false ? <span className={css.useCount}>{count}</span> : null}
          {skill.invocation.modelInvocable ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hub.hubConfig?.dotModelColor)} title={tt('legend.model')} /> : null}
          {skill.invocation.userInvocable ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hub.hubConfig?.dotUserColor)} title={tt('legend.user')} /> : null}
          {lastUsed !== undefined && hub.hubConfig?.showUseTime !== false ? <span className={css.useTime}>{relativeTimeText(lastUsed)}</span> : null}
        </div>
        <div className={css.rowDesc}>{skill.description}</div>
      </div>
      {skill.writable
        ? <>
            <button
              type='button'
              className={css.opBtn + ' ' + css.opDanger + ' ' + css.iconBtn}
              disabled={hub.busyNames.has(skill.name) || hub.tagBusy}
              title={tt('row.delete')}
              aria-label={tt('row.delete')}
              onClick={(event) => { event.stopPropagation(); hub.requestDeleteSkill(skill.name) }}
            ><IconTrashOutline16 size={14} /></button>
            <button
              type='button'
              role='switch'
              aria-checked={true}
              aria-label={tt('row.disable')}
              className={css.switch + ' ' + css.switchOn}
              disabled={hub.busyNames.has(skill.name)}
              onClick={(event) => { event.stopPropagation(); void hub.toggle(skill, false) }}
            ><span className={css.switchThumb} /></button>
          </>
        : <span className={css.badge + ' ' + css.badgeReadonly}>{tt('row.readonly')}</span>}
    </div>
  )
}
