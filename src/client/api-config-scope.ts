/**
 * ApiConfigScope — a FormScope-compatible view over the hub's own config
 * route (/api/skill-hub/config). The host's settings service refuses to
 * expose third-party namespaces to the web client (dsh-host-apiproxy's
 * allowlist), so the settings card talks to this plugin-owned route instead
 * of the settings transport.
 *
 * The scope mirrors the settings-scope contract the vendored CardForm
 * consumes: `value` is the effective config, `base` the built-in defaults,
 * and `user` the raw saved overrides (a field's presence there marks it
 * overridden). Writes go straight through saveConfig and re-seed the
 * snapshot from the route's response, so the card's save-verification
 * (user layer equals the written value) sees the persisted state.
 */

import type { HubConfig } from '../protocol.ts'
import type { SkillHubApi } from './api.ts'
import type { FormScope } from './settings-form.ts'

/** Built-in defaults every field inherits until the user overrides it. */
const DEFAULTS: HubConfig = { enabled: true, announceToAgent: true }

/** Boolean config fields (color fields are strings). */
const BOOLEAN_FIELDS = new Set<keyof HubConfig>(['enabled', 'announceToAgent'])

/** Config fields the card edits (used to guard set/unset field names). */
const FIELDS = new Set<keyof HubConfig>(['enabled', 'announceToAgent', 'dotModelColor', 'dotUserColor'])

/** FormScope-compatible reactive config handle (see module doc). */
export class ApiConfigScope implements FormScope {
  private status: 'loading' | 'ready' | 'unavailable' = 'loading'
  private value: HubConfig = { ...DEFAULTS }
  private saved: Partial<HubConfig> = {}
  private readonly listeners = new Set<() => void>()

  /** @param api - the browser-half API client (shared with the skill panel). */
  constructor(private readonly api: SkillHubApi) {
    void this.load()
  }

  private async load(): Promise<void> {
    try {
      const response = await this.api.config()
      this.value = response.config
      this.saved = { ...response.saved }
      this.status = 'ready'
    } catch {
      // The route is missing or unreachable (e.g. host half not yet updated):
      // the card shows its not-exposed state instead of breaking the GUI.
      this.status = 'unavailable'
    }
    this.publish()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): { status: string; writable: boolean; value?: Record<string, unknown>; base?: unknown; user?: unknown } {
    return {
      status: this.status,
      writable: true,
      value: { ...this.value } as unknown as Record<string, unknown>,
      base: { ...DEFAULTS },
      user: { ...this.saved },
    }
  }

  /** Write one field through the config route and adopt the persisted state. */
  async set(field: string, value: unknown): Promise<void> {
    if (!FIELDS.has(field as keyof HubConfig)) return
    const patch = BOOLEAN_FIELDS.has(field as keyof HubConfig)
      ? { [field]: Boolean(value) }
      : { [field]: typeof value === 'string' ? value : undefined }
    await this.apply(patch as Partial<HubConfig>)
  }

  /** Clear one field's override so it re-inherits the default. */
  async unset(field: string): Promise<void> {
    if (!FIELDS.has(field as keyof HubConfig)) return
    await this.apply({ [field]: undefined } as Partial<HubConfig>)
  }

  /** Persist a patch, then re-seed from the route's fresh response. */
  private async apply(patch: Partial<HubConfig>): Promise<void> {
    // null on the wire clears a saved override (see ConfigRequest).
    const request: Record<string, boolean | string | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      request[key] = value === undefined ? null : value
    }
    const response = await this.api.saveConfig(request as never)
    this.value = response.config
    this.saved = { ...response.saved }
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
