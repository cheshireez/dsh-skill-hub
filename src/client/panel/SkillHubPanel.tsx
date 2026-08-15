/**
 * The skill hub panel: catalog grouped by tags + source collections, search
 * and filter in one row, per-group tri-state switches with conflict dialogs,
 * upstream source tracking (check / sync / follow upstream deletion into a
 * restorable trash), codex-style market sources, disabled re-enable,
 * detail inspection, and the new-skill scaffold form.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  CatalogResponse,
  CatalogSkill,
  DisabledSkill,
  GroupsResponse,
  HubConfig,
  RepoDiscoverResponse,
  RepoImportResponse,
  SkillDetail,
  SkillTag,
  SourceCheckResult,
  SourcesResponse,
  UpdateCheckResponse,
  WritableRoot,
} from '../../protocol.ts'
import { IconSkillOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import { conflictsOnClose, filterBySource, formatRelativeTime, groupNamesOf, groupSwitchView, uncategorizedSkills, type GroupSwitchState } from '../grouping.ts'
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

/** Short form of a commit SHA for display. */
function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
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

/** Repo scanner/import state (drives the market source preview). */
type RepoDiscoverState =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'ready'; data: RepoDiscoverResponse }
  | { status: 'error'; message: string }

/** Market sources list state. */
type MarketState = { status: 'loading' | 'ready' | 'error'; repos: string[] }

/** A group-close conflict waiting for the user's decision. */
interface ConflictDialogState {
  /** Group key: 'tag:<id>' or 'col:<name>'. */
  key: string
  name: string
  /** Conflicting skill names (enabled here and in other groups). */
  conflicts: string[]
}

/** A destructive/sync confirmation waiting for the user's decision. */
interface ConfirmDialogState {
  kind: 'sync' | 'delete'
  repo: string
  /** Skills the action applies to. */
  skills: string[]
}

export function SkillHubPanel(props: SkillHubPanelProps): React.JSX.Element {
  const { api } = props
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
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
  const [tab, setTab] = useState<'skills' | 'market'>('skills')
  const [skillView, setSkillView] = useState<'flat' | 'groups'>('flat')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [marketState, setMarketState] = useState<MarketState>({ status: 'loading', repos: [] })
  const [newSourceName, setNewSourceName] = useState('')
  const [groupsState, setGroupsState] = useState<GroupsResponse | null>(null)
  const [sourcesState, setSourcesState] = useState<SourcesResponse | null>(null)
  const [sourceCheck, setSourceCheck] = useState<Readonly<Record<string, SourceCheckResult>>>({})
  const [checkingSource, setCheckingSource] = useState<string | null>(null)
  const [syncingSource, setSyncingSource] = useState<string | null>(null)
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [editingTag, setEditingTag] = useState<SkillTag | null>(null)
  const [editName, setEditName] = useState('')
  const [membersDraft, setMembersDraft] = useState<ReadonlySet<string>>(new Set())
  const [newTagName, setNewTagName] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [editSearch, setEditSearch] = useState('')
  /** 分组视图里收起的分组（key 为 tag:<id> 或 col:<name>）。 */
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

  /** 加载用户 tag 分组 + 系统集合组 + origin 映射。 */
  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      setGroupsState(await api.groups())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 加载来源记录 + 回收站。 */
  const loadSources = useCallback(async (): Promise<void> => {
    try {
      setSourcesState(await api.sources())
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 加载市场源列表。 */
  const loadMarket = useCallback(async (): Promise<void> => {
    try {
      const next = await api.market()
      setMarketState({ status: 'ready', repos: next.repos })
    } catch (error) {
      setMarketState({ status: 'error', repos: [] })
      setLoadError(errorMessage(error))
    }
  }, [api])

  /** 把最新的 tag 列表合并进 groups 状态（tags 以外的字段保持原样）。 */
  const applyTags = useCallback((tags: SkillTag[]): void => {
    setGroupsState((previous) => previous === null
      ? { ok: true, tags, collections: [], origins: {} }
      : { ...previous, tags })
  }, [])

  useEffect(() => {
    void load()
    void loadUses()
    void loadGroups()
    void loadSources()
    void loadConfig()
    void checkUpdate()
    const timer = window.setInterval(() => { void load(); void loadUses(); void loadGroups(); void loadSources(); void loadConfig() }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [load, loadUses, loadGroups, loadSources, loadConfig, checkUpdate])

  /** Auto-check all sources once on mount (throttled server-side). */
  useEffect(() => {
    if (sourcesState === null || sourcesState.sources.length === 0) return
    void checkSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesState !== null && (sourcesState.sources.length > 0)])

  const openDetail = useCallback(async (name: string): Promise<void> => {
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

  /** Toggle an explicit name set in one write (enables disabled members too). */
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

  // -------------------------------------------------------- group switches

  /** 所有分组：key → 成员名（tag 与来源集合）。 */
  const groupMap = useCallback((): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    for (const tag of groupsState?.tags ?? []) map.set('tag:' + tag.id, tag.skillNames)
    for (const collection of groupsState?.collections ?? []) map.set('col:' + collection.name, collection.skillNames)
    return map
  }, [groupsState])

  /** 当前启用且可写的技能名（组开关只作用于它们）。 */
  const actionNames = useMemo(() => new Set((catalog?.skills ?? []).filter((skill) => skill.writable).map((skill) => skill.name)), [catalog])

  /** 当前启用的全部技能名（含只读，用于派生开关状态）。 */
  const viewNames = useMemo(() => new Set((catalog?.skills ?? []).map((skill) => skill.name)), [catalog])

  /**
   * Toggle a whole group via its tri-state switch. Closing with members that
   * are enabled in other groups opens the conflict dialog instead.
   */
  const toggleGroup = useCallback((key: string, name: string, view: GroupSwitchState): void => {
    const members = groupMap().get(key) ?? []
    if (members.length === 0) return
    if (view === 'off') {
      void batchToggleNames(members, true)
      return
    }
    const others = [...groupMap().entries()].filter(([otherKey]) => otherKey !== key).map(([, memberNames]) => ({ members: memberNames }))
    const conflicts = conflictsOnClose(members, actionNames, others)
    if (conflicts.length > 0) {
      setConflictDialog({ key, name, conflicts })
    } else {
      void batchToggleNames(members.filter((member) => actionNames.has(member)), false)
    }
  }, [groupMap, actionNames, batchToggleNames])

  /** Resolve the open conflict dialog. */
  const resolveConflict = useCallback(async (closeAll: boolean): Promise<void> => {
    const dialog = conflictDialog
    if (dialog === null) return
    setConflictDialog(null)
    const members = groupMap().get(dialog.key) ?? []
    if (closeAll) {
      await batchToggleNames(members.filter((member) => actionNames.has(member)), false)
    } else {
      await batchToggleNames(
        members.filter((member) => actionNames.has(member) && !dialog.conflicts.includes(member)),
        false,
      )
    }
  }, [conflictDialog, groupMap, actionNames, batchToggleNames])

  /** Dismiss a confirm dialog and run the pending source action. */
  const runConfirmed = useCallback(async (): Promise<void> => {
    const dialog = confirmDialog
    if (dialog === null) return
    setConfirmDialog(null)
    if (dialog.kind === 'sync') {
      setSyncingSource(dialog.repo)
      setLoadError(null)
      try {
        const result = await api.syncSource(dialog.repo, dialog.skills)
        await Promise.all([load(), loadGroups(), loadSources()])
        if (result.failed.length > 0) {
          setLoadError('sync: ' + result.failed.map((failure) => failure.name + ': ' + failure.error).join('; '))
        }
      } catch (error) {
        setLoadError(errorMessage(error))
      } finally {
        setSyncingSource(null)
      }
    } else {
      setLoadError(null)
      try {
        await api.confirmDeleteSource(dialog.repo, dialog.skills)
        await Promise.all([load(), loadGroups(), loadSources()])
      } catch (error) {
        setLoadError(errorMessage(error))
      }
    }
  }, [confirmDialog, api, load, loadGroups, loadSources])

  // ---------------------------------------------------------- source ops

  /** 检查全部来源的上游更新（服务端 5 分钟节流）。 */
  const checkSources = useCallback(async (repo?: string): Promise<void> => {
    setCheckingSource(repo ?? 'all')
    setLoadError(null)
    try {
      const result = await api.checkSources(repo)
      const next: Record<string, SourceCheckResult> = { ...sourceCheck }
      for (const item of result.results) next[item.repo] = item
      setSourceCheck(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setCheckingSource(null)
    }
  }, [api, sourceCheck])

  /** 请求同步某个来源的所选技能（弹确认，因为会覆盖本地修改）。 */
  const requestSync = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'sync', repo, skills })
  }, [])

  /** 请求跟进上游删除（弹确认，移入回收站）。 */
  const requestDelete = useCallback((repo: string, skills: string[]): void => {
    setConfirmDialog({ kind: 'delete', repo, skills })
  }, [])

  /** 从回收站恢复一个技能。 */
  const restoreTrash = useCallback(async (name: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      await api.restoreSource(name)
      await Promise.all([load(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api, load, loadGroups, loadSources])

  // ----------------------------------------------------------- tag editing

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

  // -------------------------------------------------------------- market

  /** 添加一个市场源并立即扫描它。 */
  const addMarketSource = useCallback(async (): Promise<void> => {
    const value = newSourceName.trim()
    if (value === '') return
    setLoadError(null)
    try {
      const result = await api.addMarketSource(value)
      setMarketState({ status: 'ready', repos: result.repos })
      setNewSourceName('')
      setRepoResult(null)
      setRepoSelected(new Set())
      setRepoDiscoverState({ status: 'scanning' })
      try {
        const data = await api.repoDiscover(result.repos[result.repos.length - 1])
        setRepoDiscoverState({ status: 'ready', data })
      } catch (error) {
        setRepoDiscoverState({ status: 'error', message: errorMessage(error) })
      }
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api, newSourceName])

  /** 删除一个市场源（不影响已装技能）。 */
  const removeMarketSource = useCallback(async (repo: string): Promise<void> => {
    setTagBusy(true)
    setLoadError(null)
    try {
      const result = await api.removeMarketSource(repo)
      setMarketState({ status: 'ready', repos: result.repos })
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setTagBusy(false)
    }
  }, [api])

  /** 扫描一个市场源（或手动输入）的仓库。 */
  const scanRepo = useCallback(async (input: string): Promise<void> => {
    const value = input.trim()
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
  }, [api])

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
      await Promise.all([load(), loadMarket(), loadGroups(), loadSources()])
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setRepoImporting(false)
    }
  }, [api, repoDiscoverState, repoSelected, load, loadMarket, loadGroups, loadSources])

  // ---------------------------------------------------------------- create

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

  // ------------------------------------------------------------- rendering

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

  /** 组头通用：标题 + 汇总 + 三态开关。 */
  const groupSummary = (members: readonly string[]): React.JSX.Element => {
    const total = sumUses(members)
    const last = sumLastUsed(members)
    return (
      <span className={css.groupTitleInner}>
        {hubConfig?.showGroupSummary !== false && total > 0 ? <span className={css.useCount}>{total}</span> : null}
        {hubConfig?.showGroupSummary !== false && last !== undefined ? <span className={css.useTime} style={{ marginLeft: 6 }}>{relativeTimeText(last)}</span> : null}
      </span>
    )
  }

  /** 单个技能的来源状态（详情页用）。 */
  const sourceStatusBadge = (check: SourceCheckResult | undefined): React.JSX.Element | null => {
    if (check === undefined) return null
    if (check.error !== undefined) {
      return <span className={css.statusBadge + ' ' + css.statusError}>{tt('source.error')}</span>
    }
    if (check.throttled === true) {
      return <span className={css.statusBadge}>{tt('source.throttled')}</span>
    }
    if (check.changed) {
      return (
        <span className={css.statusBadges}>
          {check.updated.length > 0 ? <span className={css.statusBadge + ' ' + css.statusUpdated}>{tt('source.updated', { count: check.updated.length })}</span> : null}
          {check.deleted.length > 0 ? <span className={css.statusBadge + ' ' + css.statusError}>{tt('source.deleted', { count: check.deleted.length })}</span> : null}
        </span>
      )
    }
    return <span className={css.statusBadge + ' ' + css.statusOk}>{tt('source.upToDate')}</span>
  }

  // -------------------------------------------------------------- detail

  if (detail !== null) {
    const detailSource = sourcesState?.sources.find((source) => source.skills.includes(detail.name))
    const detailCheck = detailSource !== undefined ? sourceCheck[detailSource.repo] : undefined
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
              {sourceStatusBadge(detailCheck)}
            </div>
            <div className={css.detailMetaLine}>
              {tt('source.commit')}: {detailSource.commitSha === '' ? tt('source.unverified') : shortSha(detailSource.commitSha)}
            </div>
            <div className={css.buttons} style={{ marginTop: 8 }}>
              <button type='button' className={css.opBtn} disabled={checkingSource !== null} onClick={() => { void checkSources(detailSource.repo) }}>
                {checkingSource === detailSource.repo ? tt('source.checking') : tt('source.check')}
              </button>
              <button type='button' className={css.opBtn} disabled={syncingSource !== null} onClick={() => { requestSync(detailSource.repo, [detail.name]) }}>
                {syncingSource === detailSource.repo ? tt('source.syncing') : tt('source.sync')}
              </button>
              {detailCheck?.deleted.includes(detail.name) === true
                ? <button type='button' className={css.opBtn + ' ' + css.opDanger} onClick={() => { requestDelete(detailSource.repo, [detail.name]) }}>{tt('source.followDelete')}</button>
                : null}
            </div>
          </div>
        ) : (
          <p className={css.muted} style={{ margin: 0, fontSize: 12 }}>{tt('source.private')}</p>
        )}
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


  return (
    <div className={css.panel}>
      <div className={css.header}>
        <h2 className={css.title}><IconSkillOutline16 size={16} className={css.titleIcon} /> {tt('panel.title')}</h2>
        {catalog !== null
          ? <span className={css.headerCount}>
              {tt('panel.count', { count: catalog.skills.length + catalog.disabled.length })}
              {catalog.disabled.length > 0 ? ' · ' + tt('panel.disabledCount', { count: catalog.disabled.length }) : null}
            </span>
          : null}
        {catalog !== null && !catalog.complete ? <span className={css.hint}>{tt('panel.incomplete')}</span> : null}
        <span className={css.actions}>
          <button type='button' className={css.button} disabled={updateState.status === 'checking'} onClick={() => { void checkUpdate() }}>{updateState.status === 'checking' ? tt('update.checking') : tt('update.check')}</button>
        </span>
      </div>
      <div className={css.subbar}>
        <span className={css.segmented}>
          <button type='button' className={css.segBtn + (tab === 'skills' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('skills') }}>{tt('view.skills')}</button>
          <button type='button' className={css.segBtn + (tab === 'market' ? ' ' + css.segBtnActive : '')} onClick={() => { setTab('market'); void loadMarket() }}>{tt('view.market')}</button>
        </span>
        <button type='button' className={css.legendToggle + (showLegend ? ' ' + css.legendToggleActive : '')} onClick={() => { setShowLegend((value) => !value) }} title={tt('legend.hint')}>?</button>
        <span className={css.actions}>
          <button type='button' className={css.button} onClick={() => { void load() }}>{tt('panel.refresh')}</button>
          <button type='button' className={css.button + ' ' + css.primary} onClick={() => { setShowForm((value) => !value) }}>{tt('panel.new')}</button>
        </span>
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
        return null
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

      {loading ? <div className={css.empty}>{tt('panel.loading')}</div> : null}

      {tab === 'market' ? (
        <>
          <section className={css.section}>
            <p className={css.muted} style={{ margin: '6px 12px 2px', fontSize: 11.5 }}>{tt('market.addHint')}</p>
            <div className={css.buttons} style={{ padding: '8px 12px' }}>
              <input
                className={css.input}
                style={{ flex: 1 }}
                value={newSourceName}
                onChange={(event) => { setNewSourceName(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addMarketSource() } }}
                placeholder={tt('market.addPlaceholder')}
              />
              <button type='button' className={css.button + ' ' + css.primary} disabled={newSourceName.trim() === ''} onClick={() => { void addMarketSource() }}>{tt('market.addSource')}</button>
            </div>
          </section>
          <section className={css.section}>
            <div className={css.sectionTitle}>{tt('market.sources')}</div>
            {marketState.status === 'loading' ? <div className={css.empty}>{tt('panel.loading')}</div> : null}

            {marketState.status === 'ready' && marketState.repos.length === 0 ? <div className={css.empty}>{tt('market.noSources')}</div> : null}
            {marketState.repos.map((repo) => (
              <div key={repo} className={css.row + ' ' + css.rowStatic}>
                <div className={css.rowMain}>
                  <div className={css.rowName}>
                    <a className={css.sourceLink} href={'https://github.com/' + repo} target='_blank' rel='noreferrer'>{repo}</a>
                  </div>
                  <div className={css.rowDesc}>{tt('market.removeHint')}</div>
                </div>
                <button type='button' className={css.opBtn} disabled={repoDiscoverState.status === 'scanning'} onClick={() => { void scanRepo(repo) }}>
                  {repoDiscoverState.status === 'scanning' ? tt('market.scanning') : tt('market.scan')}
                </button>
                <button type='button' className={css.opBtn} disabled={tagBusy} onClick={() => { void removeMarketSource(repo) }}>{tt('market.deleteSource')}</button>
              </div>
            ))}
          </section>
          {repoDiscoverState.status === 'scanning' ? <div className={css.empty}>{tt('market.scanning')}</div> : null}
          {repoDiscoverState.status === 'error' ? <div className={css.errorBanner}>{repoDiscoverState.message}</div> : null}
          {repoDiscoverState.status === 'ready' ? (() => {
            const entries = repoDiscoverState.data.entries
            const selected = entries.filter((entry) => repoSelected.has(entry.path) && !entry.existing)
            return (
              <>
                <p className={css.muted} style={{ margin: '4px 2px', fontSize: 11.5 }}>{tt('repo.ready', { count: entries.length })}</p>
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
        </>
      ) : catalog !== null ? (
        <>
          <div className={css.filterBar}>
            <input className={css.search} value={search} onChange={(event) => { setSearch(event.target.value) }} placeholder={tt('panel.search')} />
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

          <div className={css.sectionTitle} style={{ marginTop: 10 }}>{tt('groups.tags')}</div>
          {groupsState !== null && groupsState.tags.length === 0 ? <div className={css.empty}>{tt('groups.empty')}</div> : null}
          {groupsState?.tags.map((tag) => {
            const skills = filterBySource(filtered, sourceFilter).filter((skill) => tag.skillNames.includes(skill.name))
            const disabledMembers = (catalog?.disabled ?? []).filter((record) => tag.skillNames.includes(record.name) && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized)))
            const collapsed = collapsedGroups.has('tag:' + tag.id)
            const view = groupSwitchView(tag.skillNames, viewNames)
            return (
              <section key={'tag:' + tag.id} className={css.section}>
                <div className={css.groupHead}>
                  <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('tag:' + tag.id) }}>
                    <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                    <span className={css.groupTitle}>
                      {tag.name} · {tag.skillNames.length}
                      {groupSummary(tag.skillNames)}
                    </span>
                  </button>
                  <span className={css.groupOps}>
                    <button type='button' role='switch' aria-checked={view.state !== 'off'} aria-label={tag.name}
                      className={css.switch + (view.state === 'on' ? ' ' + css.switchOn : view.state === 'mixed' ? ' ' + css.switchMixed : '')}
                      disabled={batchBusy || tag.skillNames.length === 0}
                      onClick={(event) => { event.stopPropagation(); toggleGroup('tag:' + tag.id, tag.name, view.state) }}>
                      <span className={css.switchThumb} />
                    </button>
                    <button type='button' className={css.opBtn} onClick={() => { setEditingTag(tag); setEditName(tag.name); setMembersDraft(new Set(tag.skillNames)); setEditSearch('') }}>{tt('groups.edit')}</button>
                  </span>
                </div>
                {!collapsed ? (
                  <>
                    {skills.map(renderRow)}
                    {disabledMembers.map((record) => (
                  <div key={record.name} className={css.row + ' ' + css.rowStatic}>
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

          <div className={css.sectionTitle} style={{ marginTop: 10 }}>{tt('groups.collections')}</div>
          {groupsState !== null && groupsState.collections.length === 0 ? <div className={css.empty}>{tt('groups.noCollections')}</div> : null}
          {groupsState?.collections.map((collection) => {
            const skills = filterBySource(filtered, sourceFilter).filter((skill) => collection.skillNames.includes(skill.name))
            const disabledMembers = (catalog?.disabled ?? []).filter((record) => collection.skillNames.includes(record.name) && (normalized.length === 0 || record.name.toLocaleLowerCase().includes(normalized) || record.description.toLocaleLowerCase().includes(normalized)))
            const collapsed = collapsedGroups.has('col:' + collection.name)
            const view = groupSwitchView(collection.skillNames, viewNames)
            const source = sourcesState?.sources.find((item) => item.repo === collection.name)
            const check = sourceCheck[collection.name]
            return (
              <section key={'col:' + collection.name} className={css.section}>
                <div className={css.groupHead}>
                  <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('col:' + collection.name) }}>
                    <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                    <span className={css.groupTitle}>
                      <a className={css.sourceLink} href={'https://github.com/' + collection.name} target='_blank' rel='noreferrer' onClick={(event) => { event.stopPropagation() }}>{collection.name}</a>
                      {' · ' + collection.skillNames.length}
                      {groupSummary(collection.skillNames)}
                    </span>
                  </button>
                  <span className={css.groupOps}>
                    {sourceStatusBadge(check)}
                    <button type='button' className={css.opBtn} disabled={checkingSource !== null} onClick={(event) => { event.stopPropagation(); void checkSources(collection.name) }}>
                      {checkingSource === collection.name ? tt('source.checking') : tt('source.check')}
                    </button>
                    {check !== undefined && check.changed && check.updated.length > 0
                      ? <button type='button' className={css.opBtn} disabled={syncingSource !== null} onClick={(event) => { event.stopPropagation(); requestSync(collection.name, check.updated) }}>
                          {syncingSource === collection.name ? tt('source.syncing') : tt('source.sync')}
                        </button>
                      : null}
                    {check !== undefined && check.deleted.length > 0
                      ? <button type='button' className={css.opBtn + ' ' + css.opDanger} onClick={(event) => { event.stopPropagation(); requestDelete(collection.name, check.deleted) }}>{tt('source.followDelete')}</button>
                      : null}
                    <button type='button' role='switch' aria-checked={view.state !== 'off'} aria-label={collection.name}
                      className={css.switch + (view.state === 'on' ? ' ' + css.switchOn : view.state === 'mixed' ? ' ' + css.switchMixed : '')}
                      disabled={batchBusy || collection.skillNames.length === 0}
                      onClick={(event) => { event.stopPropagation(); toggleGroup('col:' + collection.name, collection.name, view.state) }}>
                      <span className={css.switchThumb} />
                    </button>
                  </span>
                </div>
                {!collapsed ? (
                  <>
                    {skills.map(renderRow)}
                    {disabledMembers.map((record) => (
                      <div key={record.name} className={css.row + ' ' + css.rowStatic}>
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
            const uncategorized = uncategorizedSkills(filterBySource(filtered, sourceFilter), groupsState?.tags ?? [], groupsState?.origins ?? {})
            if (uncategorized.length === 0) return null
            const collapsed = collapsedGroups.has('uncategorized')
            return (
              <section className={css.section}>
                <div className={css.groupHead}>
                  <button type='button' className={css.disclosure} aria-expanded={!collapsed} onClick={() => { toggleGroupCollapse('uncategorized') }}>
                    <span className={css.chevron + (collapsed ? ' ' + css.chevronCollapsed : '')} />
                    <span className={css.groupTitle}>
                      {tt('groups.uncategorized')} · {uncategorized.length}
                      {groupSummary(uncategorized.map((skill) => skill.name))}
                    </span>
                  </button>
                </div>
                {!collapsed ? uncategorized.map(renderRow) : null}
              </section>
            )
          })()}

            </>
          )}

          {sourcesState !== null && sourcesState.trash.length > 0 ? (
            <section className={css.section}>
              <div className={css.sectionTitle}>{tt('source.trash')}</div>
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
              {catalog.disabled.map((record) => (
                <div key={record.name} className={css.row + ' ' + css.rowStatic}>
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

      {conflictDialog !== null ? (
        <div className={css.dialogOverlay} onClick={() => { setConflictDialog(null) }}>
          <div className={css.dialog} role='alertdialog' aria-modal='true' onClick={(event) => { event.stopPropagation() }}>
            <h3 className={css.dialogTitle}>{tt('groups.conflictTitle')}</h3>
            <p className={css.dialogText}>{tt('groups.conflictText')}</p>
            <ul className={css.dialogList}>
              {conflictDialog.conflicts.map((name) => (
                <li key={name}>
                  <span className={css.rowNameText}>{name}</span>
                  {' — ' + groupNamesOf(name, groupsState?.tags ?? [], groupsState?.collections ?? []).join('、')}
                </li>
              ))}
            </ul>
            <div className={css.dialogActions}>
              <button type='button' className={css.button} onClick={() => { void resolveConflict(false) }}>{tt('groups.keepOn')}</button>
              <button type='button' className={css.button + ' ' + css.primary} onClick={() => { void resolveConflict(true) }}>{tt('groups.closeAll')}</button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDialog !== null ? (
        <div className={css.dialogOverlay} onClick={() => { setConfirmDialog(null) }}>
          <div className={css.dialog} role='alertdialog' aria-modal='true' onClick={(event) => { event.stopPropagation() }}>
            <h3 className={css.dialogTitle}>{confirmDialog.kind === 'sync' ? tt('source.syncConfirmTitle') : tt('source.deleteConfirmTitle')}</h3>
            <p className={css.dialogText}>{confirmDialog.kind === 'sync' ? tt('source.syncConfirmText') : tt('source.deleteConfirmText')}</p>
            <ul className={css.dialogList}>
              {confirmDialog.skills.map((name) => <li key={name}><span className={css.rowNameText}>{name}</span></li>)}
            </ul>
            <div className={css.dialogActions}>
              <button type='button' className={css.button} onClick={() => { setConfirmDialog(null) }}>{tt('form.cancel')}</button>
              <button type='button' className={css.button + (confirmDialog.kind === 'delete' ? ' ' + css.primary : ' ' + css.primary)} onClick={() => { void runConfirmed() }}>
                {confirmDialog.kind === 'sync' ? tt('source.sync') : tt('source.followDelete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

