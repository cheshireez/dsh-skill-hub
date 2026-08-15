/**
 * Hub sidecar store: remembers which skills the hub toggled off and the
 * user's organization/tracking records. Disabling renames the skill's
 * SKILL.md (or flat .md) out of the filesystem provider's discovery shapes,
 * so the provider catalog alone cannot see disabled skills; this store keeps
 * name/path/root so the GUI can list them and re-enable. It also persists
 * user tag groups, upstream source records (repo + commit snapshot for
 * update checks), the market source list, and the trash (skills removed
 * after upstream deletion).
 *
 * State file: $DSH_HOME/dsh-skill-hub.json — a small JSON document written
 * atomically (tmp file + rename).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DisabledSkill, HubConfig, RepoRoot, SkillTag, SourceRecord, TrashEntry } from './protocol.ts'

/** Wire shape persisted on disk. */
interface StoreFile {
  version: number
  disabled: DisabledSkill[]
  /** Runtime configuration edited from the web settings card (hub-owned, not settings-service). */
  config?: Partial<HubConfig>
  /** User-defined tag groups (pure organization; skill files untouched). */
  tags?: SkillTag[]
  /** Upstream source tracking records (repo + commit snapshot). */
  sources?: SourceRecord[]
  /** User-added market sources (owner/repo slugs). */
  marketSources?: string[]
  /** Trashed skills (removed after upstream deletion, restorable). */
  trash?: TrashEntry[]
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
export const STORE_VERSION = 2

/**
 * Normalize an arbitrary parsed sidecar document to the current schema.
 * v1 to v2: scenes are dropped (the one-click role merged into group
 * switches), and origins are migrated into source records (repo = origin
 * value, commit snapshot empty — the first update check backfills it).
 * Returns null when the file claims a newer schema than this plugin
 * understands, so the caller starts empty instead of risking data loss.
 */
function migrateStore(parsed: unknown): { version: number; disabled: unknown; config?: unknown; tags?: unknown; sources?: unknown; marketSources?: unknown; trash?: unknown } | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const version = typeof record.version === 'number' ? record.version : 0
  if (version > STORE_VERSION) return null
  const disabled = Array.isArray(record.disabled) ? record.disabled : []
  const config = typeof record.config === 'object' && record.config !== null && !Array.isArray(record.config) ? record.config : undefined
  const tags = Array.isArray(record.tags) ? record.tags : undefined
  const trash = Array.isArray(record.trash) ? record.trash : undefined
  const marketSources = Array.isArray(record.marketSources) ? record.marketSources : undefined

  // v2 stores structured source records; v1 only had a skillName to
  // collection string map (origins). Migrate each origin into a SourceRecord
  // whose repo is the collection string itself and whose commit snapshot is
  // empty.
  let sources: unknown
  if (Array.isArray(record.sources)) {
    sources = record.sources
  } else if (version < 2 && typeof record.origins === 'object' && record.origins !== null && !Array.isArray(record.origins)) {
    const byOrigin = new Map<string, string[]>()
    for (const [name, origin] of Object.entries(record.origins as Record<string, unknown>)) {
      if (typeof origin !== 'string' || origin === '') continue
      const list = byOrigin.get(origin)
      if (list === undefined) byOrigin.set(origin, [name])
      else list.push(name)
    }
    sources = [...byOrigin.entries()].map(([repo, skillNames]) => ({
      repo,
      root: 'skills',
      commitSha: '',
      skills: skillNames.sort((a, b) => a.localeCompare(b)),
    }))
  }
  return {
    version: STORE_VERSION,
    disabled,
    ...(config !== undefined ? { config } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(marketSources !== undefined ? { marketSources } : {}),
    ...(trash !== undefined ? { trash } : {}),
  }
}

/** Sidecar state owner. */
export class SkillHubStore {
  private entries = new Map<string, DisabledSkill>()
  private config: Partial<HubConfig> = {}
  private tagsById = new Map<string, SkillTag>()
  private sourcesByRepo = new Map<string, SourceRecord>()
  private marketSources: string[] = []
  private trashByName = new Map<string, TrashEntry>()
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
        if (Array.isArray(migrated.sources)) {
          for (const entry of migrated.sources as unknown[]) {
            const source = entry as { repo?: unknown; ref?: unknown; root?: unknown; commitSha?: unknown; skills?: unknown; manifest?: unknown } | null
            if (source !== null && typeof source === 'object' && typeof source.repo === 'string' && source.repo !== '' && Array.isArray(source.skills)) {
              const manifest = source.manifest as Record<string, unknown> | undefined
              this.sourcesByRepo.set(source.repo, {
                repo: source.repo,
                ...(typeof source.ref === 'string' && source.ref !== '' ? { ref: source.ref } : {}),
                root: (source.root === 'design-templates' ? 'design-templates' : 'skills') as RepoRoot,
                commitSha: typeof source.commitSha === 'string' ? source.commitSha : '',
                skills: source.skills.filter((n): n is string => typeof n === 'string'),
                ...(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
                  ? { manifest: Object.fromEntries(Object.entries(manifest).filter(([, size]) => typeof size === 'number')) as Record<string, number> }
                  : {}),
              })
            }
          }
        }
        if (Array.isArray(migrated.marketSources)) {
          for (const repo of migrated.marketSources) {
            if (typeof repo === 'string' && repo !== '' && !this.marketSources.includes(repo)) this.marketSources.push(repo)
          }
        }
        if (Array.isArray(migrated.trash)) {
          for (const entry of migrated.trash as unknown[]) {
            const item = entry as { name?: unknown; path?: unknown; movedAt?: unknown } | null
            if (item !== null && typeof item === 'object' && typeof item.name === 'string' && typeof item.path === 'string') {
              this.trashByName.set(item.name, {
                name: item.name,
                path: item.path,
                movedAt: typeof item.movedAt === 'number' ? item.movedAt : 0,
              })
            }
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
   * whose patch value is undefined is removed from the saved layer, so the
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

  // ------------------------------------------------------------ sources

  /** All source records, sorted by repo. */
  async listSources(): Promise<SourceRecord[]> {
    await this.ensureLoaded()
    return [...this.sourcesByRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo))
  }

  /** One source record by repo (undefined when absent). */
  async getSource(repo: string): Promise<SourceRecord | undefined> {
    await this.ensureLoaded()
    return this.sourcesByRepo.get(repo)
  }

  /** Persist a source record as-is (null removes it). */
  async saveSource(source: SourceRecord | null): Promise<void> {
    await this.ensureLoaded()
    if (source === null) {
      return
    }
    this.sourcesByRepo.set(source.repo, source)
    await this.persist()
  }

  /** Remove a source record entirely (no-op when absent). */
  async deleteSource(repo: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.sourcesByRepo.delete(repo)) return
    await this.persist()
  }

  /**
   * Upsert one skill into a source record. When the repo has no record yet a
   * new one is created (root + commit snapshot from the caller).
   */
  async addSourceSkill(repo: string, root: RepoRoot, commitSha: string, ref: string | undefined, skillName: string): Promise<void> {
    await this.ensureLoaded()
    const existing = this.sourcesByRepo.get(repo)
    if (existing === undefined) {
      this.sourcesByRepo.set(repo, {
        repo,
        ...(ref !== undefined && ref !== '' ? { ref } : {}),
        root,
        commitSha,
        skills: [skillName],
      })
    } else {
      const skills = existing.skills.includes(skillName) ? existing.skills : [...existing.skills, skillName].sort((a, b) => a.localeCompare(b))
      this.sourcesByRepo.set(repo, { ...existing, skills })
    }
    await this.persist()
  }

  /** Replace a source's skill list (used after sync/confirm-delete). */
  async setSourceSkills(repo: string, skills: readonly string[]): Promise<SourceRecord | undefined> {
    await this.ensureLoaded()
    const existing = this.sourcesByRepo.get(repo)
    if (existing === undefined) return undefined
    const names = [...new Set(skills.filter((n) => n.trim() !== ''))].sort((a, b) => a.localeCompare(b))
    if (names.length === 0) {
      this.sourcesByRepo.delete(repo)
    } else {
      this.sourcesByRepo.set(repo, { ...existing, skills: names })
    }
    await this.persist()
    return this.sourcesByRepo.get(repo)
  }

  /** Update a source's commit snapshot. */
  async setSourceCommit(repo: string, commitSha: string): Promise<void> {
    await this.ensureLoaded()
    const existing = this.sourcesByRepo.get(repo)
    if (existing === undefined) return
    this.sourcesByRepo.set(repo, { ...existing, commitSha })
    await this.persist()
  }

  /** Merge per-path manifest entries into a source (incremental imports). */
  async mergeSourceManifest(repo: string, manifest: Record<string, number>): Promise<void> {
    await this.ensureLoaded()
    const existing = this.sourcesByRepo.get(repo)
    if (existing === undefined || Object.keys(manifest).length === 0) return
    this.sourcesByRepo.set(repo, { ...existing, manifest: { ...(existing.manifest ?? {}), ...manifest } })
    await this.persist()
  }

  /** skillName → collection name for every recorded origin (derived from sources). */
  async listOrigins(): Promise<Record<string, string>> {
    await this.ensureLoaded()
    const origins: Record<string, string> = {}
    for (const source of this.sourcesByRepo.values()) {
      for (const name of source.skills) origins[name] = source.repo
    }
    return origins
  }

  // ------------------------------------------------------ market sources

  /** The user's market source repos, in addition order. */
  async listMarketSources(): Promise<string[]> {
    await this.ensureLoaded()
    return [...this.marketSources]
  }

  /** Add a repo slug (deduplicated). Returns the fresh list. */
  async addMarketSource(repo: string): Promise<string[]> {
    await this.ensureLoaded()
    if (!this.marketSources.includes(repo)) this.marketSources.push(repo)
    await this.persist()
    return [...this.marketSources]
  }

  /** Remove a repo slug (no-op when absent). Returns the fresh list. */
  async removeMarketSource(repo: string): Promise<string[]> {
    await this.ensureLoaded()
    const index = this.marketSources.indexOf(repo)
    if (index === -1) return [...this.marketSources]
    this.marketSources.splice(index, 1)
    await this.persist()
    return [...this.marketSources]
  }

  // ---------------------------------------------------------------- trash

  /** All trashed skills, newest first. */
  async listTrash(): Promise<TrashEntry[]> {
    await this.ensureLoaded()
    return [...this.trashByName.values()].sort((a, b) => b.movedAt - a.movedAt)
  }

  /** One trash entry by skill name (undefined when absent). */
  async getTrash(name: string): Promise<TrashEntry | undefined> {
    await this.ensureLoaded()
    return this.trashByName.get(name)
  }

  /** Record a trashed skill. */
  async addTrash(entry: TrashEntry): Promise<void> {
    await this.ensureLoaded()
    this.trashByName.set(entry.name, entry)
    await this.persist()
  }

  /** Remove a trash record (after restore). */
  async removeTrash(name: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.trashByName.delete(name)) return
    await this.persist()
  }

  private async persist(): Promise<void> {
    const payload: StoreFile = {
      version: STORE_VERSION,
      disabled: [...this.entries.values()],
      config: this.config,
      ...(this.tagsById.size > 0 ? { tags: [...this.tagsById.values()] } : {}),
      ...(this.sourcesByRepo.size > 0 ? { sources: [...this.sourcesByRepo.values()] } : {}),
      ...(this.marketSources.length > 0 ? { marketSources: [...this.marketSources] } : {}),
      ...(this.trashByName.size > 0 ? { trash: [...this.trashByName.values()] } : {}),
    }
    const tmp = this.file + '.tmp'
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }
}
