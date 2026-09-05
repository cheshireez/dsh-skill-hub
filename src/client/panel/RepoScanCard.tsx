/**
 * RepoScanCard — 扫描结果归属卡片：扫描中/错误/就绪（搜索+过滤+分页+
 * 勾选导入+进度+结果）都包在这里。搜索/过滤/分页是卡片级本地状态，
 * 随卡片挂载而生、关闭而灭。从 MarketView.tsx 原样搬出，渲染逻辑不变。
 */

import { useEffect, useState, type JSX } from 'react'
import { tt } from '../helpers.ts'
import type { RepoSkillEntry } from '../../protocol.ts'
import type { SkillHubState } from './useSkillHub.ts'
import { formatBytes, formatSpeed } from './market-format.ts'
import css from './panel.module.css'

export function RepoScanCard(props: { hub: SkillHubState }): JSX.Element | null {
  const { hub } = props
  const { repoDiscoverState, scanningRepo, repoResult, repoSelected, setRepoSelected, repoImporting, toggleRepoSelected, importRepo, cancelImport } = hub

  // 列表本地状态：搜索 / 过滤 / 分页（精简：扁平列表，无 A-Z 分组）
  const [repoSearch, setRepoSearch] = useState('')
  const [repoFilter, setRepoFilter] = useState<string>('all')
  const [visibleCount, setVisibleCount] = useState(50)
  useEffect(() => { setVisibleCount(50) }, [repoDiscoverState, repoSearch, repoFilter])

  if (repoDiscoverState.status === 'idle' && repoResult === null) return null
  return (
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
  )
}
