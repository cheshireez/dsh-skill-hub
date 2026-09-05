/**
 * MarketSourceRow — 一个已添加来源的完整行：状态徽章 + 操作按钮。
 * B 方案：扫描主按钮 + 智能更新按钮（检查/更新二合一）+ 溢出移除。
 * 从 MarketView.ts 原样搬出，渲染逻辑不变。
 */

import type { JSX } from 'react'
import { tt } from '../helpers.ts'
import type { MarketSourceRecord } from '../../protocol.ts'
import type { SkillHubState } from './useSkillHub.ts'
import { formatCount } from './market-format.ts'
import css from './panel.module.css'

export function MarketSourceRow(props: { hub: SkillHubState; record: MarketSourceRecord }): JSX.Element {
  const { hub, record } = props
  const { marketCheck, sourceCheck, sourcesState, scanningRepo, syncingMarket, checkingSource, tagBusy, checkSources, checkMarket, syncMarketSource, scanRepo, removeMarketSource } = hub
  const releaseCheck = marketCheck[record.repo]
  const skillCheck = sourceCheck[record.repo]
  const installedCount = sourcesState?.sources.find((source) => source.repo === record.repo)?.skills.length ?? 0
  const scanning = scanningRepo === record.repo
  const syncing = syncingMarket === record.repo
  const checking = checkingSource === record.repo
  const hasSkillUpdate = skillCheck?.changed === true && skillCheck.updated.length > 0
  const hasReleaseUpdate = releaseCheck?.updateAvailable === true
  const hasUpdate = hasSkillUpdate || hasReleaseUpdate
  const isChecked = releaseCheck !== undefined || skillCheck !== undefined
  // 智能按钮三态：未检查→检查更新，未检查完/有更新→更新 N 个，已检查无更新→已是最新
  let updateLabel: string
  let updateDisabled = false
  let updateDanger = false
  let updateAction: () => void = () => {}
  if (syncing) {
    updateLabel = tt('market.syncing')
    updateDisabled = true
  } else if (checking) {
    updateLabel = tt('market.checking')
    updateDisabled = true
  } else if (!isChecked) {
    updateLabel = tt('market.checkUpdate')
    updateAction = () => { void checkSources(record.repo); void checkMarket() }
  } else if (hasUpdate) {
    const count = hasSkillUpdate ? skillCheck!.updated.length : 1
    updateLabel = count > 1 || hasSkillUpdate ? tt('market.updateCount', { count }) : tt('market.update')
    updateDanger = true
    updateAction = () => { void syncMarketSource(record.repo) }
  } else {
    updateLabel = tt('market.upToDate')
    updateDisabled = true
  }
  return (
    <div className={css.row + ' ' + css.rowStatic}>
      <div className={css.rowMain}>
        <div className={css.rowName}>
          <a className={css.sourceLink} href={'https://github.com/' + record.repo} target='_blank' rel='noreferrer'>{record.repo}</a>
          <button
            type='button'
            className={css.badge + ' ' + css.badgeSource}
            style={{ cursor:'pointer', fontFamily:'inherit' }}
            title={tt('market.versionHint')}
            onClick={() => { void hub.openVersionDialog(record.repo) }}
          >{record.ref ?? tt('market.unpinned')}</button>
        </div>
        {(() => {
          const stats = hub.marketStats[record.repo]
          const hasDeleted = skillCheck !== undefined && skillCheck.deleted.length > 0
          if (stats === undefined && installedCount === 0 && !hasSkillUpdate && !hasDeleted && !hasReleaseUpdate) return null
          return (
            <div className={css.hintLine} style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:3 }}>
              {hasSkillUpdate
                ? <span className={css.badge + ' ' + css.statusUpdated}>{tt('market.updatable', { count: skillCheck!.updated.length })}</span>
                : null}
              {hasDeleted
                ? <span className={css.badge + ' ' + css.statusError}>{tt('market.deletedUpstream', { count: skillCheck!.deleted.length })}</span>
                : null}
              {hasReleaseUpdate
                ? <span className={css.badge + ' ' + css.statusUpdated}>{releaseCheck!.latestTag !== undefined ? tt('market.newRelease', { version: releaseCheck!.latestTag }) : tt('market.updated')}</span>
                : null}
              {installedCount > 0 ? <span className={css.badge + ' ' + css.badgeCount}>{tt('market.installed', { count: installedCount })}</span> : null}
              {stats !== undefined ? <span className={css.badge + ' ' + css.badgeCount} title={tt('market.starsHint', { count: stats.stars })}>★ {formatCount(stats.stars)}</span> : null}
              {stats !== undefined && stats.downloads > 0 ? <span className={css.badge + ' ' + css.badgeCount} title={tt('market.downloadsHint', { count: stats.downloads })}>⭳ {formatCount(stats.downloads)}</span> : null}
            </div>
          )
        })()}
      </div>
      <button type='button' className={css.button + ' ' + css.primary} style={{ padding:'4px 10px', fontSize:12 }} disabled={scanning} onClick={() => { void scanRepo(record.repo) }}>
        {scanning ? tt('market.scanning') : tt('market.scan')}
      </button>
      <button
        type='button'
        className={css.opBtn + (updateDanger ? ' ' + css.opDanger : '')}
        disabled={updateDisabled}
        title={hasUpdate ? '将同步到上游最新版并提示可更新的本地技能' : undefined}
        onClick={updateAction}
      >
        {updateLabel}
      </button>
      <button
        type='button'
        className={css.opBtn}
        disabled={tagBusy}
        title={tt('market.removeHint')}
        aria-label={tt('market.deleteSource')}
        onClick={() => { void removeMarketSource(record.repo) }}
        style={{ padding:'4px 8px', minWidth:28 }}
      >×</button>
    </div>
  )
}
