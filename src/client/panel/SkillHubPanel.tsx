/**
 * The skill hub panel: catalog grouped by tags + source collections, search
 * and filter in one row, per-group tri-state switches with conflict dialogs,
 * upstream source tracking (check / sync / follow upstream deletion into a
 * restorable trash), market sources, disabled re-enable,
 * detail inspection, and the new-skill scaffold form.
 *
 * Thin shell: state and flows live in useSkillHub, the tab contents live in
 * SourcesView / ScenesView / MarketView, and the dialog family lives in
 * dialogs.tsx. This component owns only the shared chrome (header, banners,
 * filter bar, shared sections) and the view routing — and holds no hooks,
 * so the detail / tag-editor early returns are safe.
 */

import { useState } from 'react'
import type { WritableRoot } from '../../protocol.ts'
import { IconSkillOutline16 } from '../icons.tsx'
import type { SkillHubApi } from '../api.ts'
import { tt } from '../helpers.ts'
import { PRIVATE_SOURCE, type SortKey } from '../grouping.ts'
import { dotStyle, relativeTimeText } from './format.ts'
import { SkillDetailView } from './SkillDetailView.tsx'
import { TagEditorView } from './TagEditorView.tsx'
import { SourcesView } from './SourcesView.tsx'
import { ScenesView } from './ScenesView.tsx'
import { MarketView } from './MarketView.tsx'
import { DisabledRow } from './DisabledRow.tsx'
import { BranchChoiceDialog, ConfirmDialog, ConflictDialog, MarketSyncDialog } from './dialogs.tsx'
import { useSkillHub } from './useSkillHub.ts'
import css from './panel.module.css'

export interface SkillHubPanelProps {
  api: SkillHubApi
}

export function SkillHubPanel(props: SkillHubPanelProps): React.JSX.Element {
  const hub = useSkillHub(props.api)
  /** 工作区输入草稿：回车才应用，避免每次按键都触发目录重拉。 */
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const {
    catalog, loading, loadError, successBanner, updateState, detail, detailLoading, showForm, formName, formDesc,
    formRoot, formBusy, formMessage, hubConfig, tab, skillView, sourceFilter, sortKey, search,
    workspace, setWorkspace,
    sourcesState, tagBusy, busyNames, normalized, origins, sourceOptions, filtered,
    conflictDialog, confirmDialog, deleteSkillDialog, confirmClearTrash, branchChoice, branchBusy, marketSyncDialog,
    syncBusy, editingTag, editName, membersDraft, editSearch, uses, groupsState, sourceCheck, checkingSource, syncingSource,
    showLegend,
    setLoadError, setSuccessBanner, setDetail, setShowForm, setFormName, setFormDesc, setFormRoot, setFormMessage, setTab,
    setSkillView, setSourceFilter, setSortKey, setSearch, setConflictDialog, setConfirmDialog, setDeleteSkillDialog,
    setConfirmClearTrash, setBranchChoice, setMarketSyncDialog, setEditingTag, setEditName, setMembersDraft, setEditSearch,
    setShowLegend,
    checkUpdate, loadMarket, checkSources, requestSync, requestDelete, restoreTrash, clearTrash, runDeleteSkill,
    runConfirmed, resolveConflict, confirmBranchChoice, confirmMarketSync, create, saveTag, deleteTag, enableDisabled,
  } = hub

  // -------------------------------------------------------------- detail

  if (detail !== null) {
    return (
      <SkillDetailView
        detail={detail}
        hubConfig={hubConfig}
        uses={uses}
        groupsState={groupsState}
        sourcesState={sourcesState}
        sourceCheck={sourceCheck}
        checkingSource={checkingSource}
        syncingSource={syncingSource}
        loading={detailLoading}
        onBack={() => { setDetail(null) }}
        onCheck={(repo) => { void checkSources(repo) }}
        onSync={requestSync}
        onFollowDelete={requestDelete}
      />
    )
  }

  if (editingTag !== null) {
    return (
      <TagEditorView
        tag={editingTag}
        editName={editName}
        membersDraft={membersDraft}
        editSearch={editSearch}
        catalog={catalog}
        tagBusy={tagBusy}
        onBack={() => { setEditingTag(null) }}
        onEditName={setEditName}
        onEditSearch={setEditSearch}
        onToggleMember={(name, checked) => {
          setMembersDraft((previous) => {
            const next = new Set(previous)
            if (checked) next.add(name)
            else next.delete(name)
            return next
          })
        }}
        onRename={() => { void saveTag(editingTag.id, editName, null) }}
        onDelete={() => { void deleteTag(editingTag.id) }}
        onSaveMembers={() => { void saveTag(editingTag.id, editName, [...membersDraft]) }}
      />
    )
  }

  /** 检查结果的悬停提示：收敛到「检查更新」按钮上，不再占面板顶部横幅。 */
  const updateTitle = ((): string | undefined => {
    if (updateState.status === 'checking') return tt('update.checking')
    if (updateState.status === 'error') return tt('update.error', { error: updateState.message })
    if (updateState.status === 'ready') {
      const data = updateState.data
      if (data.error !== undefined) return tt('update.error', { error: data.error })
      if (data.updateAvailable) return tt('update.available', { version: data.latestVersion ?? '', current: data.currentVersion })
      if (data.latestVersion === null) return tt('update.unavailable')
      return tt('update.upToDate', { version: data.latestVersion })
    }
    return undefined
  })()

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <h2 className={css.title}><IconSkillOutline16 size={16} className={css.titleIcon} /> {tt('panel.title')}{catalog !== null ? <span className={css.pluginVersion}>v{catalog.pluginVersion}</span> : null}</h2>
        {catalog !== null
          ? <span className={css.headerCount}>
              {tt('panel.count', { count: catalog.skills.length + catalog.disabled.length })}
              {catalog.disabled.length > 0 ? ' · ' + tt('panel.disabledCount', { count: catalog.disabled.length }) : null}
            </span>
          : null}
        {catalog !== null && !catalog.complete ? <span className={css.hint}>{tt('panel.incomplete')}</span> : null}
        <span className={css.actions}>
          <button type='button' className={css.button} disabled={updateState.status === 'checking'} title={updateTitle} onClick={() => { void checkUpdate() }}>{updateState.status === 'checking' ? tt('update.checking') : tt('update.check')}</button>
          {updateState.status === 'ready' && updateState.data.updateAvailable && updateState.data.url !== null
            ? <a className={css.updateLink} href={updateState.data.url} target='_blank' rel='noreferrer'>{tt('update.newVersion', { version: updateState.data.latestVersion ?? '' })}</a>
            : null}
        </span>
      </div>
      <div className={css.subbar}>
        <span className={css.segmented}>
          <button type='button' className={css.segBtn + (tab === 'sources' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('sources') }}>{tt('view.sources')}</button>
          <button type='button' className={css.segBtn + (tab === 'scenes' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('scenes') }}>{tt('view.scenes')}</button>
          <button type='button' className={css.segBtn + (tab === 'market' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('market'); void loadMarket() }}>{tt('view.market')}</button>
        </span>
        <span className={css.workspaceBox}>
          <input
            className={css.search + ' ' + css.workspaceInput}
            value={workspaceDraft}
            placeholder={workspace !== '' ? workspace : tt('panel.workspacePlaceholder')}
            title={tt('panel.workspaceHint')}
            onChange={(event) => { setWorkspaceDraft(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') setWorkspace((event.target as HTMLInputElement).value.trim()) }}
          />
          {workspace !== ''
            ? <button type='button' className={css.opBtn} title={tt('panel.workspaceClear')} onClick={() => { setWorkspace(''); setWorkspaceDraft('') }}>✕</button>
            : null}
        </span>
        <button type='button' className={css.legendToggle + (showLegend ? ' ' + css.legendToggleActive : '')} onClick={() => { setShowLegend((value) => !value) }} title={tt('legend.hint')}>?</button>
        <span className={css.actions}>
          <button type='button' className={css.button + ' ' + css.primary} onClick={() => { setShowForm((value) => !value) }}>{tt('panel.new')}</button>
        </span>
      </div>

      {showForm ? (
        <form className={css.form} onSubmit={(event) => { void create(event) }}>
          <p className={css.hintLine}>{tt('form.capabilityHint')}</p>
          <div className={css.formRow}>
            <label className={css.formLabel}>{tt('form.name')}</label>
            <input className={css.input} value={formName} onChange={(event) => { setFormName(event.target.value) }} placeholder='code-review' />
          </div>
          <div className={css.formRow}>
            <label className={css.formLabel}>{tt('form.desc')}</label>
            <input className={css.input} value={formDesc} onChange={(event) => { setFormDesc(event.target.value) }} placeholder={tt('form.descPlaceholder')} />
          </div>
          <div className={css.formRow}>
            <label className={css.formLabel}>{tt('form.root')}</label>
            <select className={css.select} value={formRoot} onChange={(event) => { setFormRoot(event.target.value as WritableRoot) }}>
              <option value='user-dsh'>~/.dsh/skills</option>
              <option value='user-agents'>~/.agents/skills</option>
            </select>
          </div>
          {formMessage !== null ? <div className={formMessage.kind === 'error' ? css.formError : css.formSuccess}>{formMessage.text}</div> : null}
          <div className={css.buttons}>
            <button type='submit' className={css.button + ' ' + css.primary} disabled={formBusy}>{formBusy ? tt('form.busy') : tt('form.submit')}</button>
            <button type='button' className={css.button} onClick={() => { setShowForm(false); setFormMessage(null) }}>{tt('form.cancel')}</button>
          </div>
        </form>
      ) : null}

      {loadError !== null ? (
        <div className={css.errorBanner}>
          <span>{loadError}</span>
          <button type='button' className={css.button} onClick={() => { setLoadError(null) }}>{tt('err.dismiss')}</button>
        </div>
      ) : null}

      {successBanner !== null ? (
        <div className={css.successBanner}>
          <span>{successBanner}</span>
          <button type='button' className={css.button} onClick={() => { setSuccessBanner(null) }}>{tt('err.dismiss')}</button>
        </div>
      ) : null}

      {showLegend ? (
        <div className={css.legend}>
          <span className={css.legendItem}><span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} />{tt('legend.model')}</span>
          <span className={css.legendItem}><span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} />{tt('legend.user')}</span>
          <span className={css.legendHint}>{tt('legend.hint')}</span>
        </div>
      ) : null}

      {loading ? <div className={css.empty}>{tt('panel.loading')}</div> : null}

      {detailLoading ? <div className={css.empty}>{tt('detail.loading')}</div> : null}

      {tab === 'market' ? (
        <MarketView hub={hub} />
      ) : catalog !== null ? (
        <>
          <div className={css.filterBar}>
            {tab === 'sources' ? (
              <>
                <span className={css.segmented}>
                  <button type='button' className={css.segBtn + (skillView === 'flat' ? ' ' + css.segBtnActive : '')} onClick={() => { setSkillView('flat') }}>{tt('view.flat')}</button>
                  <button type='button' className={css.segBtn + (skillView === 'groups' ? ' ' + css.segBtnActive : '')} onClick={() => { setSkillView('groups') }}>{tt('view.grouped')}</button>
                </span>
                <select className={css.select} value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value) }}>
                  <option value='all'>{tt('filter.allSources')}</option>
                  {sourceOptions.map((source) => (
                    <option key={source} value={source}>{source === PRIVATE_SOURCE ? tt('filter.private') : source}</option>
                  ))}
                </select>
              </>
            ) : null}
            <select className={css.select} value={sortKey} onChange={(event) => { setSortKey(event.target.value as SortKey) }}>
              <option value='name'>{tt('sort.name')}</option>
              <option value='added'>{tt('sort.added')}</option>
              <option value='uses'>{tt('sort.uses')}</option>
            </select>
            <input className={css.search} value={search} onChange={(event) => { setSearch(event.target.value) }} placeholder={tt('panel.search')} />
          </div>

          {filtered.length === 0 && search.trim() !== '' ? <div className={css.empty}>{tt('panel.empty')}</div> : null}
          {filtered.length === 0 && search.trim() === '' && catalog.skills.length === 0 && catalog.disabled.length === 0 && catalog.diagnostics.length === 0
            ? <div className={css.empty}>{tt('panel.emptyAll')}</div>
            : null}

          {tab === 'sources' ? <SourcesView hub={hub} /> : <ScenesView hub={hub} />}

          {sourcesState !== null && sourcesState.trash.length > 0 ? (
            <section className={css.section}>
              <div className={css.sectionTitle + ' ' + css.sectionHeadRow}>
                <span className={css.sectionTitleFill}>{tt('source.trash')}</span>
                <button type='button' className={css.opBtn + ' ' + css.opDanger} disabled={tagBusy} onClick={() => { setConfirmClearTrash(true) }}>{tt('source.clearTrash')}</button>
              </div>
              {sourcesState.trash.map((entry) => (
                <div key={entry.name} className={css.row + ' ' + css.rowStatic}>
                  <div className={css.rowMain}>
                    <div className={css.rowName}>{entry.name}</div>
                    <div className={css.rowDesc}>{relativeTimeText(entry.movedAt)}</div>
                  </div>
                  <button type='button' className={css.opBtn} disabled={tagBusy} onClick={() => { void restoreTrash(entry.name) }}>{tt('source.restore')}</button>
                </div>
              ))}
            </section>
          ) : null}

          {catalog.disabled.length > 0 ? (
            <section className={css.section}>
              <div className={css.sectionTitle}>{tt('panel.disabled')}</div>
              {catalog.disabled
                .filter((record) =>
                  (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized))
                  && (sourceFilter === 'all' || (origins[record.name] ?? PRIVATE_SOURCE) === sourceFilter))
                .map((record) => (
                  <DisabledRow key={record.name} record={record} busy={busyNames.has(record.name)} onEnable={() => { void enableDisabled(record) }} />
                ))}
            </section>
          ) : null}

          {catalog.diagnostics.length > 0 ? (
            <section className={css.section}>
              <div className={css.sectionTitle}>{tt('panel.diagnostics')}</div>
              {catalog.diagnostics.map((entry) => (
                <div key={entry.path} className={css.diagRow}>
                  <div className={css.diagPath}>{entry.path}</div>
                  <div className={css.diagReason}>{entry.reason}</div>
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : null}

      {conflictDialog !== null ? (
        <ConflictDialog
          dialog={conflictDialog}
          tags={groupsState?.tags ?? []}
          collections={groupsState?.collections ?? []}
          onClose={() => { setConflictDialog(null) }}
          onKeepOn={() => { void resolveConflict(false) }}
          onCloseAll={() => { void resolveConflict(true) }}
        />
      ) : null}

      {confirmDialog !== null ? (
        <ConfirmDialog
          title={confirmDialog.kind === 'sync' ? tt('source.syncConfirmTitle') : tt('source.deleteConfirmTitle')}
          text={confirmDialog.kind === 'sync' ? tt('source.syncConfirmText') : tt('source.deleteConfirmText')}
          items={confirmDialog.skills}
          confirmLabel={confirmDialog.kind === 'sync' ? tt('source.sync') : tt('source.followDelete')}
          danger={confirmDialog.kind === 'delete'}
          onCancel={() => { setConfirmDialog(null) }}
          onConfirm={() => { void runConfirmed() }}
        />
      ) : null}

      {branchChoice !== null ? (
        <BranchChoiceDialog
          choice={branchChoice}
          busy={branchBusy}
          onSelect={(selected) => { setBranchChoice({ ...branchChoice, selected }) }}
          onCancel={() => { setBranchChoice(null) }}
          onConfirm={() => { void confirmBranchChoice() }}
        />
      ) : null}

      {marketSyncDialog !== null ? (
        <MarketSyncDialog
          dialog={marketSyncDialog}
          busy={syncBusy}
          onToggle={(name, checked) => {
            const next = new Set(marketSyncDialog.selected)
            if (checked) next.add(name)
            else next.delete(name)
            setMarketSyncDialog({ ...marketSyncDialog, selected: next })
          }}
          onCancel={() => { setMarketSyncDialog(null) }}
          onConfirm={() => { void confirmMarketSync() }}
        />
      ) : null}

      {deleteSkillDialog !== null ? (
        <ConfirmDialog
          title={tt('delete.confirmTitle')}
          text={tt('delete.confirmText', { name: deleteSkillDialog })}
          confirmLabel={tt('delete.confirm')}
          danger
          onCancel={() => { setDeleteSkillDialog(null) }}
          onConfirm={() => { void runDeleteSkill() }}
        />
      ) : null}

      {confirmClearTrash ? (
        <ConfirmDialog
          title={tt('source.clearTrashConfirmTitle')}
          text={tt('source.clearTrashConfirmText')}
          confirmLabel={tt('source.clearTrashConfirm')}
          danger
          onCancel={() => { setConfirmClearTrash(false) }}
          onConfirm={() => { void clearTrash() }}
        />
      ) : null}
    </div>
  )
}
