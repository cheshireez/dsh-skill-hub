/**
 * Market tab: one unified market list — built-in catalog entries (add
 * button while not yet added) and the user's market sources (full state
 * badges + actions once added, plus custom sources), with check-all and
 * update-all actions and the repo scan result with the importable checklist.
 */

import { Fragment, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { MARKET_CATALOG } from '../market-catalog.ts'
import type { MarketSourceRecord } from '../../protocol.ts'
import { ConfirmDialog } from './dialogs.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

/** Compact byte size for repo preview rows. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

export function MarketView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { marketState, marketCheck, sourceCheck, sourcesState, repoDiscoverState, scanningRepo, repoSelected, setRepoSelected, repoImporting, repoResult, newSourceName, setNewSourceName, syncingMarket, tagBusy, addSource, addMarketSource, removeMarketSource, scanRepo, checkMarket, checkSources, syncMarketSource, toggleRepoSelected, importRepo, updateAllDialog, setUpdateAllDialog, updateAll } = hub
  /** 有可更新技能的来源（全部更新按钮与确认列表共用）。 */
  const updatableRepos = Object.entries(sourceCheck).filter(([, check]) => check.changed && check.updated.length > 0)

  /** 一个已添加来源的完整行：状态徽章 + 操作按钮。 */
  const sourceRow = (record: MarketSourceRecord): JSX.Element => {
    const releaseCheck = marketCheck[record.repo]
    const skillCheck = sourceCheck[record.repo]
    const installedCount = sourcesState?.sources.find((source) => source.repo === record.repo)?.skills.length ?? 0
    const scanning = scanningRepo === record.repo
    return (
      <div className={css.row + ' ' + css.rowStatic}>
        <div className={css.rowMain}>
          <div className={css.rowName}>
            <a className={css.sourceLink} href={'https://github.com/' + record.repo} target='_blank' rel='noreferrer'>{record.repo}</a>
            {record.ref !== undefined ? <span className={css.badge + ' ' + css.badgeSource}>{record.ref}</span> : null}
            {installedCount > 0 ? <span className={css.badge + ' ' + css.badgeCount}>{tt('market.installed', { count: installedCount })}</span> : null}
            {skillCheck?.changed === true && skillCheck.updated.length > 0
              ? <span className={css.badge + ' ' + css.statusUpdated}>{tt('market.updatable', { count: skillCheck.updated.length })}</span>
              : null}
            {skillCheck !== undefined && skillCheck.deleted.length > 0
              ? <span className={css.badge + ' ' + css.statusError}>{tt('market.deletedUpstream', { count: skillCheck.deleted.length })}</span>
              : null}
            {releaseCheck?.updateAvailable === true
              ? <span className={css.badge + ' ' + css.statusUpdated}>{releaseCheck.latestTag !== undefined ? tt('market.newRelease', { version: releaseCheck.latestTag }) : tt('market.updated')}</span>
              : null}
          </div>
        </div>
        <button type='button' className={css.opBtn} disabled={scanning} onClick={() => { void checkMarket() }}>{tt('market.check')}</button>
        <button type='button' className={css.opBtn + (releaseCheck?.updateAvailable === true ? ' ' + css.opDanger : '')} disabled={syncingMarket === record.repo} onClick={() => { void syncMarketSource(record.repo) }}>
          {syncingMarket === record.repo ? tt('market.syncing') : tt('market.sync')}
        </button>
        <button type='button' className={css.opBtn} disabled={scanning} onClick={() => { void scanRepo(record.repo) }}>
          {scanning ? tt('market.scanning') : tt('market.scan')}
        </button>
        <button type='button' className={css.opBtn} disabled={tagBusy} title={tt('market.removeHint')} onClick={() => { void removeMarketSource(record.repo) }}>{tt('market.deleteSource')}</button>
      </div>
    )
  }

  // 统一列表：内置目录（未添加 → 描述+添加按钮；已添加 → 完整行）在前，
  // 自定义市场源（不在内置目录里）随后。同一个仓库不会出现两次。
  const rows: Array<{ key: string; element: JSX.Element }> = []
  for (const entry of MARKET_CATALOG) {
    const record = marketState.repos.find((item) => item.repo === entry.repo)
    if (record !== undefined) {
      rows.push({ key: entry.repo, element: sourceRow(record) })
    } else {
      const busy = scanningRepo !== null || tagBusy
      rows.push({
        key: entry.repo,
        element: (
          <div className={css.row + ' ' + css.rowStatic}>
            <div className={css.rowMain}>
              <div className={css.rowName}>
                <a className={css.sourceLink} href={'https://github.com/' + entry.repo} target='_blank' rel='noreferrer'>{entry.repo}</a>
              </div>
              <div className={css.rowDesc}>{tt(entry.descriptionKey)}</div>
            </div>
            <button type='button' className={css.opBtn} disabled={busy} onClick={() => { void addSource(entry.repo) }}>{tt('market.add')}</button>
          </div>
        ),
      })
    }
  }
  for (const record of marketState.repos) {
    if (MARKET_CATALOG.some((entry) => entry.repo === record.repo)) continue
    rows.push({ key: record.repo, element: sourceRow(record) })
  }
  const unaddedCatalog = MARKET_CATALOG.filter((entry) => !marketState.repos.some((record) => record.repo === entry.repo))

  return (
    <>
      <section className={css.section}>
        <div className={css.sectionTitle + ' ' + css.sectionHeadRow}>
          <span className={css.sectionTitleFill}>{tt('market.title')}</span>
          <button type='button' className={css.opBtn} onClick={() => { void checkSources(); void checkMarket() }}>{tt('market.checkAll')}</button>
          <button
            type='button'
            className={css.opBtn + (updatableRepos.length > 0 ? ' ' + css.opDanger : '')}
            disabled={updatableRepos.length === 0 || tagBusy}
            onClick={() => { setUpdateAllDialog(true) }}
          >{tt('market.updateAll')}</button>
        </div>
        <div className={css.buttons + ' ' + css.actionsPadded}>
          <input
            className={css.input + ' ' + css.grow}
            value={newSourceName}
            onChange={(event) => { setNewSourceName(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addMarketSource() } }}
            placeholder={tt('market.addPlaceholder')}
          />
          <button type='button' className={css.button + ' ' + css.primary} disabled={newSourceName.trim() === ''} onClick={() => { void addMarketSource() }}>{tt('market.addSource')}</button>
        </div>
        {unaddedCatalog.length > 0 ? <p className={css.hintLine + ' ' + css.hintPadded}>{tt('market.catalogHint')}</p> : null}

        {marketState.status === 'loading' ? <div className={css.empty}>{tt('panel.loading')}</div> : null}
        {marketState.status !== 'loading' && rows.length === 0 ? <div className={css.empty}>{tt('market.noSources')}</div> : null}
        {marketState.status !== 'loading' ? rows.map((row) => <Fragment key={row.key}>{row.element}</Fragment>) : null}
      </section>
      {repoDiscoverState.status === 'scanning' ? <div className={css.empty}>{tt('market.scanning')}</div> : null}
      {repoDiscoverState.status === 'error' ? <div className={css.errorBanner}>{repoDiscoverState.message}</div> : null}
      {repoDiscoverState.status === 'ready' ? (() => {
        const entries = repoDiscoverState.data.entries
        const selected = entries.filter((entry) => repoSelected.has(entry.path) && !entry.existing)
        return (
          <>
            <p className={css.hintLine + ' ' + css.hintInline}>{tt('repo.ready', { count: entries.length })}</p>
            {entries.length === 0 ? <div className={css.empty}>{tt('repo.empty')}</div> : (
              <>
                <div className={css.buttons + ' ' + css.actionsBottom}>
                  <button type='button' className={css.button} onClick={() => { setRepoSelected(new Set(entries.filter((entry) => !entry.existing).map((entry) => entry.path))) }}>{tt('repo.selectAll')}</button>
                  <button type='button' className={css.button} onClick={() => { setRepoSelected(new Set()) }}>{tt('repo.clearAll')}</button>
                </div>
                {(['skills', 'design-templates'] as const).map((root) => {
                  const rootEntries = entries.filter((entry) => entry.root === root)
                  if (rootEntries.length === 0) return null
                  return (
                    <div key={root} className={css.section}>
                      <div className={css.sectionTitle}>{root === 'skills' ? tt('repo.root.skills') : tt('repo.root.designTemplates')}</div>
                      {rootEntries.map((entry) => (
                        <label key={entry.path} className={css.row + (entry.existing ? ' ' + css.rowMuted : '')}>
                          <input
                            type='checkbox'
                            checked={repoSelected.has(entry.path)}
                            disabled={entry.existing}
                            onChange={(event) => { toggleRepoSelected(entry.path, event.target.checked) }}
                          />
                          <div className={css.rowMain}>
                            <div className={css.rowName}>{entry.name}</div>
                            <div className={css.rowDesc}>{entry.dir} · {tt('repo.files', { count: entry.fileCount, size: formatBytes(entry.totalBytes) })}</div>
                          </div>
                          {entry.existing
                            ? <span className={css.badge + ' ' + css.badgeReadonly}>{tt('repo.existing')}</span>
                            : <span className={css.badge + ' ' + css.badgeSource}>{entry.origin}</span>}
                        </label>
                      ))}
                    </div>
                  )
                })}
                <button type='button' className={css.button + ' ' + css.primary} disabled={selected.length === 0 || repoImporting} onClick={() => { void importRepo() }}>{repoImporting ? tt('repo.importing') : tt('repo.import', { count: selected.length })}</button>
              </>
            )}
          </>
        )
      })() : null}
      {repoResult !== null ? <div className={css.formSuccess + ' ' + css.actionsTop}>{tt('repo.imported', { count: repoResult.imported.length })} · {tt('repo.skippedExisting', { count: repoResult.skipped.length })} · {tt('repo.failed', { count: repoResult.failed.length })}</div> : null}

      {updateAllDialog ? (
        <ConfirmDialog
          title={tt('market.updateAllConfirmTitle')}
          text={tt('market.updateAllConfirmText')}
          items={updatableRepos.map(([repo, check]) => tt('market.updateAllItem', { repo, count: check.updated.length }))}
          confirmLabel={tt('market.updateAll')}
          danger
          onCancel={() => { setUpdateAllDialog(false) }}
          onConfirm={() => { void updateAll() }}
        />
      ) : null}
    </>
  )
}
