/**
 * The skill hub panel: full catalog grouped by source, search, enable/
 * disable toggles, discovery diagnostics, disabled-skill re-enable, skill
 * body inspection, and the new-skill scaffold form.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { CatalogResponse, CatalogSkill, DisabledSkill, SkillDetail, WritableRoot } from '../../protocol.ts'
import type { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import css from './panel.module.css'

/** Source groups in display order; anything else lands in the other bucket. */
const SOURCE_GROUPS = ['project-dsh', 'project-agents', 'custom', 'runtime', 'user-dsh', 'user-agents', 'bundled'] as const

/** Known group keys; unknown sources use group.other. */
function groupKey(source: string): 'group.other' | 'group.project-dsh' | 'group.project-agents' | 'group.custom' | 'group.runtime' | 'group.user-dsh' | 'group.user-agents' | 'group.bundled' {
  const key = 'group.' + source
  return (SOURCE_GROUPS as readonly string[]).includes(source) ? key as 'group.user-dsh' : 'group.other'
}

export interface SkillHubPanelProps {
  api: SkillHubApi
}

/** Catalog poll interval while the panel is mounted (the provider watcher feeds this). */
const POLL_MS = 5000

export function SkillHubPanel(props: SkillHubPanelProps): React.JSX.Element {
  const { api } = props
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formRoot, setFormRoot] = useState<WritableRoot>('user-dsh')
  const [formBusy, setFormBusy] = useState(false)
  const [formMessage, setFormMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [uses, setUses] = useState<ReadonlyMap<string, number>>(new Map())

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
      if (result.available) setUses(new Map(result.stats.map((stat) => [stat.name, stat.count])))
    } catch {
      // Invocation counts are best-effort; a stats failure must not disturb the catalog.
    }
  }, [api])

  useEffect(() => {
    void load()
    void loadUses()
    const timer = window.setInterval(() => { void load(); void loadUses() }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [load, loadUses])

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
  const bySource = useMemo(() => {
    const map = new Map<string, CatalogSkill[]>()
    for (const skill of filtered) {
      const bucket = map.get(skill.source) ?? []
      bucket.push(skill)
      map.set(skill.source, bucket)
    }
    return map
  }, [filtered])

  const renderRow = (skill: CatalogSkill): React.JSX.Element => {
    const count = uses.get(skill.name)
    return (
      <div key={skill.name} className={css.row} onClick={() => { void openDetail(skill.name) }}>
        <div className={css.rowMain}>
          <div className={css.rowName}>{skill.name}</div>
          <div className={css.rowDesc}>{skill.description}</div>
        </div>
        <span className={css.badges}>
          {count !== undefined && count > 0 ? <span className={css.badge + ' ' + css.badgeUses}>{tt('badge.uses', { count })}</span> : null}
          {skill.invocation.modelInvocable ? <span className={css.badge + ' ' + css.badgeModel}>{tt('badge.model')}</span> : null}
          {skill.invocation.userInvocable ? <span className={css.badge + ' ' + css.badgeUser}>{tt('badge.user')}</span> : null}
        </span>
        {skill.writable
          ? <button
              type='button'
              className={css.switchBtn + ' ' + css.switchOn}
              disabled={busyNames.has(skill.name)}
              onClick={(event) => { event.stopPropagation(); void toggle(skill, false) }}
            >{tt('row.disable')}</button>
          : <span className={css.badge + ' ' + css.badgeReadonly}>{tt('row.readonly')}</span>}
      </div>
    )
  }

  if (detail !== null) {
    return (
      <div className={css.panel}>
        <div className={css.detailHead}>
          <button type='button' className={css.back} onClick={() => { setDetail(null) }}>{tt('detail.back')}</button>
          <span className={css.detailName}>{detail.name}</span>
          <span className={css.badges}>
            {detail.invocation.modelInvocable ? <span className={css.badge + ' ' + css.badgeModel}>{tt('badge.model')}</span> : null}
            {detail.invocation.userInvocable ? <span className={css.badge + ' ' + css.badgeUser}>{tt('badge.user')}</span> : null}
          </span>
        </div>
        <div className={css.detailMeta}>
          <div className={css.detailMetaLine}>{tt('detail.provider')}: {detail.provider}</div>
          <div className={css.detailMetaLine}>{tt('detail.source')}: {detail.source}</div>
          {detail.path !== undefined ? <div className={css.detailMetaLine}>{tt('detail.path')}: {detail.path}</div> : null}
        </div>
        {detailLoading ? <div className={css.muted}>{tt('detail.loading')}</div> : null}
        <pre className={css.detailContent}>{detail.content}</pre>
      </div>
    )
  }

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <h2 className={css.title}>{tt('panel.title')}</h2>
        {catalog !== null && !catalog.complete ? <span className={css.hint}>{tt('panel.incomplete')}</span> : null}
        <span className={css.actions}>
          <button type='button' className={css.button} onClick={() => { void load() }}>{tt('panel.refresh')}</button>
          <button type='button' className={css.button + ' ' + css.primary} onClick={() => { setShowForm((value) => !value) }}>{tt('panel.new')}</button>
        </span>
      </div>

      {showForm ? (
        <form className={css.form} onSubmit={(event) => { void create(event) }}>
          <div className={css.formRow}>
            <label className={css.formLabel}>{tt('form.name')}</label>
            <input className={css.input} value={formName} onChange={(event) => { setFormName(event.target.value) }} placeholder='code-review' />
          </div>
          <div className={css.formRow}>
            <label className={css.formLabel}>{tt('form.desc')}</label>
            <input className={css.input} value={formDesc} onChange={(event) => { setFormDesc(event.target.value) }} />
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

      <input className={css.search} value={search} onChange={(event) => { setSearch(event.target.value) }} placeholder={tt('panel.search')} />

      {loading ? <div className={css.empty}>{tt('panel.loading')}</div> : null}

      {catalog !== null && !loading ? (
        <>
          {filtered.length === 0 && search.trim() !== '' ? <div className={css.empty}>{tt('panel.empty')}</div> : null}
          {filtered.length === 0 && search.trim() === '' && catalog.disabled.length === 0 && catalog.diagnostics.length === 0
            ? <div className={css.empty}>{tt('panel.emptyAll')}</div>
            : null}

          {SOURCE_GROUPS.map((source) => {
            const skills = bySource.get(source)
            if (skills === undefined || skills.length === 0) return null
            return (
              <section key={source} className={css.section}>
                <div className={css.groupTitle}>{tt(groupKey(source))}</div>
                {skills.map(renderRow)}
              </section>
            )
          })}

          {(() => {
            const rest = filtered.filter((skill) => !(SOURCE_GROUPS as readonly string[]).includes(skill.source))
            if (rest.length === 0) return null
            return (
              <section className={css.section}>
                <div className={css.groupTitle}>{tt('group.other')}</div>
                {rest.map(renderRow)}
              </section>
            )
          })()}

          {catalog.disabled.length > 0 ? (
            <section className={css.section}>
              <div className={css.sectionTitle}>{tt('panel.disabled')}</div>
              {catalog.disabled.map((record) => (
                <div key={record.name} className={css.row}>
                  <div className={css.rowMain}>
                    <div className={css.rowName}>{record.name}</div>
                    <div className={css.rowDesc}>{record.description}</div>
                  </div>
                  <button
                    type='button'
                    className={css.switchBtn + ' ' + css.switchOff}
                    disabled={busyNames.has(record.name)}
                    onClick={() => { void enableDisabled(record) }}
                  >{tt('row.enable')}</button>
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

