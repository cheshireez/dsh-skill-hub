/**
 * Market tab: one unified market list — built-in catalog entries (add
 * button while not yet added) and the user's market sources (full state
 * badges + actions once added, plus custom sources), with check-all and
 * update-all actions and the repo scan result with the importable checklist.
 */

import { Fragment, useEffect, useMemo, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import { MARKET_CATALOG } from '../market-catalog.ts'
import type { MarketSourceRecord, RepoSkillEntry } from '../../protocol.ts'
import { ConfirmDialog } from './dialogs.tsx'
import type { SkillHubState } from './useSkillHub.ts'
import css from './panel.module.css'

/** Compact count for stars/downloads (1234 → 1.2k). */
function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

/** Compact byte size for repo preview rows. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
function formatSpeed(bps?: number): string {
  if (bps === undefined || bps <= 0) return ''
  if (bps < 1024) return bps + ' B/s'
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s'
  return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
}

export function MarketView(props: { hub: SkillHubState }): JSX.Element {
  const { hub } = props
  const { marketState, marketCheck, sourceCheck, sourcesState, repoDiscoverState, scanningRepo, repoSelected, setRepoSelected, repoImporting, repoResult, newSourceName, setNewSourceName, syncingMarket, tagBusy, checkingSource, addSource, addMarketSource, removeMarketSource, scanRepo, checkMarket, checkSources, syncMarketSource, toggleRepoSelected, importRepo, cancelImport, updateAllDialog, setUpdateAllDialog, updateAll } = hub
  /** 有可更新技能的来源（全部更新按钮与确认列表共用）。 */
  const updatableRepos = Object.entries(sourceCheck).filter(([, check]) => check.changed && check.updated.length > 0)

  // 打开市场 tab 即拉一次星星/下载数（服务端小时级缓存）。
  useEffect(() => { void hub.loadMarketStats() }, [hub])

  // 276 列表本地状态：搜索 / 过滤 / 分页（精简：扁平列表，无 A-Z 分组）
  const [repoSearch, setRepoSearch] = useState('')
  const [repoFilter, setRepoFilter] = useState<string>('all')
  const [visibleCount, setVisibleCount] = useState(50)
  useEffect(() => { setVisibleCount(50) }, [repoDiscoverState, repoSearch, repoFilter])

  /** 一个已添加来源的完整行：状态徽章 + 操作按钮。B 方案：扫描主按钮 + 智能更新按钮（检查/更新二合一）+ 溢出移除 */
  const sourceRow = (record: MarketSourceRecord): JSX.Element => {
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
      {/* 扫描结果归属卡片：用同一 section 卡片包裹扫描中/错误/就绪，标题直接点明所属仓库，消除割裂感 */}
      {(repoDiscoverState.status !== 'idle' || repoResult !== null) ? (
        <section className={css.section} style={{ borderLeft: '3px solid var(--hub-model, #2f81f7)', background: 'rgba(47,129,247,0.04)' }}>
          <div className={css.sectionTitle + ' ' + css.sectionHeadRow} style={{ margin: '10px 14px 6px' }}>
            <span className={css.sectionTitleFill} style={{ display:'flex', alignItems:'center', gap:6 }}>
              扫描结果
              <span style={{ fontWeight:400, opacity:.75 }}>
                — {repoDiscoverState.status === 'ready' ? repoDiscoverState.data.repo : repoDiscoverState.status === 'error' ? (scanningRepo ?? '') : (scanningRepo ?? '')}
                {repoDiscoverState.status === 'ready' && repoDiscoverState.data.ref !== null ? <span style={{ opacity:.5, marginLeft:6 }}>ref {repoDiscoverState.data.ref}</span> : null}
              </span>
            </span>
            <button type='button' className={css.opBtn} onClick={() => { hub.clearScan() }}>关闭</button>
          </div>
          <div style={{ padding:'0 12px 12px' }}>
            {repoDiscoverState.status === 'scanning' ? <div className={css.empty} style={{ padding:'12px 0' }}>{tt('market.scanning')}</div> : null}
            {repoDiscoverState.status === 'error' ? <div className={css.errorBanner}>{repoDiscoverState.message}</div> : null}
            {repoDiscoverState.status === 'ready' ? (() => {
        const entries = repoDiscoverState.data.entries
        // 导入后 catalog 已包含新技能，但 scan 快照的 existing 仍为 false，需用实时 catalog + 本次导入结果兜底，避免已导入仍可选
        const installedNames = new Set<string>([
          ...((hub.catalog?.skills ?? []).map((s) => s.name)),
          ...((hub.catalog?.disabled ?? []).map((d) => d.name)),
          ...((repoResult?.imported ?? []).map((r) => r.name)),
          ...((repoResult?.skipped ?? []).map((r) => r.name)),
        ])
        const isExisting = (entry: RepoSkillEntry): boolean => entry.existing || installedNames.has(entry.name)
        const selected = entries.filter((entry) => repoSelected.has(entry.path) && !isExisting(entry))
        const selectedBytes = selected.reduce((s, e) => s + e.totalBytes, 0)
        // 过滤 + 搜索（276 场景核心）
        const filtered = entries.filter((entry) => {
          if (repoFilter !== 'all' && entry.root !== repoFilter) return false
          if (repoSearch.trim() !== '' && !entry.name.toLowerCase().includes(repoSearch.trim().toLowerCase())) return false
          return true
        }).sort((a, b) => a.name.localeCompare(b.name))
        const paged = filtered.slice(0, visibleCount)
        return (
          <>
            <p className={css.hintLine + ' ' + css.hintInline}>{tt('repo.ready', { count: entries.length })} · {repoDiscoverState.data.ref !== null ? `ref ${repoDiscoverState.data.ref}` : ''}</p>
            {repoDiscoverState.data.truncated === true ? <div className={css.errorBanner} style={{ background:'rgba(210,153,34,0.08)', color:'#d29922', borderLeft:'3px solid #d29922' }}>{tt('repo.truncated')}</div> : null}
            {entries.length === 0 ? <div className={css.empty}>{tt('repo.empty')}</div> : (
              <>
                {/* 搜索 + 过滤 + 统计 — 精简 */}
                {(() => {
                  // 动态根：按已知顺序 skills/design-templates 优先，其余按字母序
                  const order = new Map<string, number>([['skills', 0], ['design-templates', 1]])
                  const roots = [...new Set(entries.map((e) => e.root))].sort((a, b) => {
                    const ao = order.get(a) ?? 99
                    const bo = order.get(b) ?? 99
                    return ao !== bo ? ao - bo : a.localeCompare(b)
                  })
                  const counts = new Map<string, number>()
                  for (const e of entries) counts.set(e.root, (counts.get(e.root) ?? 0) + 1)
                  return (
                    <div style={{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap' }}>
                      <input
                        className={css.input}
                        style={{ flex:1, minWidth:140 }}
                        value={repoSearch}
                        onChange={(e) => setRepoSearch(e.target.value)}
                        placeholder="搜索技能名…"
                      />
                      <button type='button' className={css.button + (repoFilter === 'all' ? ' ' + css.primary : '')} style={{ padding:'6px 10px', fontSize:12 }} onClick={() => setRepoFilter('all')}>全部 {entries.length}</button>
                      {roots.map((root) => (
                        <button key={root} type='button' className={css.button + (repoFilter === root ? ' ' + css.primary : '')} style={{ padding:'6px 10px', fontSize:12 }} onClick={() => setRepoFilter(root)}>{root} {counts.get(root) ?? 0}</button>
                      ))}
                    </div>
                  )
                })()}
                <div className={css.hintLine} style={{ display:'flex', justifyContent:'space-between', flexWrap:'wrap', gap:8 }}>
                  <span>已选 {selected.length}/{entries.length} · {formatBytes(selectedBytes)} · 显示 {paged.length}/{filtered.length}（过滤后）</span>
                  <span style={{ display:'flex', gap:6 }}>
                    <button type='button' className={css.button} style={{ padding:'4px 8px', fontSize:11 }} onClick={() => { setRepoSelected(new Set(filtered.filter((e)=>!isExisting(e)).slice(0, visibleCount).map((e)=>e.path))) }}>全选当前显示</button>
                    <button type='button' className={css.button} style={{ padding:'4px 8px', fontSize:11 }} onClick={() => { setRepoSelected(new Set(entries.filter((e)=>!isExisting(e)).map((e)=>e.path))) }}>全选全部 {entries.filter(e=>!isExisting(e)).length}</button>
                    <button type='button' className={css.button} style={{ padding:'4px 8px', fontSize:11 }} onClick={() => { setRepoSelected(new Set()) }}>{tt('repo.clearAll')}</button>
                  </span>
                </div>

                {/* 扁平虚拟滚动容器 — 主题自适应，CSS Modules */}
                <div className={css.scanList}>
                  {paged.length === 0 ? <div className={css.empty} style={{ padding:20 }}>无匹配技能</div> : paged.map((entry) => {
                    const existing = isExisting(entry)
                    return (
                    <label key={entry.path} className={css.row + (existing ? ' ' + css.rowMuted : '')}>
                      <input
                        type='checkbox'
                        checked={repoSelected.has(entry.path)}
                        disabled={existing}
                        onChange={(event) => { toggleRepoSelected(entry.path, event.target.checked) }}
                      />
                      <div className={css.rowMain}>
                        <div className={css.rowName}>{entry.name}</div>
                        <div className={css.rowDesc}>{entry.dir} · {tt('repo.files', { count: entry.fileCount, size: formatBytes(entry.totalBytes) })}</div>
                      </div>
                      {existing
                        ? <span className={css.badge + ' ' + css.badgeReadonly}>{tt('repo.existing')}</span>
                        : <span className={css.badge + ' ' + css.badgeSource}>{entry.origin}</span>}
                    </label>
                  )})}
                </div>
                {visibleCount < filtered.length ? (
                  <div style={{ textAlign:'center', marginTop:8 }}>
                    <button type='button' className={css.button} onClick={() => setVisibleCount((n) => n + 50)}>加载更多 50 (剩余 {filtered.length - visibleCount})</button>
                  </div>
                ) : null}

                <div className={css.buttons + ' ' + css.actionsTop}>
                  <button type='button' className={css.button + ' ' + css.primary} disabled={selected.length === 0 || repoImporting} onClick={() => { void importRepo() }}>{repoImporting ? tt('repo.importing') : `${tt('repo.import', { count: selected.length })} · ${formatBytes(selectedBytes)}`}</button>
                  {repoImporting ? <button type='button' className={css.button} onClick={() => { void cancelImport() }}>{tt('repo.cancel')}</button> : null}
                </div>
                {repoResult !== null && repoResult.status === 'running' ? (() => {
                  const pct = repoResult.totalBytes > 0 ? Math.min(100, Math.round(repoResult.downloadedBytes / repoResult.totalBytes * 100)) : (repoResult.total > 0 ? Math.round(repoResult.done / repoResult.total * 100) : 0)
                  const speed = formatSpeed(repoResult.bytesPerSecond)
                  return (
                    <div className={css.formSuccess + ' ' + css.actionsTop}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <div className={css.scanProgressTrack}>
                          <div className={css.scanProgressFill} style={{ width: `${pct}%` }} />
                        </div>
                        <span style={{ fontSize:11, opacity:.75, minWidth:32, textAlign:'right' }}>{pct}%</span>
                      </div>
                      <div className={css.hintLine}>
                        {formatBytes(repoResult.downloadedBytes)} / {formatBytes(repoResult.totalBytes)}
                        {speed !== '' ? ` · ${speed}` : ''} · {repoResult.done}/{repoResult.total} 个技能
                      </div>
                      <div className={css.hintLine} style={{marginTop:4}}>
                        {repoResult.current !== undefined ? tt('repo.importingCurrent', { name: repoResult.current, done: repoResult.done + 1, total: repoResult.total }) : tt('repo.importing')}
                        {repoResult.currentFile !== undefined ? ` · ${repoResult.currentFile}` : ''}
                      </div>
                      {repoResult.failed.length > 0 ? <div className={css.errorBanner} style={{marginTop:6}}>{repoResult.failed.map(f => `${f.name}: ${f.error}`).join('; ')}</div> : null}
                    </div>
                  )
                })() : null}
              </>
            )}
          </>
        )
      })() : null}
      {repoResult !== null && repoResult.status !== 'running' ? (
        <div className={repoResult.status === 'cancelled' ? css.errorBanner + ' ' + css.actionsTop : css.formSuccess + ' ' + css.actionsTop}>
          {repoResult.status === 'cancelled' ? tt('repo.cancelled', { imported: repoResult.imported.length, total: repoResult.total }) : `${tt('repo.imported', { count: repoResult.imported.length })} · ${tt('repo.skippedExisting', { count: repoResult.skipped.length })} · ${tt('repo.failed', { count: repoResult.failed.length })}`}
          {repoResult.failed.length > 0 ? <div style={{marginTop:6}}>{repoResult.failed.map(f => `${f.name}: ${f.error}`).join('; ')}</div> : null}
          {repoResult.status === 'error' && repoResult.error ? <div style={{marginTop:6}}>{repoResult.error}</div> : null}
        </div>
      ) : null}
          </div>
        </section>
      ) : null}

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
