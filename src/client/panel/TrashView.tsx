/**
 * Trash tab: restorable skills that were removed locally or followed an
 * upstream deletion. Kept separate from the general list so recoverable
 * content never mixes with active skills.
 */

import type { JSX } from 'react'
import { tt } from '../helpers.ts'
import { relativeTimeText } from './format.ts'
import { GroupHeader } from './GroupHeader.tsx'
import { GroupSection } from './GroupSection.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

export function TrashView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const entries = hub.sourcesState?.trash ?? []
  if (entries.length === 0) {
    return <div className={css.empty}>{tt('source.trashEmpty')}</div>
  }
  return (
    <GroupSection>
      <GroupHeader
        title={tt('source.trash')}
        actions={(
          <button type='button' className={css.opBtn + ' ' + css.opDanger} disabled={hub.tagBusy} onClick={() => { hub.setConfirmClearTrash(true) }}>
            {tt('source.clearTrash')}
          </button>
        )}
      />
      {entries.map((entry) => (
        <div key={entry.name} className={css.row + ' ' + css.rowStatic}>
          <div className={css.rowMain}>
            <div className={css.rowName}>{entry.name}</div>
            <div className={css.rowDesc}>{relativeTimeText(entry.movedAt)}</div>
          </div>
          <button type='button' className={css.opBtn} disabled={hub.tagBusy} onClick={() => { void hub.restoreTrash(entry.name) }}>{tt('source.restore')}</button>
        </div>
      ))}
    </GroupSection>
  )
}
