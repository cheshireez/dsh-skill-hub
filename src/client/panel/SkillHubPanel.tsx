/**
 * The skill hub panel: full catalog grouped by source, search, enable/
 * disable toggles, discovery diagnostics, disabled-skill re-enable, skill
 * body inspection, and the new-skill scaffold form.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { CatalogResponse, CatalogSkill, CollectionGroup, DisabledSkill, GroupsResponse, HubConfig, MarketRow, RepoDiscoverResponse, RepoImportResponse, RepoSkillEntry, SkillDetail, SkillTag, UpdateCheckResponse, WritableRoot } from '../../protocol.ts'
import type { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import { filterBySource, formatRelativeTime, mergeCollections, uncategorizedSkills } from '../grouping.ts'
import type { HubKey } from '../locales.ts'
import css from './panel.module.css'

/** Source groups in display order; anything else lands in the other bucket. */
const SOURCE_GROUPS = ['project-dsh', 'project-agents', 'custom', 'runtime', 'user-dsh', 'user-agents', 'bundled'] as const

/** Short per-row source badge label; unknown sources render the raw source string. */
function sourceBadgeLabel(source: string): string {
  return (SOURCE_GROUPS as readonly string[]).includes(source) ? tt(('badge.source.' + source) as HubKey) : source
}

/** Source badge label for a disabled record, derived from its writable root. */
function disabledSourceLabel(root: WritableRoot): string {
  return tt(('badge.source.' + root) as HubKey)
}

/** Compact byte size for repo preview rows. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/** Localized relative-time text for a Unix-ms timestamp. */
function relativeTimeText(ms: number): string {
  const rt = formatRelativeTime(ms)
  return tt(rt.key, rt.value !== undefined ? { value: rt.value } : undefined)
}

/** Dot inline style from the user-chosen color (undefined keeps the CSS default). */
function dotStyle(color: string | undefined): React.CSSProperties | undefined {
  if (color === undefined) return undefined
  return { background: color, borderColor: color }
}

export interface SkillHubPanelProps {
  api: SkillHubApi
}

/** Catalog poll interval while the panel is mounted (the provider watcher feeds this). */
const POLL_MS = 5000

/** One-shot self-update check state. */
type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; data: UpdateCheckResponse }
  | { status: 'error'; message: string }

/** Repo scanner/import state. */
type RepoDiscoverState =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'ready'; data: RepoDiscoverResponse }
  | { status: 'error'; message: string }

export function SkillHubPanel(props: SkillHubPanelProps): React.JSX.Element {
  const { api } = props
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [repoInput, setRepoInput] = useState('')
  const [repoDiscoverState, setRepoDiscoverState] = useState<RepoDiscoverState>({ status: 'idle' })
  const [repoSelected, setRepoSelected] = useState<ReadonlySet<string>>(new Set())
  const [repoImporting, setRepoImporting] = useState(false)
  const [repoResult, setRepoResult] = useState<RepoImportResponse | null>(null)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formRoot, setFormRoot] = useState<WritableRoot>('user-dsh')
  const [formBusy, setFormBusy] = useState(false)
  const [formMessage, setFormMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [uses, setUses] = useState<ReadonlyMap<string, { count: number; lastUsed?: number }>>(new Map())
  const [hubConfig, setHubConfig] = useState<HubConfig | null>(null)
  const [tab, setTab] = useState<'skills' | 'scenes' | 'market'>('skills')
  const [skillView, setSkillView] = useState<'flat' | 'groups'>('flat')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [marketState, setMarketState] = useState<{ status: 'loading' | 'ready' | 'error'; entries: MarketRow[] }>({ status: 'loading', entries: [] })
  const [installing, setInstalling] = useState<string | null>(null)
  const [groupsState, setGroupsState] = useState<GroupsResponse | null>(null)
  const [editingTag, setEditingTag] = useState<SkillTag | null>(null)
  const [editName, setEditName] = useState('')
  const [membersDraft, setMembersDraft] = useState<ReadonlySet<string>>(new Set())
  const [newTagName, setNewTagName] = useState('')
  const [editingScene, setEditingScene] = useState<SkillTag | null>(null)
  const [newSceneName, setNewSceneName] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [originDraft, setOriginDraft] = useState('')
  const [editSearch, setEditSearch] = useState('')
  /** 分类视图里收起的分组（key 为 tag:<id> 或 col:<name>）。 */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())
  const [showLegend, setShowLegend] = useState(false)

  const toggleGroupCollapse = useCallback((key: string): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.catalog()
      setCatalog(next)
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [api])

  const loadUses = useCallback(async (): Promise<void> => {
    try {
      const result = await api.stats()
      if (result.available) setUses(new Map(result.stats.map((stat) => [stat.name, { count: stat.count, ...(stat.lastUsed !== undefined ? { lastUsed: stat.lastUsed } : {}) }])))
    } catch {
      // Invocation counts are best-effort; a stats failure must not disturb the catalog.
    }
  }, [api])

  const loadConfig = useCallback(async (): Promise<void> => {
    try {
      setHubConfig((await api.config()).config)
    } catch {
      // Dot colors are cosmetic; a config failure falls back to the defaults.
    }
  }, [api])

  /** Check the hub's own GitHub release once, and again on demand. */
  const checkUpdate = useCallback(async (): Promise<void> => {
    setUpdateState({ status: 'checking' })
    try {
      setUpdateState({ status: 'ready', data: await api.updateCheck() })
    } catch (error) {
      setUpdateState({ status: 'error', message: errorMessage(error) })
    }
  }, [api])

  useEffect(() => {
    void load()
    void loadUses()
    void loadGroups()
    void loadConfig()
    void checkUpdate()
    const timer = window.setInterval(() => { void load(); void loadUses(); void loadGroups(); void loadConfig() }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [load, loadUses, checkUpdate])

  const openDetail = useCallback(async (name: string): Promise<void> => {
    setOriginDraft('')
    setDetailLoading(true)
    setLoadError(null)
    try {
      setDetail(await api.skill(name))
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setDetailLoading(false)
    }
  }, [api])

  const toggle = useCallback(async (skill: CatalogSkill, enabled: boolean): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(skill.name))
    setLoadError(null)
    try {
      const next = await api.toggle(skill.name, enabled)
      setCatalog(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(skill.name)
        return next
      })
    }
  }, [api])

  const enableDisabled = useCallback(async (record: DisabledSkill): Promise<void> => {
    setBusyNames((previous) => new Set(previous).add(record.name))
    setLoadError(null)
    try {
      const next = await api.toggle(record.name, true)
      setCatalog(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBusyNames((previous) => {
        const next = new Set(previous)
        next.delete(record.name)
        return next
      })
    }
  }, [api])

  /** Toggle every writable skill in a group in one write; surfaces per-name failures. */
  const batchToggle = useCallback(async (skills: CatalogSkill[], enabled: boolean): Promise<void> => {
    const names = skills.filter((skill) => skill.writable).map((skill) => skill.name)
    if (names.length === 0) return
    setBatchBusy(true)
    setLoadError(null)
    try {
      const next = await api.toggleBatch(names, enabled)
      setCatalog(next.catalog)
      if (next.failures.length > 0) {
        setLoadError('toggle-batch: ' + next.failures.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBatchBusy(false)
    }
  }, [api])

  /**
   * Toggle an explicit name set in one write. Unlike batchToggle (which
   * derives names from live catalog rows), this can re-enable disabled
   * members whose SKILL.md is renamed out of the catalog — the reason
   * enableAll must pass the full member list, not just enabled rows.
   * Disabling only targets writable names upstream; non-existent/read-only
   * names are no-ops or reported failures respectively.
   */
  const batchToggleNames = useCallback(async (names: string[], enabled: boolean): Promise<void> => {
    if (names.length === 0) return
    setBatchBusy(true)
    setLoadError(null)
    try {
      const next = await api.toggleBatch(names, enabled)
      setCatalog(next.catalog)
      if (next.failures.length > 0) {
        setLoadError('toggle-batch: ' + next.failures.map((failure) => failure.name + ': ' + failure.error).join('; '))
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setBatchBusy(false)
    }
  }, [api])

  /** 加载用户 tag 分组 + 系统集合组 + origin 映射。 */
  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      setGroupsState(await api.groups())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 把最新的 tag 列表合并进 groups 状态（tags 以外的字段保持原样）。 */
  const applyTags = useCallback((tags: SkillTag[]): void => {
    setGroupsState((previous) => previous === null
      ? { ok: true, tags, collections: [], origins: {}, scenes: [] }
      : { ...previous, tags })
  }, [])

  /** 新建一个空 tag 分组。 */
  const createTag = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newTagName.trim()
    if (name === '') return
    setTagBusy(true)
    setLoadError(null)
    try {
      applyTags(await api.saveTag({ name }))
      setNewTagName('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags, newTagName])

  /** 删除一个 tag 分组（不影响技能文件）。 */
  const deleteTag = useCallback(async (id: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      applyTags(await api.deleteTag(id))
      setEditingTag(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags])

  /** 重命名 tag，或保存成员勾选后回到列表。 */
  const saveTag = useCallback(async (id: string, name: string, memberNames: string[] | null): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const safeName = name.trim()
      let tags: SkillTag[] | null = null
      if (safeName !== '') tags = await api.saveTag({ id, name: safeName })
      if (memberNames !== null) tags = await api.setTagMembers(id, memberNames)
      if (tags === null) return
      applyTags(tags)
      setEditingTag(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyTags])

  /** 保存技能详情页里的集合归属编辑。 */
  const saveOrigin = useCallback(async (skillName: string, origin: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const next = await api.setOrigin(skillName, origin.trim() === '' ? null : origin.trim())
      setGroupsState((previous) => previous === null ? null : { ...previous, origins: next.origins, collections: next.collections })
      setOriginDraft('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api])

  /** 把最新的场景列表合并进 groups 状态。 */
  const applyScenes = useCallback((scenes: SkillTag[]): void => {
    setGroupsState((previous) => previous === null
      ? { ok: true, tags: [], collections: [], origins: {}, scenes }
      : { ...previous, scenes })
  }, [])

  /** 新建一个空场景。 */
  const createScene = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = newSceneName.trim()
    if (name === '') return
    setTagBusy(true)
    setLoadError(null)
    try {
      applyScenes(await api.saveScene({ name }))
      setNewSceneName('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyScenes, newSceneName])

  /** 删除一个场景（不影响技能文件）。 */
  const deleteSceneAction = useCallback(async (id: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      applyScenes(await api.deleteScene(id))
      setEditingScene(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyScenes])

  /** 保存场景改名和/或成员勾选，回到列表。 */
  const saveSceneAction = useCallback(async (id: string, name: string, memberNames: string[] | null): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const safeName = name.trim()
      let scenes: SkillTag[] | null = null
      if (safeName !== '') scenes = await api.saveScene({ id, name: safeName })
      if (memberNames !== null) scenes = await api.setSceneMembers(id, memberNames)
      if (scenes === null) return
      applyScenes(scenes)
      setEditingScene(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, applyScenes])

  const loadMarket = useCallback(async (): Promise<void> => {
    try {
      const next = await api.market()
      setMarketState({ status: 'ready', entries: next.entries })
    } catch (error) {
      setMarketState({ status: 'error', entries: [] })
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** Install one market skill, then refresh catalog + market. */
  const installMarket = useCallback(async (name: string): Promise<void> => {
    setInstalling(name)
    setLoadError(null)
    try {
      await api.importMarket(name)
      await Promise.all([load(), loadMarket()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setInstalling(null)
    }
  }, [api, load, loadMarket])

  /** Scan a GitHub repo for importable skills. */
  const discoverRepo = useCallback(async (): Promise<void> => {
    const value = repoInput.trim()
    if (value === '') return
    setRepoResult(null)
    setRepoSelected(new Set())
    setRepoDiscoverState({ status: 'scanning' })
    setLoadError(null)
    try {
      const data = await api.repoDiscover(value)
      setRepoDiscoverState({ status: 'ready', data })
    } catch (error) {
      setRepoDiscoverState({ status: 'error', message: errorMessage(error) })
    }
  }, [api, repoInput])

  /** Toggle one repo preview row. */
  const toggleRepoSelected = useCallback((path: string, checked: boolean): void => {
    setRepoSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  /** Import every checked, non-existing repo skill, then refresh the hub. */
  const importRepo = useCallback(async (): Promise<void> => {
    if (repoDiscoverState.status !== 'ready') return
    setRepoImporting(true)
    setRepoResult(null)
    setLoadError(null)
    try {
      const result = await api.repoImport(repoDiscoverState.data.repo, [...repoSelected])
      setRepoResult(result)
      await Promise.all([load(), loadMarket(), loadGroups()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setRepoImporting(false)
    }
  }, [api, repoDiscoverState, repoSelected, load, loadGroups, loadMarket])

  const create = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setFormBusy(true)
    setFormMessage(null)
    try {
      const result = await api.create({ name: formName, description: formDesc, root: formRoot })
      setFormMessage({ kind: 'success', text: tt('form.success') + result.path })
      setFormName('')
      setFormDesc('')
      setShowForm(false)
      await load()
    } catch (error) {
      setFormMessage({ kind: 'error', text: tt('form.error') + errorMessage(error) })
    } finally {
      setFormBusy(false)
    }
  }, [api, formName, formDesc, formRoot, load])

  const normalized = search.trim().toLocaleLowerCase()
  const filtered = useMemo(() => (catalog?.skills ?? []).filter((skill) =>
    normalized.length === 0 || skill.name.toLocaleLowerCase().includes(normalized) || skill.description.toLocaleLowerCase().includes(normalized),
  ), [catalog, normalized])
  const renderRow = (skill: CatalogSkill): React.JSX.Element => {
    const stat = uses.get(skill.name)
    const count = stat?.count ?? 0
    const lastUsed = stat?.lastUsed
    return (
      <div key={skill.name} className={css.row} onClick={() => { void openDetail(skill.name) }}>
        <div className={css.rowMain}>
          <div className={css.rowName}>
            <span className={css.rowNameText}>{skill.name}</span>
            {count > 0 && hubConfig?.showUseCount !== false ? <span className={css.useCount}>{count}</span> : null}
            {skill.invocation.modelInvocable ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} title={tt('legend.model')} /> : null}
            {skill.invocation.userInvocable ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} title={tt('legend.user')} /> : null}
            {lastUsed !== undefined && hubConfig?.showUseTime !== false ? <span className={css.useTime}>{relativeTimeText(lastUsed)}</span> : null}
          </div>
          <div className={css.rowDesc}>{skill.description}</div>
        </div>
        {hubConfig?.showSourceColumn !== false ? <span className={css.rowSource}>{sourceBadgeLabel(skill.source)}</span> : null}
        {skill.writable
          ? <button
              type='button'
              role='switch'
              aria-checked={true}
              aria-label={tt('row.disable')}
              className={css.switch + ' ' + css.switchOn}
              disabled={busyNames.has(skill.name)}
              onClick={(event) => { event.stopPropagation(); void toggle(skill, false) }}
            ><span className={css.switchThumb} /></button>
          : <span className={css.badge + ' ' + css.badgeReadonly}>{tt('row.readonly')}</span>}
      </div>
    )
  }

  /** 一组技能名的调用次数汇总（组头显示）。 */
  const sumUses = (names: readonly string[]): number => {
    let total = 0
    for (const name of names) total += uses.get(name)?.count ?? 0
    return total
  }

  /** 一组技能名中最新的调用时间（组头显示）。 */
  const sumLastUsed = (names: readonly string[]): number | undefined => {
    let latest: number | undefined
    for (const name of names) {
      const last = uses.get(name)?.lastUsed
      if (last !== undefined && (latest === undefined || last > latest)) latest = last
    }
    return latest
  }

  if (detail !== null) {
    return (
      <div className={css.panel}>
        <div className={css.detailHead}>
          <button type='button' className={css.back} onClick={() => { setDetail(null) }}>{tt('detail.back')}</button>
          <span className={css.detailName}>
            {detail.name}
            {detail.invocation.modelInvocable ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} title={tt('legend.model')} /> : null}
            {detail.invocation.userInvocable ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} title={tt('legend.user')} /> : null}
          </span>
        </div>
        <div className={css.detailMeta}>
          <div className={css.detailMetaLine}>{tt('detail.provider')}: {detail.provider}</div>
          <div className={css.detailMetaLine}>{tt('detail.source')}: {detail.source}</div>
          {detail.path !== undefined ? <div className={css.detailMetaLine}>{tt('detail.path')}: {detail.path}</div> : null}
          {detail.sets !== undefined && detail.sets.length > 0 ? <div className={css.detailMetaLine}>{tt('detail.sets')}: {detail.sets.join(', ')}</div> : null}
          {detail.whenToUse !== undefined ? <div className={css.detailMetaLine}>{tt('detail.whenToUse')}: {detail.whenToUse}</div> : null}
          {(() => {
            const stat = uses.get(detail.name)
            if (stat === undefined || stat.count === 0) return null
            const at = stat.lastUsed !== undefined ? ' · ' + new Date(stat.lastUsed).toLocaleString() : ''
            return <div className={css.detailMetaLine}>{tt('detail.uses')}: {stat.count}{at}</div>
          })()}
          {(() => {
            const tags = (groupsState?.tags ?? []).filter((tag) => tag.skillNames.includes(detail.name)).map((tag) => tag.name)
            const cols = (groupsState?.collections ?? []).filter((c) => c.skillNames.includes(detail.name)).map((c) => c.name)
            const all = [...tags, ...cols]
            return all.length > 0 ? <div className={css.detailMetaLine}>{tt('detail.groups')}: {all.join(', ')}</div> : null
          })()}
          <div className={css.formRow} style={{ marginTop: 4 }}>
            <label className={css.formLabel}>{tt('detail.origin')}: {groupsState?.origins[detail.name] ?? '—'}</label>
            <div className={css.buttons}>
              <input
                className={css.input}
                value={originDraft}
                onChange={(event) => { setOriginDraft(event.target.value) }}
                placeholder={tt('detail.originPlaceholder')}
              />
              <button type='button' className={css.opBtn} disabled={tagBusy || originDraft.trim() === ''} onClick={() => { void saveOrigin(detail.name, originDraft) }}>{tt('detail.originSave')}</button>
              <button type='button' className={css.opBtn} disabled={tagBusy || groupsState?.origins[detail.name] === undefined} onClick={() => { void saveOrigin(detail.name, '') }}>{tt('detail.originClear')}</button>
            </div>
          </div>
        </div>
        {detailLoading ? <div className={css.muted}>{tt('detail.loading')}</div> : null}
        <pre className={css.detailContent}>{detail.content}</pre>
      </div>
    )
  }

  if (editingTag !== null) {
    const toggleMember = (name: string, checked: boolean): void => {
      setMembersDraft((previous) => {
        const next = new Set(previous)
        if (checked) next.add(name)
        else next.delete(name)
        return next
      })
    }
    const editQuery = editSearch.trim().toLocaleLowerCase()
    const editSkills = (catalog?.skills ?? []).filter((skill) => editQuery.length === 0 || skill.name.toLocaleLowerCase().includes(editQuery) || skill.description.toLocaleLowerCase().includes(editQuery))
    const editDisabled = (catalog?.disabled ?? []).filter((record) => editQuery.length === 0 || record.name.toLocaleLowerCase().includes(editQuery) || record.description.toLocaleLowerCase().includes(editQuery))
    return (
      <div className={css.panel}>
        <div className={css.detailHead}>
          <button type='button' className={css.back} onClick={() => { setEditingTag(null) }}>{tt('detail.back')}</button>
          <input
            className={css.input}
            style={{ flex: 1 }}
            value={editName}
            onChange={(event) => { setEditName(event.target.value) }}
            placeholder={tt('groups.namePlaceholder')}
          />
          <button type='button' className={css.opBtn} disabled={tagBusy || editName.trim() === ''} onClick={() => { void saveTag(editingTag.id, editName, null) }}>{tt('groups.rename')}</button>
          <button type='button' className={css.opBtn} disabled={tagBusy} onClick={() => { void deleteTag(editingTag.id) }}>{tt('groups.delete')}</button>
        </div>
        <p className={css.muted} style={{ margin: 0, fontSize: 11.5 }}>{tt('groups.membersHint')}</p>
        <input className={css.search} value={editSearch} onChange={(event) => { setEditSearch(event.target.value) }} placeholder={tt('panel.search')} />
        <div className={css.section}>
          {editSkills.map((skill) => (
            <label key={skill.name} className={css.row} style={{ cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={membersDraft.has(skill.name)}
                onChange={(event) => { toggleMember(skill.name, event.target.checked) }}
              />
              <div className={css.rowMain}>
                <div className={css.rowName}>{skill.name}</div>
                <div className={css.rowDesc}>{skill.description}</div>
              </div>
            </label>
          ))}
          {editDisabled.map((record) => (
            <label key={record.name} className={css.row} style={{ cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={membersDraft.has(record.name)}
                onChange={(event) => { toggleMember(record.name, event.target.checked) }}
              />
              <div className={css.rowMain}>
                <div className={css.rowName}>{record.name}</div>
                <div className={css.rowDesc}>{record.description} · {tt('panel.disabled')}</div>
              </div>
            </label>
          ))}
        </div>
        <div className={css.buttons}>
          <button type='button' className={css.button + ' ' + css.primary} disabled={tagBusy} onClick={() => { void saveTag(editingTag.id, editName, [...membersDraft]) }}>{tt('groups.saveMembers')}</button>
        </div>
      </div>
    )
  }

  if (editingScene !== null) {
    const toggleMember = (name: string, checked: boolean): void => {
      setMembersDraft((previous) => {
        const next = new Set(previous)
        if (checked) next.add(name)
        else next.delete(name)
        return next
      })
    }
    const editQuery = editSearch.trim().toLocaleLowerCase()
    const editSkills = (catalog?.skills ?? []).filter((skill) => editQuery.length === 0 || skill.name.toLocaleLowerCase().includes(editQuery) || skill.description.toLocaleLowerCase().includes(editQuery))
    const editDisabled = (catalog?.disabled ?? []).filter((record) => editQuery.length === 0 || record.name.toLocaleLowerCase().includes(editQuery) || record.description.toLocaleLowerCase().includes(editQuery))
    return (
      <div className={css.panel}>
        <div className={css.detailHead}>
          <button type='button' className={css.back} onClick={() => { setEditingScene(null) }}>{tt('detail.back')}</button>
          <input
            className={css.input}
            style={{ flex: 1 }}
            value={editName}
            onChange={(event) => { setEditName(event.target.value) }}
            placeholder={tt('groups.scenePlaceholder')}
          />
          <button type='button' className={css.opBtn} disabled={tagBusy || editName.trim() === ''} onClick={() => { void saveSceneAction(editingScene.id, editName, null) }}>{tt('groups.sceneEdit')}</button>
          <button type='button' className={css.opBtn} disabled={tagBusy} onClick={() => { void deleteSceneAction(editingScene.id) }}>{tt('groups.sceneDelete')}</button>
        </div>
        <p className={css.muted} style={{ margin: 0, fontSize: 11.5 }}>{tt('groups.sceneMembersHint')}</p>
        <input className={css.search} value={editSearch} onChange={(event) => { setEditSearch(event.target.value) }} placeholder={tt('panel.search')} />
        <div className={css.section}>
          {editSkills.map((skill) => (
            <label key={skill.name} className={css.row} style={{ cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={membersDraft.has(skill.name)}
                onChange={(event) => { toggleMember(skill.name, event.target.checked) }}
              />
              <div className={css.rowMain}>
                <div className={css.rowName}>{skill.name}</div>
                <div className={css.rowDesc}>{skill.description}</div>
              </div>
            </label>
          ))}
          {editDisabled.map((record) => (
            <label key={record.name} className={css.row} style={{ cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={membersDraft.has(record.name)}
                onChange={(event) => { toggleMember(record.name, event.target.checked) }}
              />
              <div className={css.rowMain}>
                <div className={css.rowName}>{record.name}</div>
                <div className={css.rowDesc}>{record.description} · {tt('panel.disabled')}</div>
              </div>
            </label>
          ))}
        </div>
        <div className={css.buttons}>
          <button type='button' className={css.button + ' ' + css.primary} disabled={tagBusy} onClick={() => { void saveSceneAction(editingScene.id, editName, [...membersDraft]) }}>{tt('groups.sceneSaveMembers')}</button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <h2 className={css.title}>{tt('panel.title')}</h2>
        {catalog !== null
          ? <span className={css.headerCount}>
              {tt('panel.count', { count: catalog.skills.length + catalog.disabled.length })}
              {catalog.disabled.length > 0 ? ' · ' + tt('panel.disabledCount', { count: catalog.disabled.length }) : null}
            </span>
          : null}
        {catalog !== null && !catalog.complete ? <span className={css.hint}>{tt('panel.incomplete')}</span> : null}
        <span className={css.actions}>
          <button type='button' className={css.button} disabled={updateState.status === 'checking'} onClick={() => { void checkUpdate() }}>{updateState.status === 'checking' ? tt('update.checking') : tt('update.check')}</button>
          <button type='button' className={css.button} onClick={() => { void load() }}>{tt('panel.refresh')}</button>
          <button type='button' className={css.button + ' ' + css.primary} onClick={() => { setShowForm((value) => !value) }}>{tt('panel.new')}</button>
        </span>
      </div>
      <div className={css.subbar}>
        <span className={css.segmented}>
          <button type='button' className={css.segBtn + (tab === 'skills' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('skills'); void loadGroups() }}>{tt('view.skills')}</button>
          <button type='button' className={css.segBtn + (tab === 'scenes' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('scenes'); void loadGroups() }}>{tt('view.scenes')}</button>
          <button type='button' className={css.segBtn + (tab === 'market' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('market'); void loadMarket() }}>{tt('view.market')}</button>
        </span>
        <button type='button' className={css.legendToggle + (showLegend ? ' ' + css.legendToggleActive : '')} onClick={() => { setShowLegend((value) => !value) }} title={tt('legend.hint')}>?</button>
      </div>

      {showForm ? (
        <form className={css.form} onSubmit={(event) => { void create(event) }}>
          <p className={css.muted} style={{ margin: 0, fontSize: 11.5 }}>{tt('form.capabilityHint')}</p>
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

      {updateState.status === 'ready' ? (() => {
        const data = updateState.data
        if (data.updateAvailable) {
          return (
            <div className={css.updateBanner + ' ' + css.updateBannerAvailable}>
              <span>{tt('update.available', { version: data.latestVersion ?? '', current: data.currentVersion })}</span>
              {data.url !== null ? <a className={css.updateLink} href={data.url} target='_blank' rel='noreferrer'>{tt('update.viewRelease')}</a> : null}
            </div>
          )
        }
        if (data.error !== undefined) {
          return <div className={css.updateBanner}>{tt('update.error', { error: data.error })}</div>
        }
        if (data.latestVersion === null) {
          return <div className={css.updateBanner}>{tt('update.unavailable')}</div>
        }
        return <div className={css.updateBanner}>{tt('update.upToDate', { version: data.latestVersion })}</div>
      })() : null}

      {updateState.status === 'error' ? (
        <div className={css.updateBanner}>{tt('update.error', { error: updateState.message })}</div>
      ) : null}

      {showLegend ? (
        <div className={css.legend}>
          <span className={css.legendItem}><span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} />{tt('legend.model')}</span>
          <span className={css.legendItem}><span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} />{tt('legend.user')}</span>
          <span className={css.legendHint}>{tt('legend.hint')}</span>
        </div>
      ) : null}

      <input className={css.search} value={search} onChange={(event) => { setSearch(event.target.value) }} placeholder={tt('panel.search')} />

      {loading ? <div className={css.empty}>{tt('panel.loading')}</div> : null}

      {tab === 'market' ? (
        <>
          <section className={css.section}>
            <p className={css.muted} style={{ margin: '4px 0', fontSize: 11.5 }}>{tt('repo.hint')}</p>
            <div className={css.buttons}>
              <input
                className={css.input}
                style={{ flex: 1 }}
                value={repoInput}
                onChange={(event) => { setRepoInput(event.target.value) }}
                placeholder={tt('repo.inputPlaceholder')}
              />
              <button type='button' className={css.button + ' ' + css.primary} disabled={repoDiscoverState.status === 'scanning' || repoInput.trim() === ''} onClick={() => { void discoverRepo() }}>{repoDiscoverState.status === 'scanning' ? tt('repo.scanning') : tt('repo.scan')}</button>
            </div>
            {repoDiscoverState.status === 'scanning' ? <div className={css.empty}>{tt('repo.scanning')}</div> : null}
            {repoDiscoverState.status === 'error' ? <div className={css.errorBanner}>{repoDiscoverState.message}</div> : null}
            {repoDiscoverState.status === 'ready' ? (() => {
              const entries = repoDiscoverState.data.entries
              const selected = entries.filter((entry) => repoSelected.has(entry.path) && !entry.existing)
              return (
                <>
                  <p className={css.muted} style={{ margin: '4px 0', fontSize: 11.5 }}>{tt('repo.ready', { count: entries.length })}</p>
                  {entries.length === 0 ? <div className={css.empty}>{tt('repo.empty')}</div> : (
                    <>
                      <div className={css.buttons} style={{ marginBottom: 8 }}>
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
                              <label key={entry.path} className={css.row} style={{ cursor: entry.existing ? 'default' : 'pointer', opacity: entry.existing ? 0.55 : 1 }}>
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
            {repoResult !== null ? <div className={css.formSuccess} style={{ marginTop: 8 }}>{tt('repo.imported', { count: repoResult.imported.length })} · {tt('repo.skippedExisting', { count: repoResult.skipped.length })} · {tt('repo.failed', { count: repoResult.failed.length })}</div> : null}
          </section>
          <section className={css.section}>
            <p className={css.muted} style={{ margin: '4px 0', fontSize: 11.5 }}>{tt('market.hint')}</p>
          {marketState.status === 'loading' ? <div className={css.empty}>{tt('market.loading')}</div> : null}
          {marketState.status === 'error' ? <div className={css.errorBanner}>{tt('market.error')}</div> : null}
          {marketState.entries.filter((entry) => normalized.length === 0 || entry.name.toLocaleLowerCase().includes(normalized) || entry.description.toLocaleLowerCase().includes(normalized)).map((entry) => (
            <div key={entry.name} className={css.row}>
              <div className={css.rowMain}>
                <div className={css.rowName}>{entry.name}</div>
                <div className={css.rowDesc}>{entry.description}</div>
                <div className={css.rowDesc}>{tt('market.source')}: {entry.repo}</div>
              </div>
              <button
                type='button'
                className={css.button + (entry.installed ? '' : ' ' + css.primary)}
                disabled={entry.installed || installing !== null}
                onClick={() => { void installMarket(entry.name) }}
              >{entry.installed ? tt('market.installed') : tt('market.install')}</button>
            </div>
          ))}
          </section>
        </>
      ) : tab === 'scenes' ? (
  catalog !== null ? (
    <>
          <div className={css.sectionTitle} style={{ marginTop: 10 }}>{tt('groups.scenes')}</div>
          <form className={css.form} onSubmit={(event) => { void createScene(event) }}>
            <div className={css.buttons}>
              <input
                className={css.input}
                style={{ flex: 1 }}
                value={newSceneName}
                onChange={(event) => { setNewSceneName(event.target.value) }}
                placeholder={tt('groups.scenePlaceholder')}
              />
              <button type='submit' className={css.button + ' ' + css.primary} disabled={tagBusy || newSceneName.trim() === ''}>{tt('groups.sceneNew')}</button>
            </div>
          </form>
          {groupsState !== null && groupsState.scenes.length === 0 ? <div className={css.empty}>{tt('groups.sceneEmpty')}</div> : null}
          {groupsState?.scenes.map((scene) => {
            const members = filterBySource(filtered, sourceFilter).filter((skill) => scene.skillNames.includes(skill.name))
            const disabledMembers = (catalog?.disabled ?? []).filter((record) => scene.skillNames.includes(record.name) && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized)))
            const collapsed = collapsedGroups.has('scn:' + scene.id)
            return (
              <section key={'scn:' + scene.id} className={css.section}>
                <div className={css.groupHead}>
                  <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('scn:' + scene.id) }}>
                    <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                    <span className={css.groupTitle}>
  {scene.name} · {scene.skillNames.length}
  {hubConfig?.showGroupSummary !== false && sumUses(scene.skillNames) > 0 ? <span className={css.useCount}>{sumUses(scene.skillNames)}</span> : null}
  {(() => { const lu = sumLastUsed(scene.skillNames); return hubConfig?.showGroupSummary !== false && lu !== undefined ? <span className={css.useTime} style={{ marginLeft: 6 }}>{relativeTimeText(lu)}</span> : null })()}
</span>
                  </button>
                  <span className={css.groupOps}>
                    <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggleNames(scene.skillNames, true) }}>{tt('panel.enableAll')}</button>
                    <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggle(members, false) }}>{tt('panel.disableAll')}</button>
                    <button type='button' className={css.opBtn} onClick={() => { setEditingScene(scene); setEditName(scene.name); setMembersDraft(new Set(scene.skillNames)); setEditSearch('') }}>{tt('groups.sceneEdit')}</button>
                  </span>
                </div>
                {!collapsed ? (
                  <>
                    {members.map(renderRow)}
                    {disabledMembers.map((record) => (
                      <div key={record.name} className={css.row}>
                        <div className={css.rowMain}>
                          <div className={css.rowName}>{record.name}</div>
                          <div className={css.rowDesc}>{record.description}</div>
                        </div>
                        <span className={css.badges}>
                          <span className={css.badge + ' ' + css.badgeSource}>{disabledSourceLabel(record.root)}</span>
                        </span>
                        <button type='button' role='switch' aria-checked={false} aria-label={tt('row.enable')} className={css.switch} disabled={busyNames.has(record.name)} onClick={() => { void enableDisabled(record) }}><span className={css.switchThumb} /></button>
                      </div>
                    ))}
                  </>
                ) : null}
              </section>
            )
          })}

    </>
  ) : null
) : catalog !== null ? (
        <>
          <div className={css.filterBar}>
            <label className={css.formLabel}>{tt('filter.source')}</label>
            <select className={css.select} value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value) }}>
              <option value='all'>{tt('filter.allSources')}</option>
              {[...new Set((catalog?.skills ?? []).map((skill) => skill.source))].sort().map((source) => (
                <option key={source} value={source}>{sourceBadgeLabel(source)}</option>
              ))}
            </select>
            <span className={css.segmented}>
              <button type='button' className={css.segBtn + (skillView === 'flat' ? ' ' + css.segBtnActive : '')} onClick={() => { setSkillView('flat') }}>{tt('view.flat')}</button>
              <button type='button' className={css.segBtn + (skillView === 'groups' ? ' ' + css.segBtnActive : '')} onClick={() => { setSkillView('groups') }}>{tt('view.grouped')}</button>
            </span>
          </div>

          {filtered.length === 0 && search.trim() !== '' ? <div className={css.empty}>{tt('panel.empty')}</div> : null}
          {filtered.length === 0 && search.trim() === '' && catalog.skills.length === 0 && catalog.disabled.length === 0 && catalog.diagnostics.length === 0
            ? <div className={css.empty}>{tt('panel.emptyAll')}</div>
            : null}

          {skillView === 'flat' ? (
            <>
              {filterBySource(filtered, sourceFilter).map(renderRow)}
            </>
          ) : (
            <>
          <form className={css.form} onSubmit={(event) => { void createTag(event) }}>
            <div className={css.buttons}>
              <input
                className={css.input}
                style={{ flex: 1 }}
                value={newTagName}
                onChange={(event) => { setNewTagName(event.target.value) }}
                placeholder={tt('groups.namePlaceholder')}
              />
              <button type='submit' className={css.button + ' ' + css.primary} disabled={tagBusy || newTagName.trim() === ''}>{tt('groups.new')}</button>
            </div>
          </form>

          {groupsState !== null && groupsState.tags.length === 0 ? <div className={css.empty}>{tt('groups.empty')}</div> : null}
          {groupsState?.tags.map((tag) => {
            const skills = filterBySource(filtered, sourceFilter).filter((skill) => tag.skillNames.includes(skill.name))
            const disabledMembers = (catalog?.disabled ?? []).filter((record) => tag.skillNames.includes(record.name) && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized)))
            const collapsed = collapsedGroups.has('tag:' + tag.id)
            return (
              <section key={tag.id} className={css.section}>
                <div className={css.groupHead}>
                  <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('tag:' + tag.id) }}>
                    <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                    <span className={css.groupTitle}>
  {tag.name} · {tag.skillNames.length}
  {hubConfig?.showGroupSummary !== false && sumUses(tag.skillNames) > 0 ? <span className={css.useCount}>{sumUses(tag.skillNames)}</span> : null}
  {(() => { const lu = sumLastUsed(tag.skillNames); return hubConfig?.showGroupSummary !== false && lu !== undefined ? <span className={css.useTime} style={{ marginLeft: 6 }}>{relativeTimeText(lu)}</span> : null })()}
</span>
                  </button>
                  <span className={css.groupOps}>
                    <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggleNames(tag.skillNames, true) }}>{tt('panel.enableAll')}</button>
                    <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggle(skills, false) }}>{tt('panel.disableAll')}</button>
                    <button type='button' className={css.opBtn} onClick={() => { setEditingTag(tag); setEditName(tag.name); setMembersDraft(new Set(tag.skillNames)) }}>{tt('groups.edit')}</button>
                  </span>
                </div>
                {!collapsed ? (
                  <>
                    {skills.map(renderRow)}
                    {disabledMembers.map((record) => (
                  <div key={record.name} className={css.row}>
                    <div className={css.rowMain}>
                      <div className={css.rowName}>{record.name}</div>
                      <div className={css.rowDesc}>{record.description}</div>
                    </div>
                    <span className={css.badges}>
                      <span className={css.badge + ' ' + css.badgeSource}>{disabledSourceLabel(record.root)}</span>
                    </span>
                    <button type='button' role='switch' aria-checked={false} aria-label={tt('row.enable')} className={css.switch} disabled={busyNames.has(record.name)} onClick={() => { void enableDisabled(record) }}><span className={css.switchThumb} /></button>
                  </div>
                    ))}
                  </>
                ) : null}
              </section>
            )
          })}

          {(() => {
            const unified = mergeCollections(filterBySource(filtered, sourceFilter), groupsState?.collections ?? [])
            if (unified.length === 0) return <div className={css.empty}>{tt('groups.noCollections')}</div>
            return (
              <>
                {unified.map((collection) => {
                  const members = filtered.filter((skill) => collection.skillNames.includes(skill.name))
                  const disabledMembers = (catalog?.disabled ?? []).filter((record) => collection.skillNames.includes(record.name) && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized)))
                  const collapsed = collapsedGroups.has('col:' + collection.name)
                  const kindLabel = collection.kind === 'both' ? tt('collection.badgeBoth') : collection.kind === 'collection' ? tt('collection.badgeSource') : tt('collection.badgeSets')
                  return (
                    <section key={'col:' + collection.name} className={css.section}>
                      <div className={css.groupHead}>
                        <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('col:' + collection.name) }}>
                          <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                          <span className={css.groupTitle}>
  {collection.name} · {collection.skillNames.length}
  {hubConfig?.showGroupSummary !== false && sumUses(collection.skillNames) > 0 ? <span className={css.useCount}>{sumUses(collection.skillNames)}</span> : null}
  {(() => { const lu = sumLastUsed(collection.skillNames); return hubConfig?.showGroupSummary !== false && lu !== undefined ? <span className={css.useTime} style={{ marginLeft: 6 }}>{relativeTimeText(lu)}</span> : null })()}
</span>
                        </button>
                        <span className={css.badge + ' ' + css.badgeSource}>{kindLabel}</span>
                        <span className={css.groupOps}>
                          <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggleNames(collection.skillNames, true) }}>{tt('panel.enableAll')}</button>
                          <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggle(members, false) }}>{tt('panel.disableAll')}</button>
                        </span>
                      </div>
                      {!collapsed ? (
                        <>
                          {members.map(renderRow)}
                          {disabledMembers.map((record) => (
                            <div key={record.name} className={css.row}>
                              <div className={css.rowMain}>
                                <div className={css.rowName}>{record.name}</div>
                                <div className={css.rowDesc}>{record.description}</div>
                              </div>
                              <span className={css.badges}>
                                <span className={css.badge + ' ' + css.badgeSource}>{disabledSourceLabel(record.root)}</span>
                              </span>
                              <button type='button' role='switch' aria-checked={false} aria-label={tt('row.enable')} className={css.switch} disabled={busyNames.has(record.name)} onClick={() => { void enableDisabled(record) }}><span className={css.switchThumb} /></button>
                            </div>
                          ))}
                        </>
                      ) : null}
                    </section>
                  )
                })}
              </>
            )
          })()}

          {(() => {
            const uncategorized = uncategorizedSkills(filtered, groupsState?.tags ?? [], groupsState?.origins ?? {})
            if (uncategorized.length === 0) return null
            const collapsed = collapsedGroups.has('uncategorized')
            return (
              <section className={css.section}>
                <div className={css.groupHead}>
                  <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('uncategorized') }}>
                    <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                    <span className={css.groupTitle}>
  {tt('groups.uncategorized')} · {uncategorized.length}
  {hubConfig?.showGroupSummary !== false && sumUses(uncategorized.map((skill) => skill.name)) > 0 ? <span className={css.useCount}>{sumUses(uncategorized.map((skill) => skill.name))}</span> : null}
  {(() => { const lu = sumLastUsed(uncategorized.map((skill) => skill.name)); return hubConfig?.showGroupSummary !== false && lu !== undefined ? <span className={css.useTime} style={{ marginLeft: 6 }}>{relativeTimeText(lu)}</span> : null })()}
</span>
                  </button>
                  <span className={css.groupOps}>
                    <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggle(uncategorized, true) }}>{tt('panel.enableAll')}</button>
                    <button type='button' className={css.opBtn} disabled={batchBusy} onClick={(event) => { event.stopPropagation(); void batchToggle(uncategorized, false) }}>{tt('panel.disableAll')}</button>
                  </span>
                </div>
                {!collapsed ? uncategorized.map(renderRow) : null}
              </section>
            )
          })()}

            </>
          )}
          {catalog.disabled.length > 0 ? (
            <section className={css.section}>
              <div className={css.sectionTitle}>{tt('panel.disabled')}</div>
              {catalog.disabled.map((record) => (
                <div key={record.name} className={css.row}>
                  <div className={css.rowMain}>
                    <div className={css.rowName}>{record.name}</div>
                    <div className={css.rowDesc}>{record.description}</div>
                  </div>
                  <span className={css.badges}>
                    <span className={css.badge + ' ' + css.badgeSource}>{disabledSourceLabel(record.root)}</span>
                  </span>
                  <button type='button' role='switch' aria-checked={false} aria-label={tt('row.enable')} className={css.switch} disabled={busyNames.has(record.name)} onClick={() => { void enableDisabled(record) }}><span className={css.switchThumb} /></button>
                </div>
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
    </div>
  )
}
