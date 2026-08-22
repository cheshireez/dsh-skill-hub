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
import type { DisabledSkill, HubConfig, MarketSourceRecord, RepoRoot, SkillStatsCheckpoint, SkillTag, SourceRecord, TrashEntry } from './protocol.ts'

/** 默认场景名（系统预置的兜底场景，新技能自动归入）。 */
export const DEFAULT_SCENE_NAME = '通用'

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
  /** User-added market sources (owner/repo slugs + optional pinned ref). */
  marketSources?: MarketSourceRecord[]
  /** Trashed skills (removed after upstream deletion, restorable). */
  trash?: TrashEntry[]
  /** Usage-statistics incremental-scan checkpoint (frozen watermark + totals). */
  skillStats?: SkillStatsCheckpoint
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
export const STORE_VERSION = 4

/**
 * Business-rule failure the routes layer can map onto a 4xx status instead
 * of a blanket 500: user input is invalid (validation → 400), the target
 * does not exist (not-found → 404), or the operation conflicts with an
 * invariant (conflict → 409).
 */
export class StoreError extends Error {
  readonly kind: 'validation' | 'not-found' | 'conflict'
  constructor(kind: StoreError['kind'], message: string) {
    super(message)
    this.name = 'StoreError'
    this.kind = kind
  }
}

/**
 * Normalize an arbitrary parsed sidecar document to the current schema.
 * v1 to v2: scenes are dropped (the one-click role merged into group
 * switches), and origins are migrated into source records (repo = origin
 * value, commit snapshot empty — the first update check backfills it).
 * v2 to v3: market sources become records ({ repo, ref?, commitSha? })
 * instead of bare repo slugs, so a source can pin a release/branch version.
 * Returns null when the file claims a newer schema than this plugin
 * understands, so the caller starts empty instead of risking data loss.
 */
function migrateStore(parsed: unknown): { version: number; disabled: unknown; config?: unknown; tags?: unknown; sources?: unknown; marketSources?: unknown; trash?: unknown; skillStats?: unknown } | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const version = typeof record.version === 'number' ? record.version : 0
  if (version > STORE_VERSION) return null
  const disabled = Array.isArray(record.disabled) ? record.disabled : []
  const config = typeof record.config === 'object' && record.config !== null && !Array.isArray(record.config) ? record.config : undefined
  const tags = Array.isArray(record.tags) ? record.tags : undefined
  const trash = Array.isArray(record.trash) ? record.trash : undefined
  // v2 stored bare slugs; v3 stores records. Normalize both shapes here.
  const marketSources = Array.isArray(record.marketSources)
    ? record.marketSources.map((entry) => typeof entry === 'string'
      ? { repo: entry }
      : entry)
    : undefined

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
    // v4 (skillStats) is a pure addition — older files simply lack the field,
    // and the loader validates its shape, so pass it through untouched.
    ...(record.skillStats !== undefined ? { skillStats: record.skillStats } : {}),
  }
}

/** Sidecar state owner. */
export class SkillHubStore {
  private entries = new Map<string, DisabledSkill>()
  private config: Partial<HubConfig> = {}
  private tagsById = new Map<string, SkillTag>()
  private sourcesByRepo = new Map<string, SourceRecord>()
  private marketSources: MarketSourceRecord[] = []
  private trashByName = new Map<string, TrashEntry>()
  private skillStats: SkillStatsCheckpoint | undefined = undefined
  private loaded = false
  /** Serializes persist runs: concurrent mutators must not let an earlier
   *  snapshot overwrite a later one (rename is atomic, ordering is not). */
  private writeChain: Promise<void> = Promise.resolve()

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
        const saved = migrated.config as { enabled?: unknown; announceToAgent?: unknown; dotModelColor?: unknown; dotUserColor?: unknown; showUseCount?: unknown; showUseTime?: unknown; showGroupSummary?: unknown } | undefined
        if (typeof saved === 'object' && saved !== null) {
          if (typeof saved.enabled === 'boolean') this.config.enabled = saved.enabled
          if (typeof saved.announceToAgent === 'boolean') this.config.announceToAgent = saved.announceToAgent
          if (typeof saved.dotModelColor === 'string' && saved.dotModelColor !== '') this.config.dotModelColor = saved.dotModelColor
          if (typeof saved.dotUserColor === 'string' && saved.dotUserColor !== '') this.config.dotUserColor = saved.dotUserColor
          if (typeof saved.showUseCount === 'boolean') this.config.showUseCount = saved.showUseCount
          if (typeof saved.showUseTime === 'boolean') this.config.showUseTime = saved.showUseTime
          if (typeof saved.showGroupSummary === 'boolean') this.config.showGroupSummary = saved.showGroupSummary
        }
        if (Array.isArray(migrated.tags)) {
          for (const entry of migrated.tags as unknown[]) {
            const tag = entry as { id?: unknown; name?: unknown; skillNames?: unknown; default?: unknown } | null
            if (tag !== null && typeof tag === 'object' && typeof tag.id === 'string' && typeof tag.name === 'string' && Array.isArray(tag.skillNames)) {
              this.tagsById.set(tag.id, {
                id: tag.id,
                name: tag.name,
                skillNames: tag.skillNames.filter((n): n is string => typeof n === 'string'),
                ...(tag.default === true ? { default: true } : {}),
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
          for (const entry of migrated.marketSources as unknown[]) {
            const item = entry as { repo?: unknown; ref?: unknown; commitSha?: unknown } | null
            if (item !== null && typeof item === 'object' && typeof item.repo === 'string' && item.repo !== '' && !this.marketSources.some((s) => s.repo === item.repo)) {
              this.marketSources.push({
                repo: item.repo,
                ...(typeof item.ref === 'string' && item.ref !== '' ? { ref: item.ref } : {}),
                ...(typeof item.commitSha === 'string' && item.commitSha !== '' ? { commitSha: item.commitSha } : {}),
              })
            }
          }
        }
        if (Array.isArray(migrated.trash)) {
          for (const entry of migrated.trash as unknown[]) {
            const item = entry as { name?: unknown; path?: unknown; movedAt?: unknown; sourcePath?: unknown } | null
            if (item !== null && typeof item === 'object' && typeof item.name === 'string' && typeof item.path === 'string') {
              const origin = (item as Record<string, unknown>).origin as { repo?: unknown; root?: unknown; ref?: unknown; commitSha?: unknown } | undefined
              const tagIds = (item as Record<string, unknown>).tagIds
              this.trashByName.set(item.name, {
                name: item.name,
                path: item.path,
                movedAt: typeof item.movedAt === 'number' ? item.movedAt : 0,
                ...(typeof item.sourcePath === 'string' && item.sourcePath !== '' ? { sourcePath: item.sourcePath } : {}),
                ...(origin !== null && typeof origin === 'object' && typeof origin.repo === 'string' && origin.repo !== '' && (origin.root === 'skills' || origin.root === 'design-templates')
                  ? {
                      origin: {
                        repo: origin.repo,
                        root: origin.root,
                        ...(typeof origin.ref === 'string' && origin.ref !== '' ? { ref: origin.ref } : {}),
                        commitSha: typeof origin.commitSha === 'string' ? origin.commitSha : '',
                      },
                    }
                  : {}),
                ...(Array.isArray(tagIds) ? { tagIds: tagIds.filter((id): id is string => typeof id === 'string') } : {}),
              })
            }
          }
        }
        const savedStats = migrated.skillStats as Partial<SkillStatsCheckpoint> | null | undefined
        if (savedStats !== null && typeof savedStats === 'object'
          && typeof savedStats.frozenBefore === 'number' && typeof savedStats.lastFullReconcile === 'number'
          && typeof savedStats.windowDays === 'number'
          && typeof savedStats.frozenSessions === 'object' && savedStats.frozenSessions !== null) {
          // Validate entry shapes too: a corrupt bucket degrades to a fresh
          // checkpoint (one extra full reconciliation), never to bad counts.
          const sessions: SkillStatsCheckpoint['frozenSessions'] = {}
          for (const [id, entry] of Object.entries(savedStats.frozenSessions)) {
            if (entry === null || typeof entry !== 'object' || typeof entry.createdAt !== 'number'
              || typeof entry.counts !== 'object' || entry.counts === null) continue
            const counts: Record<string, { count: number; lastUsed: number }> = {}
            for (const [name, stat] of Object.entries(entry.counts)) {
              if (stat !== null && typeof stat === 'object'
                && typeof (stat as { count?: unknown }).count === 'number'
                && typeof (stat as { lastUsed?: unknown }).lastUsed === 'number') {
                counts[name] = { count: (stat as { count: number }).count, lastUsed: (stat as { lastUsed: number }).lastUsed }
              }
            }
            sessions[id] = { createdAt: entry.createdAt, counts }
          }
          this.skillStats = {
            windowDays: savedStats.windowDays,
            frozenBefore: savedStats.frozenBefore,
            frozenSessions: sessions,
            lastFullReconcile: savedStats.lastFullReconcile,
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
    await this.ensureDefaultTag()
  }

  /**
   * 保证存在默认场景：没有任何 default 标记的 tag 时创建「通用」。
   * 新技能创建后自动归入它；用户可改名，但默认场景不可删除。
   */
  private async ensureDefaultTag(): Promise<void> {
    if ([...this.tagsById.values()].some((tag) => tag.default === true)) return
    const tag: SkillTag = { id: crypto.randomUUID(), name: DEFAULT_SCENE_NAME, skillNames: [], default: true }
    this.tagsById.set(tag.id, tag)
    await this.persist()
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
    if (name === '') throw new StoreError('validation', 'tag name must not be empty')
    let tag: SkillTag
    if (input.id !== undefined) {
      const existing = this.tagsById.get(input.id)
      if (existing === undefined) throw new StoreError('not-found', 'tag not found: ' + input.id)
      tag = { ...existing, name }
    } else {
      tag = { id: crypto.randomUUID(), name, skillNames: [] }
    }
    this.tagsById.set(tag.id, tag)
    await this.persist()
    return tag
  }

  /** Delete a tag by id (no-op when absent). The default scene cannot be deleted. */
  async deleteTag(id: string): Promise<void> {
    await this.ensureLoaded()
    const tag = this.tagsById.get(id)
    if (tag?.default === true) throw new StoreError('conflict', 'the default scene cannot be deleted')
    if (!this.tagsById.delete(id)) return
    await this.persist()
  }

  /** The default scene (「通用」), guaranteed to exist after ensureLoaded. */
  async getDefaultTag(): Promise<SkillTag | undefined> {
    await this.ensureLoaded()
    return [...this.tagsById.values()].find((tag) => tag.default === true)
  }

  /** Append one skill name to a tag (deduplicated; no-op when already a member). */
  async addSkillToTag(id: string, name: string): Promise<SkillTag | undefined> {
    await this.ensureLoaded()
    const existing = this.tagsById.get(id)
    if (existing === undefined || name.trim() === '' || existing.skillNames.includes(name)) return existing
    const tag: SkillTag = { ...existing, skillNames: [...existing.skillNames, name] }
    this.tagsById.set(id, tag)
    await this.persist()
    return tag
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

  /** Remove one skill from every tag group (used when the skill is deleted). */
  async removeSkillFromTags(name: string): Promise<void> {
    await this.ensureLoaded()
    let changed = false
    for (const tag of this.tagsById.values()) {
      if (!tag.skillNames.includes(name)) continue
      tag.skillNames = tag.skillNames.filter((n) => n !== name)
      changed = true
    }
    if (changed) await this.persist()
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

  /** The source record that tracks a skill name (undefined when untracked). */
  async getSourceForSkill(name: string): Promise<SourceRecord | undefined> {
    await this.ensureLoaded()
    for (const source of this.sourcesByRepo.values()) {
      if (source.skills.includes(name)) return source
    }
    return undefined
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

  /** Remove one skill from every source record (used when the skill is deleted). */
  async removeSkillFromSources(name: string): Promise<void> {
    await this.ensureLoaded()
    let changed = false
    for (const [repo, source] of this.sourcesByRepo) {
      if (!source.skills.includes(name)) continue
      const skills = source.skills.filter((n) => n !== name)
      if (skills.length === 0) this.sourcesByRepo.delete(repo)
      else this.sourcesByRepo.set(repo, { ...source, skills })
      changed = true
    }
    if (changed) await this.persist()
  }

  /** Update a source's commit snapshot. */
  async setSourceCommit(repo: string, commitSha: string): Promise<void> {
    await this.ensureLoaded()
    const existing = this.sourcesByRepo.get(repo)
    if (existing === undefined) return
    this.sourcesByRepo.set(repo, { ...existing, commitSha })
    await this.persist()
  }

  /** Update a source's pinned ref (release tag / branch) when the market syncs. */
  async setSourceRef(repo: string, ref: string): Promise<void> {
    await this.ensureLoaded()
    const existing = this.sourcesByRepo.get(repo)
    if (existing === undefined || ref.trim() === '') return
    this.sourcesByRepo.set(repo, { ...existing, ref: ref.trim() })
    await this.persist()
  }

  /**
   * Merge per-path manifest entries into a source (incremental imports).
   * When `dir` is given, every baseline path under that skill directory is
   * dropped first, so files the upstream removed never linger in the
   * baseline and skew later update diffs.
   */
  async mergeSourceManifest(repo: string, manifest: Record<string, number>, dir?: string): Promise<void> {
    await this.ensureLoaded()
    const existing = this.sourcesByRepo.get(repo)
    if (existing === undefined || Object.keys(manifest).length === 0) return
    const base: Record<string, number> = { ...(existing.manifest ?? {}) }
    if (dir !== undefined && dir !== '') {
      const prefix = dir + '/'
      for (const path of Object.keys(base)) {
        if (path.startsWith(prefix)) delete base[path]
      }
    }
    this.sourcesByRepo.set(repo, { ...existing, manifest: { ...base, ...manifest } })
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

  /** The user's market sources, in addition order. */
  async listMarketSources(): Promise<MarketSourceRecord[]> {
    await this.ensureLoaded()
    return [...this.marketSources]
  }

  /** One market source by repo (undefined when absent). */
  async getMarketSource(repo: string): Promise<MarketSourceRecord | undefined> {
    await this.ensureLoaded()
    return this.marketSources.find((entry) => entry.repo === repo)
  }

  /** Add a repo (deduplicated), optionally with a pinned ref. Returns the fresh list. */
  async addMarketSource(repo: string, ref?: string): Promise<MarketSourceRecord[]> {
    await this.ensureLoaded()
    const existing = this.marketSources.find((entry) => entry.repo === repo)
    if (existing === undefined) {
      this.marketSources.push(ref !== undefined && ref !== '' ? { repo, ref } : { repo })
    } else if (ref !== undefined && ref !== '' && existing.ref !== ref) {
      existing.ref = ref
    }
    await this.persist()
    return [...this.marketSources]
  }

  /** Remove a repo (no-op when absent). Returns the fresh list. */
  async removeMarketSource(repo: string): Promise<MarketSourceRecord[]> {
    await this.ensureLoaded()
    const index = this.marketSources.findIndex((entry) => entry.repo === repo)
    if (index === -1) return [...this.marketSources]
    this.marketSources.splice(index, 1)
    await this.persist()
    return [...this.marketSources]
  }

  /** Pin a market source to an explicit ref (branch/tag). Returns the record. */
  async setMarketSourceRef(repo: string, ref: string): Promise<MarketSourceRecord | undefined> {
    await this.ensureLoaded()
    const entry = this.marketSources.find((item) => item.repo === repo)
    if (entry === undefined || ref.trim() === '') return entry
    entry.ref = ref.trim()
    delete entry.commitSha
    await this.persist()
    return entry
  }

  /** Record the commit a market source's pinned ref resolved to (update baseline). */
  async setMarketSourceCommit(repo: string, commitSha: string): Promise<void> {
    await this.ensureLoaded()
    const entry = this.marketSources.find((item) => item.repo === repo)
    if (entry === undefined || commitSha === '') return
    entry.commitSha = commitSha
    await this.persist()
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

  /** The persisted usage-statistics checkpoint (undefined until first saved). */
  async getSkillStatsState(): Promise<SkillStatsCheckpoint | undefined> {
    await this.ensureLoaded()
    return this.skillStats !== undefined
      ? { ...this.skillStats, frozenSessions: { ...this.skillStats.frozenSessions } }
      : undefined
  }

  /** Persist a usage-statistics checkpoint (written at most ~once a day, on full reconciliations). */
  async saveSkillStatsState(state: SkillStatsCheckpoint): Promise<void> {
    await this.ensureLoaded()
    this.skillStats = {
      windowDays: state.windowDays,
      frozenBefore: state.frozenBefore,
      frozenSessions: { ...state.frozenSessions },
      lastFullReconcile: state.lastFullReconcile,
    }
    await this.persist()
  }

  private persist(): Promise<void> {
    // The payload is built inside the queued step (not here), so every
    // concurrent mutation made before a write actually lands is included in
    // the final file instead of being rolled back by an older snapshot.
    const run = this.writeChain.then(async () => {
      const payload: StoreFile = {
        version: STORE_VERSION,
        disabled: [...this.entries.values()],
        config: this.config,
        ...(this.tagsById.size > 0 ? { tags: [...this.tagsById.values()] } : {}),
        ...(this.sourcesByRepo.size > 0 ? { sources: [...this.sourcesByRepo.values()] } : {}),
        ...(this.marketSources.length > 0 ? { marketSources: [...this.marketSources] } : {}),
        ...(this.trashByName.size > 0 ? { trash: [...this.trashByName.values()] } : {}),
        ...(this.skillStats !== undefined ? { skillStats: this.skillStats } : {}),
      }
      const tmp = this.file + '.tmp'
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      await rename(tmp, this.file)
    })
    // Keep the chain alive on failure; callers still observe the rejection.
    this.writeChain = run.catch(() => {})
    return run
  }
}
