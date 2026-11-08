/**
 * 从其他 agent 导入：列出 Claude Code / Codex / WorkBuddy / Cursor / Gemini CLI 等技能目录里的
 * 技能，勾选后复制到本地可写根。
 *
 * 只读扫描 + 复制，不改动别家目录。已存在的同名技能不可选（导入会覆盖，
 * 那是用户在别处没预期的事）。
 */

import { useEffect, useState } from 'react'
import type { ForeignSkillView } from '../../protocol.ts'
import type { SkillHubApi } from '../api.ts'
import { errorMessage, tt } from '../helpers.ts'
import { DialogShell } from './dialogs.tsx'
import css from './panel.module.css'

export interface ForeignImportDialogProps {
  api: SkillHubApi
  onClose: () => void
  /** 导入成功后回调，由面板负责刷新目录与提示（replaced = 被移入回收站的同名占位）。 */
  onImported: (imported: string[], replaced: number) => void
}

/** 一个技能在一组里的稳定键（同名技能可来自不同 agent、不同项目根）。 */
function keyOf(skill: { agent: string; name: string; scope: string; projectRoot?: string }): string {
  return skill.scope + '/' + skill.agent + '/' + skill.name + '/' + (skill.projectRoot ?? '')
}

/** 项目根的展示名（最后一段目录名；`/` 或 Windows 根则整条显示）。 */
function projectNameOf(root: string | undefined): string {
  if (root === undefined) return ''
  const segments = root.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? root
}

export function ForeignImportDialog(props: ForeignImportDialogProps): React.JSX.Element {
  const { api, onClose, onImported } = props
  const [skills, setSkills] = useState<ForeignSkillView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const result = await api.listForeignSkills()
        if (alive) setSkills(result.skills)
      } catch (caught) {
        if (alive) setError(errorMessage(caught))
      }
    })()
    return () => { alive = false }
  }, [api])

  const toggle = (skill: ForeignSkillView): void => {
    if (skill.existing || busy) return
    const next = new Set(selected)
    const key = keyOf(skill)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }

  const run = async (): Promise<void> => {
    if (selected.size === 0 || skills === null) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const items = skills
        .filter((skill) => selected.has(keyOf(skill)))
        .map((skill) => ({
          agent: skill.agent,
          name: skill.name,
          scope: skill.scope,
          ...(skill.projectRoot !== undefined ? { projectRoot: skill.projectRoot } : {}),
        }))
      const result = await api.importForeignSkills(items)
      const replaced = result.replaced?.length ?? 0
      const notices: string[] = []
      if (result.skipped.length > 0) notices.push(tt('foreign.skipped', { count: result.skipped.length }))
      for (const warning of result.warnings ?? []) {
        notices.push(tt('foreign.symlinkSkipped', { name: warning.name, count: warning.skippedSymlinks }))
      }
      if (result.failed.length > 0) {
        const failures = result.failed.map((failure) => failure.name + ': ' + failure.error).join('; ')
        setError(notices.length > 0 ? failures + ' · ' + notices.join(' · ') : failures)
      } else if (notices.length > 0) {
        setMessage(notices.join(' · '))
      }
      // 部分成功也要把成功的刷新出来，否则用户会以为一个都没进去。
      if (result.imported.length > 0) onImported(result.imported, replaced)
      // 完全干净的成功才关闭；有跳过/警告时留在对话框里让用户看到。
      if (result.failed.length === 0 && notices.length === 0) onClose()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell onClose={onClose}>
      <h3 className={css.dialogTitle}>{tt('foreign.title')}</h3>
      <p className={css.dialogText}>{tt('foreign.text')}</p>
      {skills === null && error === null ? <p className={css.dialogText}>{tt('panel.loading')}</p> : null}
      {skills !== null && skills.length === 0 ? <p className={css.dialogText}>{tt('foreign.empty')}</p> : null}
      {skills !== null && skills.length > 0 ? (
        <ul className={css.dialogList + ' ' + css.dialogListTall}>
          {skills.map((skill) => {
            const key = keyOf(skill)
            const disabled = skill.existing || busy
            return (
              <li key={key}>
                <label className={css.dialogOption + (disabled ? ' ' + css.dialogOptionDisabled : '')}>
                  <input
                    type='checkbox'
                    disabled={disabled}
                    checked={selected.has(key)}
                    onChange={() => { toggle(skill) }}
                  />
                  <span className={css.rowNameText}>{skill.name}</span>
                  <span className={css.statusBadge}>{skill.agent}</span>
                  <span className={css.statusBadge} title={skill.scope === 'project' ? skill.projectRoot : tt('foreign.scopeUserHint')}>
                    {skill.scope === 'project' ? tt('foreign.scopeProject', { name: projectNameOf(skill.projectRoot) }) : tt('foreign.scopeUser')}
                  </span>
                  {skill.existing ? <span className={css.statusBadge + ' ' + css.statusLocal}>{tt('foreign.exists')}</span> : null}
                </label>
                <div className={css.rowDesc} title={skill.description}>
                  {/* 名字行已有 agent / scope 两个徽标，再加会把技能名挤断行；「也在」放描述行。 */}
                  {skill.alsoIn !== undefined && skill.alsoIn.length > 0
                    ? <span className={css.statusBadge + ' ' + css.dialogAlsoIn} title={tt('foreign.alsoInHint')}>{tt('foreign.alsoIn', { agents: skill.alsoIn.join(' · ') })}</span>
                    : null}
                  {skill.description}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      {message !== null ? <p className={css.dialogText}>{message}</p> : null}
      {error !== null ? <p className={css.dialogText + ' ' + css.formErrorText}>{error}</p> : null}
      <div className={css.dialogActions}>
        <button type='button' className={css.button} onClick={onClose}>{tt('form.cancel')}</button>
        <button
          type='button'
          className={css.button + ' ' + css.primary}
          disabled={selected.size === 0 || busy}
          onClick={() => { void run() }}
        >
          {busy ? tt('foreign.importing') : tt('foreign.import', { count: selected.size })}
        </button>
      </div>
    </DialogShell>
  )
}
