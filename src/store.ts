/**
 * Hub sidecar store: remembers which skills the hub toggled off. Disabling
 * renames the skill's SKILL.md (or flat .md) out of the filesystem provider's
 * discovery shapes, so the provider catalog alone cannot see disabled skills;
 * this store keeps name/path/root so the GUI can list them and re-enable.
 *
 * State file: $DSH_HOME/dsh-skill-hub.json — a small JSON document written
 * atomically (tmp file + rename).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DisabledSkill, HubConfig, SkillTag, WritableRoot } from './protocol.ts'

/** Wire shape persisted on disk. */
interface StoreFile {
  version: number
  disabled: DisabledSkill[]
  /** Runtime configuration edited from the web settings card (hub-owned, not settings-service). */
  config?: Partial<HubConfig>
  /** User-defined tag groups (pure organization; skill files untouched). */
  tags?: SkillTag[]
  /** User-defined scenes (dedicated to one-click enable/disable). */
  scenes?: SkillTag[]
  /** skillName → collection name (system aggregation source). */
  origins?: Record<string, string>
}

/** Resolve the DSH home directory (the filesystem provider's user-dsh root base). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Resolve the sidecar state path (injectable in tests). */
export function statePath(home = dshHome()): string {
  return join(home, 'dsh-skill-hub.json')
}

/** Current sidecar schema version. Bump on breaking shape changes and add a migration below. */
export const STORE_VERSION = 1

/**
 * Normalize an arbitrary parsed sidecar document to the current schema.
 * Only adds defaulted top-level fields and validates the version; element
 * validation stays in ensureLoaded (defensive on purpose). Returns null
 * when the file claims a newer schema than this plugin understands, so the
 * caller starts empty instead of risking data loss.
 */
function migrateStore(parsed: unknown): { version: number; disabled: unknown; config: unknown; tags?: unknown; scenes?: unknown; origins?: unknown } | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const version = typeof record.version === 'number' ? record.version : 0
  if (version > STORE_VERSION) return null
  // Future migrations go here, e.g. if (version < 2) { ...transform... } then version = 2
  return {
    version: STORE_VERSION,
    disabled: Array.isArray(record.disabled) ? record.disabled : [],
    config: typeof record.config === 'object' && record.config !== null && !Array.isArray(record.config) ? record.config : undefined,
    ...(Array.isArray(record.tags) ? { tags: record.tags } : {}),
    ...(Array.isArray(record.scenes) ? { scenes: record.scenes } : {}),
    ...(typeof record.origins === 'object' && record.origins !== null && !Array.isArray(record.origins) ? { origins: record.origins } : {}),
  }
}

/** Sidecar state owner. */
export class SkillHubStore {
  private entries = new Map<string, DisabledSkill>()
  private config: Partial<HubConfig> = {}
  private tagsById = new Map<string, SkillTag>()
  private scenesById = new Map<string, SkillTag>()
  private origins = new Map<string, string>()
  private loaded = false

  constructor(private readonly file: string = statePath()) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const migrated = migrateStore(parsed)
      if (migrated === null) {
        console.warn('[dsh-skill-hub] sidecar state uses a newer schema than this plugin supports; starting empty')
      } else {
        if (Array.isArray(migrated.disabled)) {
          for (const entry of migrated.disabled) {
            if (typeof entry?.name === 'string' && typeof entry?.path === 'string') {
              this.entries.set(entry.name, entry)
            }
          }
        }
        const saved = migrated.config as { enabled?: unknown; announceToAgent?: unknown; dotModelColor?: unknown; dotUserColor?: unknown; showUseCount?: unknown; showUseTime?: unknown; showSourceColumn?: unknown; showGroupSummary?: unknown } | undefined
        if (typeof saved === 'object' && saved !== null) {
          if (typeof saved.enabled === 'boolean') this.config.enabled = saved.enabled
          if (typeof saved.announceToAgent === 'boolean') this.config.announceToAgent = saved.announceToAgent
          if (typeof saved.dotModelColor === 'string' && saved.dotModelColor !== '') this.config.dotModelColor = saved.dotModelColor
          if (typeof saved.dotUserColor === 'string' && saved.dotUserColor !== '') this.config.dotUserColor = saved.dotUserColor
          if (typeof saved.showUseCount === 'boolean') this.config.showUseCount = saved.showUseCount
          if (typeof saved.showUseTime === 'boolean') this.config.showUseTime = saved.showUseTime
          if (typeof saved.showSourceColumn === 'boolean') this.config.showSourceColumn = saved.showSourceColumn
          if (typeof saved.showGroupSummary === 'boolean') this.config.showGroupSummary = saved.showGroupSummary
        }
        if (Array.isArray(migrated.tags)) {
          for (const entry of migrated.tags as unknown[]) {
            const tag = entry as { id?: unknown; name?: unknown; skillNames?: unknown } | null
            if (tag !== null && typeof tag === 'object' && typeof tag.id === 'string' && typeof tag.name === 'string' && Array.isArray(tag.skillNames)) {
              this.tagsById.set(tag.id, {
                id: tag.id,
                name: tag.name,
                skillNames: tag.skillNames.filter((n): n is string => typeof n === 'string'),
              })
            }
          }
        }
        if (Array.isArray(migrated.scenes)) {
          for (const entry of migrated.scenes as unknown[]) {
            const scene = entry as { id?: unknown; name?: unknown; skillNames?: unknown } | null
            if (scene !== null && typeof scene === 'object' && typeof scene.id === 'string' && typeof scene.name === 'string' && Array.isArray(scene.skillNames)) {
              this.scenesById.set(scene.id, {
                id: scene.id,
                name: scene.name,
                skillNames: scene.skillNames.filter((n): n is string => typeof n === 'string'),
              })
            }
          }
        }
        if (typeof migrated.origins === 'object' && migrated.origins !== null && !Array.isArray(migrated.origins)) {
          for (const [name, origin] of Object.entries(migrated.origins)) {
            if (typeof origin === 'string' && origin !== '') this.origins.set(name, origin)
          }
        }
      }
    } catch (error) {
      // Missing or unreadable state starts empty; never crash the plugin.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.warn('[dsh-skill-hub] sidecar state unreadable, starting empty:', error instanceof Error ? error.message : error)
      }
    }
  }

  async listDisabled(): Promise<DisabledSkill[]> {
    await this.ensureLoaded()
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async getDisabled(name: string): Promise<DisabledSkill | undefined> {
    await this.ensureLoaded()
    return this.entries.get(name)
  }

  async addDisabled(entry: DisabledSkill): Promise<void> {
    await this.ensureLoaded()
    this.entries.set(entry.name, entry)
    await this.persist()
  }

  async removeDisabled(name: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.entries.delete(name)) return
    await this.persist()
  }

  /** The hub's saved runtime configuration (fields absent here mean "not overridden"). */
  async getConfig(): Promise<Partial<HubConfig>> {
    await this.ensureLoaded()
    return { ...this.config }
  }

  /**
   * Persist a runtime-config patch, merged over the saved values. A field
   * whose patch value is `undefined` is removed from the saved layer, so the
   * setting re-inherits its default (the web card's "reset" path).
   */
  async setConfig(config: Partial<HubConfig>): Promise<void> {
    await this.ensureLoaded()
    const next: Partial<HubConfig> = { ...this.config }
    for (const [key, value] of Object.entries(config) as Array<[keyof HubConfig, boolean | string | undefined]>) {
      if (value === undefined) delete next[key]
      else (next as unknown as Record<string, unknown>)[key] = value
    }
    this.config = next
    await this.persist()
  }

  /** All user-defined tag groups, in creation order. */
  async listTags(): Promise<SkillTag[]> {
    await this.ensureLoaded()
    return [...this.tagsById.values()]
  }

  /** One tag by id (undefined when absent). */
  async getTag(id: string): Promise<SkillTag | undefined> {
    await this.ensureLoaded()
    return this.tagsById.get(id)
  }

  /**
   * Create (no id) or rename (with id) a tag. Returns the saved tag.
   * Creating assigns a fresh UUID; renaming keeps members.
   */
  async saveTag(input: { id?: string; name: string }): Promise<SkillTag> {
    await this.ensureLoaded()
    const name = input.name.trim()
    if (name === '') throw new TypeError('tag name must not be empty')
    let tag: SkillTag
    if (input.id !== undefined) {
      const existing = this.tagsById.get(input.id)
      if (existing === undefined) throw new TypeError('tag not found: ' + input.id)
      tag = { ...existing, name }
    } else {
      tag = { id: crypto.randomUUID(), name, skillNames: [] }
    }
    this.tagsById.set(tag.id, tag)
    await this.persist()
    return tag
  }

  /** Delete a tag by id (no-op when absent). */
  async deleteTag(id: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.tagsById.delete(id)) return
    await this.persist()
  }

  /**
   * Replace a tag's member list wholesale (idempotent). Deduplicates and
   * drops blank names; unknown skill names are kept (they may arrive later),
   * the routes layer filters against the live catalog before persisting.
   */
  async setTagMembers(id: string, skillNames: readonly string[]): Promise<SkillTag | undefined> {
    await this.ensureLoaded()
    const existing = this.tagsById.get(id)
    if (existing === undefined) return undefined
    const names = [...new Set(skillNames.filter((n) => n.trim() !== ''))]
    const tag: SkillTag = { ...existing, skillNames: names }
    this.tagsById.set(id, tag)
    await this.persist()
    return tag
  }

  /** skillName → collection name for every recorded origin. */
  async listOrigins(): Promise<Record<string, string>> {
    await this.ensureLoaded()
    return Object.fromEntries(this.origins)
  }

  /** The recorded collection for one skill (undefined = unattributed). */
  async getOrigin(skillName: string): Promise<string | undefined> {
    await this.ensureLoaded()
    return this.origins.get(skillName)
  }

  /** Record or clear a skill's collection attribution (null/blank clears). */
  async setOrigin(skillName: string, origin: string | null): Promise<void> {
    await this.ensureLoaded()
    if (origin === null || origin.trim() === '') {
      if (!this.origins.delete(skillName)) return
    } else {
      this.origins.set(skillName, origin.trim())
    }
    await this.persist()
  }

  /** All user-defined scenes, in creation order. */
  async listScenes(): Promise<SkillTag[]> {
    await this.ensureLoaded()
    return [...this.scenesById.values()]
  }

  /** One scene by id (undefined when absent). */
  async getScene(id: string): Promise<SkillTag | undefined> {
    await this.ensureLoaded()
    return this.scenesById.get(id)
  }

  /** Create (no id) or rename (with id) a scene; returns the saved scene. */
  async saveScene(input: { id?: string; name: string }): Promise<SkillTag> {
    await this.ensureLoaded()
    const name = input.name.trim()
    if (name === '') throw new TypeError('scene name must not be empty')
    let scene: SkillTag
    if (input.id !== undefined) {
      const existing = this.scenesById.get(input.id)
      if (existing === undefined) throw new TypeError('scene not found: ' + input.id)
      scene = { ...existing, name }
    } else {
      scene = { id: crypto.randomUUID(), name, skillNames: [] }
    }
    this.scenesById.set(scene.id, scene)
    await this.persist()
    return scene
  }

  /** Delete a scene by id (no-op when absent). */
  async deleteScene(id: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.scenesById.delete(id)) return
    await this.persist()
  }

  /** Replace a scene's member list wholesale (idempotent, deduplicated). */
  async setSceneMembers(id: string, skillNames: readonly string[]): Promise<SkillTag | undefined> {
    await this.ensureLoaded()
    const existing = this.scenesById.get(id)
    if (existing === undefined) return undefined
    const names = [...new Set(skillNames.filter((n) => n.trim() !== ''))]
    const scene: SkillTag = { ...existing, skillNames: names }
    this.scenesById.set(id, scene)
    await this.persist()
    return scene
  }

    private async persist(): Promise<void> {
    const payload: StoreFile = {
      version: STORE_VERSION,
      disabled: [...this.entries.values()],
      config: this.config,
      ...(this.tagsById.size > 0 ? { tags: [...this.tagsById.values()] } : {}),
      ...(this.scenesById.size > 0 ? { scenes: [...this.scenesById.values()] } : {}),
      ...(this.origins.size > 0 ? { origins: Object.fromEntries(this.origins) } : {}),
    }
    const tmp = this.file + '.tmp'
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }
}

