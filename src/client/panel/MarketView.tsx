/**
 * Market tab: one unified market list — built-in catalog entries (add
 * button while not yet added) and the user's market sources (full state
 * badges + actions once added, plus custom sources), with check-all and
 * update-all actions and the repo scan result with the importable checklist.
 * 行渲染在 MarketSourceRow，扫描卡片在 RepoScanCard，数字格式在 market-format。
 */

import { Fragment, useEffect, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { MARKET_CATALOG } from '../market-catalog.ts'
import { ConfirmDialog } from './dialogs.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import { MarketSourceRow } from './MarketSourceRow.tsx'
import { RepoScanCard } from './RepoScanCard.tsx'
import css from './panel.module.css'

export function MarketView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { marketState, sourceCheck, scanningRepo, newSourceName, setNewSourceName, tagBusy, addSource, addMarketSource, checkMarket, checkSources, updateAllDialog, setUpdateAllDialog, updateAll, skillsShQuery, skillsShState, setSkillsShQuery, runSkillsShSearch, skillsShInstalling, installSkillsSh } = hub
  /** 市场操作的总忙态：扫描中或标签写入中都不该再触发新的源操作。 */
  const marketBusy = scanningRepo !== null || tagBusy
  /** 有可更新技能的来源（全部更新按钮与确认列表共用）。 */
  const updatableRepos = Object.entries(sourceCheck).filter(([, check]) => check.changed && check.updated.length > 0)

  // 打开市场 tab 即拉一次星星/下载数（服务端小时级缓存）。挂载一次即可：
  // hub 对象每次渲染都是新引用，依赖它会让每次渲染都重拉。
  useEffect(() => { void hub.loadMarketStats() }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // 统一列表：内置目录（未添加 → 描述+添加按钮；已添加 → 完整行）在前，
  // 自定义市场源（不在内置目录里）随后。同一个仓库不会出现两次。
  const rows: Array<{ key: string; element: JSX.Element }> = []
  for (const entry of MARKET_CATALOG) {
    const record = marketState.repos.find((item) => item.repo === entry.repo)
    if (record !== undefined) {
      rows.push({ key: entry.repo, element: <MarketSourceRow hub={hub} record={record} /> })
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
    rows.push({ key: record.repo, element: <MarketSourceRow hub={hub} record={record} /> })
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
      {/* skills.sh 搜索：独立区块。它是「发现」层 —— 结果不进市场源列表，
          点「添加」之后才变成一条普通市场源，由同一个扫描卡片接管。 */}
      <section className={css.section}>
        <div className={css.sectionTitle + ' ' + css.sectionHeadRow}>
          <span className={css.sectionTitleFill}>{tt('market.skillsShTitle')}</span>
        </div>
        <div className={css.buttons + ' ' + css.actionsPadded}>
          <input
            className={css.input + ' ' + css.grow}
            value={skillsShQuery}
            onChange={(event) => { setSkillsShQuery(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void runSkillsShSearch() } }}
            placeholder={tt('market.skillsShPlaceholder')}
          />
          <button
            type='button'
            className={css.button}
            disabled={skillsShQuery.trim().length < 2 || skillsShState.status === 'loading'}
            onClick={() => { void runSkillsShSearch() }}
          >
            {skillsShState.status === 'loading' ? tt('market.skillsShSearching') : tt('market.skillsShSearch')}
          </button>
        </div>
        <p className={css.hintLine + ' ' + css.hintPadded}>{tt('market.skillsShHint')}</p>
        {skillsShState.status === 'error' ? (
          <p className={css.hintLine + ' ' + css.hintPadded} style={{ color: 'var(--hub-danger)' }}>{skillsShState.message}</p>
        ) : null}
        {skillsShState.status === 'ready' && skillsShState.skills.length === 0 ? <div className={css.empty}>{tt('market.skillsShEmpty')}</div> : null}
        {skillsShState.skills.map((entry) => {
          const added = marketState.repos.some((record) => record.repo === entry.source)
          return (
            <div key={entry.id} className={css.row + ' ' + css.rowStatic}>
              <div className={css.rowMain}>
                <div className={css.rowName}>
                  <a className={css.sourceLink} href={'https://github.com/' + entry.source} target='_blank' rel='noreferrer'>{entry.name}</a>
                  {entry.installs !== undefined ? <span className={css.statusBadge}>{tt('market.skillsShInstalls', { count: entry.installs.toLocaleString() })}</span> : null}
                </div>
                <div className={css.rowDesc}>{entry.source} · {entry.skillId}</div>
              </div>
              <span className={css.buttons}>
                {/* 直装：只装这一个技能，一步到位，但不跟踪上游更新（上游不给
                    仓库内路径，无法登记来源）。要跟随仓库就点旁边的「加为源」。 */}
                <button
                  type='button'
                  className={css.opBtn}
                  disabled={marketBusy || skillsShInstalling !== null}
                  title={tt('market.skillsShInstall')}
                  onClick={() => { void installSkillsSh(entry.source, entry.skillId) }}
                >
                  {skillsShInstalling === entry.source + '/' + entry.skillId
                    ? tt('market.skillsShInstalling')
                    : tt('market.skillsShInstall')}
                </button>
                <button
                  type='button'
                  className={css.opBtn}
                  disabled={added || marketBusy || skillsShInstalling !== null}
                  title={added ? tt('market.skillsShAdded') : tt('market.skillsShAdd')}
                  onClick={() => { void addSource(entry.source) }}
                >
                  {added ? tt('market.skillsShAdded') : tt('market.skillsShAdd')}
                </button>
              </span>
            </div>
          )
        })}
      </section>
      {/* 扫描结果归属卡片：用同一 section 卡片包裹扫描中/错误/就绪，标题直接点明所属仓库，消除割裂感 */}
      <RepoScanCard hub={hub} />

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
