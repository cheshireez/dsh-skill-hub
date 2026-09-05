import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DisabledSkill, HubConfig, MarketSourceRecord, MarketStatsSnapshot, SkillStatsCheckpoint, SkillTag, SourceRecord, TrashEntry } from '../protocol.ts'
import { StoreError } from './errors.ts'
import { hydrateMigratedState, migrateStore } from './migrate.ts'
import { DEFAULT_SCENE_NAME, STORE_VERSION, statePath, type StoreFile } from './paths.ts'

/** Sidecar state owner. */
export class SkillHubStore {
  private entries = new Map<string, DisabledSkill>()
  private config: Partial<HubConfig> = {}
  private tagsById = new Map<string, SkillTag>()
  private sourcesByRepo = new Map<string, SourceRecord>()
  private marketSources: MarketSourceRecord[] = []
  private trashByName = new Map<string, TrashEntry>()
  private skillStats: SkillStatsCheckpoint | undefined = undefined
  private marketStats: MarketStatsSnapshot | undefined = undefined
  private collectionOrder: string[] = []
  private sourceGroupOrder: string[] = []
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
        const state = hydrateMigratedState(migrated)
        this.entries = state.entries
        this.config = state.config
        this.tagsById = state.tagsById
        this.sourcesByRepo = state.sourcesByRepo
        this.marketSources = state.marketSources
        this.trashByName = state.trashByName
        this.skillStats = state.skillStats
        this.marketStats = state.marketStats
        this.collectionOrder = state.collectionOrder
        this.sourceGroupOrder = state.sourceGroupOrder
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

  /** Reorder tag groups by orderedIds (drag-and-drop). */
  async reorderTags(orderedIds: string[]): Promise<SkillTag[]> {
    await this.ensureLoaded()
    const currentIds = [...this.tagsById.keys()]
    if (orderedIds.length !== currentIds.length) throw new StoreError('validation', 'orderedIds length mismatch')
    const seen = new Set<string>()
    for (const id of orderedIds) {
      if (typeof id !== 'string' || id === '') throw new StoreError('validation', 'invalid tag id')
      if (seen.has(id)) throw new StoreError('validation', 'duplicate tag id: ' + id)
      if (!this.tagsById.has(id)) throw new StoreError('not-found', 'tag not found: ' + id)
      seen.add(id)
    }
    const newMap = new Map<string, SkillTag>()
    for (const id of orderedIds) newMap.set(id, this.tagsById.get(id)!)
    this.tagsById = newMap
    await this.persist()
    return [...this.tagsById.values()]
  }

  /** Collection order for 来源分组拖拽 */
  async getCollectionOrder(): Promise<string[]> {
    await this.ensureLoaded()
    return [...this.collectionOrder]
  }

  /** Reorder collections by orderedNames (drag-and-drop). */
  async reorderCollections(orderedNames: string[]): Promise<string[]> {
    await this.ensureLoaded()
    const uniq = [...new Set(orderedNames.filter((n): n is string => typeof n === 'string' && n !== ''))]
    this.collectionOrder = uniq
    await this.persist()
    return [...this.collectionOrder]
  }

  /** Source top-level group order for 来源分组（project / col:xxx / personal） */
  async getSourceGroupOrder(): Promise<string[]> {
    await this.ensureLoaded()
    return [...this.sourceGroupOrder]
  }

  /** Reorder source top-level groups by orderedKeys */
  async reorderSourceGroups(orderedKeys: string[]): Promise<string[]> {
    await this.ensureLoaded()
    const uniq = [...new Set(orderedKeys.filter((k): k is string => typeof k === 'string' && k !== ''))]
    this.sourceGroupOrder = uniq
    await this.persist()
    return [...this.sourceGroupOrder]
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
  async addSourceSkill(repo: string, root: string, commitSha: string, ref: string | undefined, skillName: string): Promise<void> {
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
      ? {
          ...this.skillStats,
          frozenSessions: { ...this.skillStats.frozenSessions },
          ...(this.skillStats.lastTotals !== undefined ? { lastTotals: [...this.skillStats.lastTotals] } : {}),
        }
      : undefined
  }

  /** Persist a usage-statistics checkpoint (after every completed scan; cadence follows the scan TTL). */
  async saveSkillStatsState(state: SkillStatsCheckpoint): Promise<void> {
    await this.ensureLoaded()
    this.skillStats = {
      windowDays: state.windowDays,
      frozenBefore: state.frozenBefore,
      frozenSessions: { ...state.frozenSessions },
      lastFullReconcile: state.lastFullReconcile,
      ...(state.lastTotals !== undefined ? { lastTotals: [...state.lastTotals] } : {}),
    }
    await this.persist()
  }

  /** The persisted market-stats snapshot (undefined until first saved). */
  async getMarketStatsState(): Promise<MarketStatsSnapshot | undefined> {
    await this.ensureLoaded()
    return this.marketStats !== undefined
      ? { fetchedAt: this.marketStats.fetchedAt, stats: { ...this.marketStats.stats } }
      : undefined
  }

  /** Persist a market-stats snapshot (written when a refresh fetched anything new). */
  async saveMarketStatsState(state: MarketStatsSnapshot): Promise<void> {
    await this.ensureLoaded()
    this.marketStats = { fetchedAt: state.fetchedAt, stats: { ...state.stats } }
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
        ...(this.marketStats !== undefined ? { marketStats: this.marketStats } : {}),
        ...(this.collectionOrder.length > 0 ? { collectionOrder: [...this.collectionOrder] } : {}),
        ...(this.sourceGroupOrder.length > 0 ? { sourceGroupOrder: [...this.sourceGroupOrder] } : {}),
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
