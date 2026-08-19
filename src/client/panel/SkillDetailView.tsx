/**
 * Full-page skill detail view: metadata, upstream source card with
 * check/sync/follow-delete actions, and the raw SKILL.md body. Pure
 * presentation — every state value and action arrives as a prop, so the
 * panel stays the single owner of state.
 */

import type { JSX } from 'react'
import type { GroupsResponse, HubConfig, SkillDetail, SourceCheckResult, SourcesResponse } from '../../protocol.ts'
import { tt } from '../helpers.ts'
import css from './panel.module.css'
import { dotStyle, formatDateTime, shortSha } from './format.ts'
import { SourceStatusBadge } from './SourceStatusBadge.tsx'

export interface SkillDetailViewProps {
  detail: SkillDetail
  hubConfig: HubConfig | null
  /** skillName → usage stat (count + last used). */
  uses: ReadonlyMap<string, { count: number; lastUsed?: number }>
  groupsState: GroupsResponse | null
  sourcesState: SourcesResponse | null
  sourceCheck: Readonly<Record<string, SourceCheckResult>>
  checkingSource: string | null
  syncingSource: string | null
  loading: boolean
  onBack: () => void
  /** Check one source repo for upstream updates. */
  onCheck: (repo: string) => void
  /** Request syncing the skill (overwrites local edits; opens a confirm). */
  onSync: (repo: string, skills: string[]) => void
  /** Request following the upstream deletion (moves into the trash). */
  onFollowDelete: (repo: string, skills: string[]) => void
}

export function SkillDetailView(props: SkillDetailViewProps): JSX.Element {
  const { detail, hubConfig, uses, groupsState, sourcesState, sourceCheck, checkingSource, syncingSource, loading, onBack, onCheck, onSync, onFollowDelete } = props
  const detailSource = sourcesState?.sources.find((source) => source.skills.includes(detail.name))
  const detailCheck = detailSource !== undefined ? sourceCheck[detailSource.repo] : undefined
  return (
    <div className={css.panel}>
      <div className={css.detailHead}>
        <button type='button' className={css.back} onClick={onBack}>{tt('detail.back')}</button>
        <span className={css.detailName}>
          {detail.name}
          {/* 单一状态圆点：模型可调 → 蓝；否则用户可调 → 绿。与聊天 / 菜单同规则。 */}
          {detail.invocation.modelInvocable
            ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} title={tt('legend.model')} />
            : detail.invocation.userInvocable
              ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} title={tt('legend.user')} />
              : null}
        </span>
      </div>
      <div className={css.detailMeta}>
        <div className={css.detailMetaLine}>{tt('detail.provider')}: {detail.provider}</div>
        {detail.addedAt !== undefined ? <div className={css.detailMetaLine}>{tt('detail.addedAt')}: {formatDateTime(detail.addedAt)}</div> : null}
        {detail.updatedAt !== undefined ? <div className={css.detailMetaLine}>{tt('detail.updatedAt')}: {formatDateTime(detail.updatedAt)}</div> : null}
        {detail.path !== undefined ? <div className={css.detailMetaLine}>{tt('detail.path')}: {detail.path}</div> : null}
        {detail.whenToUse !== undefined ? <div className={css.detailMetaLine}>{tt('detail.whenToUse')}: {detail.whenToUse}</div> : null}
        {(() => {
          const stat = uses.get(detail.name)
          if (stat === undefined || stat.count === 0) return null
          const at = stat.lastUsed !== undefined ? ' · ' + new Date(stat.lastUsed).toLocaleString() : ''
          return <div className={css.detailMetaLine}>{tt('detail.uses')}: {stat.count}{at}</div>
        })()}
        {(() => {
          const tags = (groupsState?.tags ?? []).filter((tag) => tag.skillNames.includes(detail.name)).map((tag) => tag.name)
          return tags.length > 0 ? <div className={css.detailMetaLine}>{tt('detail.groups')}: {tags.join(', ')}</div> : null
        })()}
      </div>
      {detailSource !== undefined ? (
        <div className={css.sourceCard}>
          <div className={css.sourceCardTitle}>
            <a className={css.sourceLink} href={'https://github.com/' + detailSource.repo} target='_blank' rel='noreferrer'>{detailSource.repo}</a>
            {detailSource.ref !== undefined ? <span className={css.badge + ' ' + css.badgeSource}>{detailSource.ref}</span> : null}
            <SourceStatusBadge check={detailCheck} />
          </div>
          <div className={css.detailMetaLine}>
            {tt('source.commit')}: {detailSource.commitSha === '' ? tt('source.unverified') : shortSha(detailSource.commitSha)}
          </div>
          <div className={css.buttons + ' ' + css.actionsTop}>
            <button type='button' className={css.opBtn} disabled={checkingSource !== null} onClick={() => { onCheck(detailSource.repo) }}>
              {checkingSource === detailSource.repo ? tt('source.checking') : tt('source.check')}
            </button>
            <button type='button' className={css.opBtn} disabled={syncingSource !== null} onClick={() => { onSync(detailSource.repo, [detail.name]) }}>
              {syncingSource === detailSource.repo ? tt('source.syncing') : tt('source.sync')}
            </button>
            {detailCheck?.deleted.includes(detail.name) === true
              ? <button type='button' className={css.opBtn + ' ' + css.opDanger} onClick={() => { onFollowDelete(detailSource.repo, [detail.name]) }}>{tt('source.followDelete')}</button>
              : null}
          </div>
        </div>
      ) : (
        <p className={css.hintLine}>{tt('source.private')}</p>
      )}
      {loading ? <div className={css.muted}>{tt('detail.loading')}</div> : null}
      <pre className={css.detailContent}>{detail.content}</pre>
    </div>
  )
}
