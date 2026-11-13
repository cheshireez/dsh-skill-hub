/**
 * MarketSourceRow — 一个已添加来源的完整行：状态徽章 + 操作按钮。
 * B 方案：扫描主按钮 + 智能更新按钮（检查/更新二合一）+ 溢出移除。
 * 从 MarketView.ts 原样搬出，渲染逻辑不变。
 */

import type { JSX } from 'react'
import { countInstalled } from '../grouping.ts'
import { tt } from '../helpers.ts'
import type { MarketSourceRecord } from '../../protocol.ts'
import type { SkillHubState } from './useSkillHub.ts'
import { formatCount } from './market-format.ts'
import css from './panel.module.css'

export function MarketSourceRow(props: { hub: SkillHubState; record: MarketSourceRecord; installedNames: ReadonlySet<string> }): JSX.Element {
  const { hub, record, installedNames } = props
  const { marketCheck, sourceCheck, sourcesState, scanningRepo, syncingMarket, checkingSource, tagBusy, batchBusy, checkSources, checkMarket, syncMarketSource, requestSync, requestDelete, requestRemoveMarketSource, scanRepo } = hub
  const releaseCheck = marketCheck[record.repo]
  const skillCheck = sourceCheck[record.repo]
  const sourceRecord = sourcesState?.sources.find((source) => source.repo === record.repo)
  /** 「已装」只数 catalog 里真实存在的技能，见 countInstalled 的判据。 */
  const installedCount = countInstalled(sourceRecord, installedNames, hub.catalog !== null)
  const scanning = scanningRepo === record.repo
  const syncing = syncingMarket === record.repo
  const checking = checkingSource === record.repo
  const hasSkillUpdate = skillCheck?.changed === true && skillCheck.updated.length > 0
  const hasReleaseUpdate = releaseCheck?.updateAvailable === true
  const hasUpdate = hasSkillUpdate || hasReleaseUpdate
  const hasDeleted = skillCheck !== undefined && skillCheck.deleted.length > 0
  const isChecked = releaseCheck !== undefined || skillCheck !== undefined
  const rowBusy = batchBusy || scanning
  const hasCheckError = releaseCheck?.error !== undefined || skillCheck?.error !== undefined
  const isThrottled = releaseCheck?.throttled === true || skillCheck?.throttled === true
  /** 未导入技能的纯市场源没有 source 记录，不能调 checkSources（会 404）。 */
  const check = (): void => {
    if (rowBusy) return
    if (installedCount > 0) void checkSources(record.repo)
    void checkMarket()
  }
  // 智能按钮：未检查→检查更新，有更新→更新，失败/节流→可重试提示，已检查无更新→已是最新
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
    updateAction = check
  } else if (hasUpdate) {
    const count = hasSkillUpdate ? skillCheck!.updated.length : 1
    updateLabel = count > 1 || hasSkillUpdate ? tt('market.updateCount', { count }) : tt('market.update')
    updateDanger = true
    updateAction = () => {
      if (hasReleaseUpdate) {
        void syncMarketSource(record.repo, releaseCheck?.latestTag)
      } else {
        // No release to pin: this is a source-side skill update, so use the
        // normal source sync path (which also confirms local overwrites).
        requestSync(record.repo, skillCheck!.updated)
      }
    }
  } else if (hasDeleted) {
    updateLabel = tt('market.followDeleteCount', { count: skillCheck!.deleted.length })
    updateDanger = true
    updateAction = () => { requestDelete(record.repo, skillCheck!.deleted) }
  } else if (hasCheckError) {
    updateLabel = tt('market.checkFailed')
    updateAction = check
  } else if (isThrottled) {
    updateLabel = tt('market.checkedRecently')
    updateAction = check
  } else {
    updateLabel = tt('market.upToDate')
    updateDisabled = true
  }
  if (rowBusy) updateDisabled = true
  return (
    <div className={css.row + ' ' + css.rowStatic}>
      <div className={css.rowMain}>
        <div className={css.rowName}>
          <a className={css.sourceLink} href={'https://github.com/' + record.repo} target='_blank' rel='noreferrer'>{record.repo}</a>
          <button
            type='button'
            className={css.badge + ' ' + css.badgeSource + ' ' + css.badgeButton}
            title={tt('market.versionHint')}
            onClick={() => { void hub.openVersionDialog(record.repo) }}
          >{record.ref ?? tt('market.unpinned')}</button>
        </div>
        {(() => {
          const stats = hub.marketStats[record.repo]
          if (stats === undefined && installedCount === 0 && !hasSkillUpdate && !hasDeleted && !hasReleaseUpdate) return null
          return (
            <div className={css.hintLine + ' ' + css.rowHint}>
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
      <button type='button' className={css.button + ' ' + css.primary + ' ' + css.marketAction} disabled={scanning || rowBusy} onClick={() => { void scanRepo(record.repo) }}>
        {scanning ? tt('market.scanning') : tt('market.scan')}
      </button>
      <button
        type='button'
        className={css.opBtn + (updateDanger ? ' ' + css.opDanger : '')}
        disabled={updateDisabled}
        title={hasUpdate ? tt('market.syncHint') : undefined}
        onClick={updateAction}
      >
        {updateLabel}
      </button>
      <button
        type='button'
        className={css.opBtn + ' ' + css.marketRemove}
        disabled={tagBusy || rowBusy}
        title={tt('market.removeHint')}
        aria-label={tt('market.deleteSource')}
        onClick={() => { requestRemoveMarketSource(record.repo) }}
      >×</button>
    </div>
  )
}
