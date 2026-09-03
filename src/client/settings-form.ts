/**
 * Settings-card form machinery, vendored from the dsh-web-ui family bucket
 * (packages/dsh-task-board/src/client/settings-form.ts) and re-typed. Stages
 * one card's edits over one settings namespace and writes them on save.
 *
 * The Host is the only authority on whether a value was accepted — its
 * validators own the constraints no schema can express — so the outcome is
 * read back from the section rather than predicted here. A save that did not
 * land keeps its drafts, so the user can correct them instead of retyping.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** One staged field: its draft text plus the clear/reset marker. */
interface StagedEdit {
  text: string
  clear: boolean
}

/** One editable field spec: formatting plus text parsing. */
export interface FieldSpec {
  field: string
  format: (value: unknown) => string
  parse: (text: string) => { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined
}

/** A boolean field, edited through true/false draft text. */
export function booleanField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/** A #rrggbb color field, edited through hex draft text. */
export function colorField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : ''),
    parse: (text) => {
      if (/^#[0-9a-f]{6}$/i.test(text)) return { kind: 'set', value: text }
      return undefined
    },
  }
}

/**
 * A numeric field with range clamping. Integer by default: a fractional draft
 * is truncated so "5.5 分钟" cannot sneak past an integer-only schema.
 */
export function numberField(field: string, options: { min?: number; max?: number; integer?: boolean } = {}): FieldSpec {
  const min = options.min ?? Number.NEGATIVE_INFINITY
  const max = options.max ?? Number.POSITIVE_INFINITY
  const integer = options.integer ?? true
  return {
    field,
    format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return undefined
      const parsed = integer ? Math.trunc(Number(trimmed)) : Number(trimmed)
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined
      return { kind: 'set', value: parsed }
    },
  }
}

/** Card-level state the chrome renders. */
export interface CardShell {
  available: boolean
  exposed: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

/** One field's state from the effective section and its staged draft. */
export interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

/** The settings scope face the form consumes (subset of SettingsScope<T>). */
export interface FormScope {
  subscribe(listener: () => void): () => void
  getSnapshot(): { status: string; writable: boolean; value?: Record<string, unknown>; base?: unknown; user?: unknown }
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** Stages one card's edits and writes them through the settings transport. */
export class CardForm {
  private readonly scope: FormScope
  private readonly specs = new Map<string, FieldSpec>()
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /** @param scope - the bound settings scope for this card's namespace. */
  constructor(scope: FormScope, specs: FieldSpec[]) {
    this.scope = scope
    for (const spec of specs) this.specs.set(spec.field, spec)
    scope.subscribe(() => { this.publish() })
  }

  /** Publish a projection of this form, rebuilt whenever the scope or a draft changes. */
  bind<T>(project: () => T) {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /** Read the card-level state: what the Host serves, and what a save would do. */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status !== 'loading',
      exposed: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** Read one field's state from the effective section and its staged draft. */
  field(field: string): FieldState {
    const spec = this.specOf(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  /** The actions the card's slot registration injects. */
  actions() {
    return {
      edit: (field: string, text: string) => { this.stage(field, { text, clear: false }) },
      resetField: (field: string) => {
        this.stage(field, { text: this.specOf(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap((item) => (item.run === undefined ? [] : [item.run]))
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) landed = (await write()) && landed
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /** Every staged edit a save would write, in staging order. */
  plan(): Array<{ field: string; run: (() => Promise<boolean>) | undefined }> {
    const plan: Array<{ field: string; run: (() => Promise<boolean>) | undefined }> = []
    for (const [field, staged] of this.staged) {
      const spec = this.specOf(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userRecord()?.[field] === value
  }

  private userRecord(): Record<string, unknown> | undefined {
    const user = this.scope.getSnapshot().user
    return typeof user === 'object' && user !== null ? user as Record<string, unknown> : undefined
  }

  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private specOf(field: string): FieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error('settings card has no field ' + field)
    return spec
  }

  private sectionValue(field: string): unknown {
    return this.scope.getSnapshot().value?.[field]
  }

  private baseValue(field: string): unknown {
    const base = this.scope.getSnapshot().base
    return typeof base === 'object' && base !== null ? (base as Record<string, unknown>)[field] : undefined
  }

  private stored(field: string): boolean {
    const user = this.userRecord()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

