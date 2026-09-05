import type { DisabledSkill, HubConfig, MarketSourceRecord, MarketStatsSnapshot, SkillStatsCheckpoint, SkillTag, SourceRecord, TrashEntry } from '../protocol.ts'
import { STORE_VERSION } from './paths.ts'

/** Normalized raw sidecar document after schema migration (fields still unvalidated). */
export interface MigratedStore {
  version: number
  disabled: unknown
  config?: unknown
  tags?: unknown
  sources?: unknown
  marketSources?: unknown
  trash?: unknown
  skillStats?: unknown
  marketStats?: unknown
  collectionOrder?: unknown
  sourceGroupOrder?: unknown
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
export function migrateStore(parsed: unknown): MigratedStore | null {
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
    // marketStats follows the same pattern (validated on load below).
    ...(record.skillStats !== undefined ? { skillStats: record.skillStats } : {}),
    ...(record.marketStats !== undefined ? { marketStats: record.marketStats } : {}),
    ...(Array.isArray(record.collectionOrder) ? { collectionOrder: record.collectionOrder } : {}),
    ...(Array.isArray(record.sourceGroupOrder) ? { sourceGroupOrder: record.sourceGroupOrder } : {}),
  }
}

/** Validated in-memory state hydrated from a migrated document. */
export interface HydratedState {
  entries: Map<string, DisabledSkill>
  config: Partial<HubConfig>
  tagsById: Map<string, SkillTag>
  sourcesByRepo: Map<string, SourceRecord>
  marketSources: MarketSourceRecord[]
  trashByName: Map<string, TrashEntry>
  skillStats: SkillStatsCheckpoint | undefined
  marketStats: MarketStatsSnapshot | undefined
  collectionOrder: string[]
  sourceGroupOrder: string[]
}

/** 小优化：统一的非空字符串数组清洗（去空、去重可选由调用方处理）。 */
function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((n): n is string => typeof n === 'string' && n !== '')
}

/**
 * 把迁移后的原始文档校验为内存状态：坏条目丢弃、坏桶降级为空，
 * 绝不因一条脏数据丢掉整个 sidecar（与原 ensureLoaded 内联逻辑一致）。
 */
export function hydrateMigratedState(migrated: MigratedStore): HydratedState {
  const entries = new Map<string, DisabledSkill>()
  if (Array.isArray(migrated.disabled)) {
    for (const entry of migrated.disabled) {
      if (typeof entry?.name === 'string' && typeof entry?.path === 'string') {
        entries.set(entry.name, entry)
      }
    }
  }

  const config: Partial<HubConfig> = {}
  const saved = migrated.config as { enabled?: unknown; announceToAgent?: unknown; dotModelColor?: unknown; dotUserColor?: unknown; showUseCount?: unknown; showUseTime?: unknown; showGroupSummary?: unknown } | undefined
  if (typeof saved === 'object' && saved !== null) {
    if (typeof saved.enabled === 'boolean') config.enabled = saved.enabled
    if (typeof saved.announceToAgent === 'boolean') config.announceToAgent = saved.announceToAgent
    if (typeof saved.dotModelColor === 'string' && saved.dotModelColor !== '') config.dotModelColor = saved.dotModelColor
    if (typeof saved.dotUserColor === 'string' && saved.dotUserColor !== '') config.dotUserColor = saved.dotUserColor
    if (typeof saved.showUseCount === 'boolean') config.showUseCount = saved.showUseCount
    if (typeof saved.showUseTime === 'boolean') config.showUseTime = saved.showUseTime
    if (typeof saved.showGroupSummary === 'boolean') config.showGroupSummary = saved.showGroupSummary
  }

  const tagsById = new Map<string, SkillTag>()
  if (Array.isArray(migrated.tags)) {
    for (const entry of migrated.tags as unknown[]) {
      const tag = entry as { id?: unknown; name?: unknown; skillNames?: unknown; default?: unknown } | null
      if (tag !== null && typeof tag === 'object' && typeof tag.id === 'string' && typeof tag.name === 'string' && Array.isArray(tag.skillNames)) {
        tagsById.set(tag.id, {
          id: tag.id,
          name: tag.name,
          skillNames: tag.skillNames.filter((n): n is string => typeof n === 'string'),
          ...(tag.default === true ? { default: true } : {}),
        })
      }
    }
  }

  const sourcesByRepo = new Map<string, SourceRecord>()
  if (Array.isArray(migrated.sources)) {
    for (const entry of migrated.sources as unknown[]) {
      const source = entry as { repo?: unknown; ref?: unknown; root?: unknown; commitSha?: unknown; skills?: unknown; manifest?: unknown } | null
      if (source !== null && typeof source === 'object' && typeof source.repo === 'string' && source.repo !== '' && Array.isArray(source.skills)) {
        const manifest = source.manifest as Record<string, unknown> | undefined
        const rawRoot = typeof source.root === 'string' && source.root !== '' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.root) ? source.root : 'skills'
        sourcesByRepo.set(source.repo, {
          repo: source.repo,
          ...(typeof source.ref === 'string' && source.ref !== '' ? { ref: source.ref } : {}),
          root: rawRoot,
          commitSha: typeof source.commitSha === 'string' ? source.commitSha : '',
          skills: source.skills.filter((n): n is string => typeof n === 'string'),
          ...(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
            ? { manifest: Object.fromEntries(Object.entries(manifest).filter(([, size]) => typeof size === 'number')) as Record<string, number> }
            : {}),
        })
      }
    }
  }

  const marketSources: MarketSourceRecord[] = []
  if (Array.isArray(migrated.marketSources)) {
    for (const entry of migrated.marketSources as unknown[]) {
      const item = entry as { repo?: unknown; ref?: unknown; commitSha?: unknown } | null
      if (item !== null && typeof item === 'object' && typeof item.repo === 'string' && item.repo !== '' && !marketSources.some((s) => s.repo === item.repo)) {
        marketSources.push({
          repo: item.repo,
          ...(typeof item.ref === 'string' && item.ref !== '' ? { ref: item.ref } : {}),
          ...(typeof item.commitSha === 'string' && item.commitSha !== '' ? { commitSha: item.commitSha } : {}),
        })
      }
    }
  }

  const trashByName = new Map<string, TrashEntry>()
  if (Array.isArray(migrated.trash)) {
    for (const entry of migrated.trash as unknown[]) {
      const item = entry as { name?: unknown; path?: unknown; movedAt?: unknown; sourcePath?: unknown } | null
      if (item !== null && typeof item === 'object' && typeof item.name === 'string' && typeof item.path === 'string') {
        const origin = (item as Record<string, unknown>).origin as { repo?: unknown; root?: unknown; ref?: unknown; commitSha?: unknown } | undefined
        const tagIds = (item as Record<string, unknown>).tagIds
        trashByName.set(item.name, {
          name: item.name,
          path: item.path,
          movedAt: typeof item.movedAt === 'number' ? item.movedAt : 0,
          ...(typeof item.sourcePath === 'string' && item.sourcePath !== '' ? { sourcePath: item.sourcePath } : {}),
          ...(origin !== null && typeof origin === 'object' && typeof origin.repo === 'string' && origin.repo !== '' && typeof origin.root === 'string' && origin.root !== '' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(origin.root)
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

  let skillStats: SkillStatsCheckpoint | undefined = undefined
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
    const rawTotals = (savedStats as { lastTotals?: unknown }).lastTotals
    const lastTotals = Array.isArray(rawTotals)
      ? rawTotals.filter((entry): entry is { name: string; count: number; lastUsed?: number } =>
          entry !== null && typeof entry === 'object'
          && typeof (entry as { name?: unknown }).name === 'string'
          && typeof (entry as { count?: unknown }).count === 'number').map((entry) => ({
            name: (entry as { name: string }).name,
            count: (entry as { count: number }).count,
            ...(typeof (entry as { lastUsed?: unknown }).lastUsed === 'number' ? { lastUsed: (entry as { lastUsed: number }).lastUsed } : {}),
          }))
      : undefined
    skillStats = {
      windowDays: savedStats.windowDays,
      frozenBefore: savedStats.frozenBefore,
      frozenSessions: sessions,
      lastFullReconcile: savedStats.lastFullReconcile,
      ...(lastTotals !== undefined ? { lastTotals } : {}),
    }
  }

  let marketStats: MarketStatsSnapshot | undefined = undefined
  const savedMarketStats = migrated.marketStats as Partial<MarketStatsSnapshot> | null | undefined
  if (savedMarketStats !== null && typeof savedMarketStats === 'object'
    && typeof savedMarketStats.fetchedAt === 'number'
    && typeof savedMarketStats.stats === 'object' && savedMarketStats.stats !== null) {
    // A corrupt bucket degrades to no snapshot (one cold fetch), never to bad numbers.
    const stats: MarketStatsSnapshot['stats'] = {}
    for (const [repo, entry] of Object.entries(savedMarketStats.stats)) {
      if (entry !== null && typeof entry === 'object'
        && typeof (entry as { stars?: unknown }).stars === 'number'
        && typeof (entry as { downloads?: unknown }).downloads === 'number') {
        stats[repo] = { stars: (entry as { stars: number }).stars, downloads: (entry as { downloads: number }).downloads }
      }
    }
    marketStats = { fetchedAt: savedMarketStats.fetchedAt, stats }
  }

  const collectionOrder = cleanStringList(migrated.collectionOrder)
  const sourceGroupOrder = cleanStringList(migrated.sourceGroupOrder)

  return { entries, config, tagsById, sourcesByRepo, marketSources, trashByName, skillStats, marketStats, collectionOrder, sourceGroupOrder }
}
