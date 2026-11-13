/**
 * Sidecar state core —— state 容器、冷读、原子写、写入封锁的唯一拥有者。
 *
 * 拆分判据：各领域 slice 只通过本对象暴露的 `state` / `ensureLoaded` /
 * `persist` 改盘，绝不自己碰文件。否则 writeBlock（坏文件拒绝覆写）与
 * writeChain（并发写序）这两道保护会被绕开，而它们正是「坏 JSON 降级后被
 * 空状态覆盖」与「并发写让旧快照赢掉新快照」两个事故修出来的。
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  DisabledSkill,
  HubConfig,
  MarketSourceRecord,
  MarketStatsSnapshot,
  SkillStatsCheckpoint,
  SkillTag,
  SourceRecord,
  TrashEntry,
} from '../protocol.ts'
import { StoreError } from './errors.ts'
import { hydrateMigratedState, migrateStore } from './migrate.ts'
import { DEFAULT_SCENE_NAME, STORE_VERSION, statePath, type StoreFile } from './paths.ts'

/** 内存中的 sidecar 状态。字段与 `StoreFile` 一一对应，便于对照。 */
export interface StoreState {
  entries: Map<string, DisabledSkill>
  config: Partial<HubConfig>
  tagsById: Map<string, SkillTag>
  sourcesByRepo: Map<string, SourceRecord>
  marketSources: MarketSourceRecord[]
  trashByPath: Map<string, TrashEntry>
  skillStats: SkillStatsCheckpoint | undefined
  marketStats: MarketStatsSnapshot | undefined
  collectionOrder: string[]
  sourceGroupOrder: string[]
  /**
   * 模型调用覆盖：发现文件绝对路径集合。
   * 用 Set 是为了让 add/remove 的幂等判定 O(1)，落盘时转数组。
   */
  invocationOverrides: Set<string>
}

/** 领域 slice 能看到的全部能力。 */
export interface StoreCore {
  readonly file: string
  readonly state: StoreState
  /** 首次访问前必须 await；并发冷读共享同一个 Promise。 */
  ensureLoaded(): Promise<void>
  /** 原子落盘（内部串行化）。写入被封锁时抛 conflict。 */
  persist(): Promise<void>
}

/** 空状态构造放在模块级：`createStoreCore` 只留生命周期，字段清单一眼可读。 */
function emptyState(): StoreState {
  return {
    entries: new Map<string, DisabledSkill>(),
    config: {},
    tagsById: new Map<string, SkillTag>(),
    sourcesByRepo: new Map<string, SourceRecord>(),
    marketSources: [],
    trashByPath: new Map<string, TrashEntry>(),
    skillStats: undefined,
    marketStats: undefined,
    collectionOrder: [],
    sourceGroupOrder: [],
    invocationOverrides: new Set<string>(),
  }
}

export function createStoreCore(file: string = statePath()): StoreCore {
  const state = emptyState()
  /** Single-flight load: a second cold read must never mutate an unfilled store. */
  let loading: Promise<void> | null = null
  /**
   * Set when the on-disk state cannot be trusted (unreadable, invalid JSON, or
   * a newer schema). Every write is then refused so the original bytes survive:
   * starting empty and then persisting would irreversibly erase user state.
   */
  let writeBlock: string | null = null
  /** Serializes persist runs: concurrent mutators must not let an earlier
   *  snapshot overwrite a later one (rename is atomic, ordering is not). */
  let writeChain: Promise<void> = Promise.resolve()

  async function ensureLoaded(): Promise<void> {
    if (loading !== null) return loading
    const run = load().catch((error: unknown) => {
      // Let a later caller retry instead of caching a broken load forever.
      loading = null
      throw error
    })
    loading = run
    return run
  }

  /** Back up untrusted sidecar bytes before refusing to write over them. */
  async function backupSidecar(): Promise<void> {
    const backup = `${file}.backup-${Date.now()}`
    await copyFile(file, backup)
    console.warn('[dsh-skill-hub] unreadable sidecar backed up to ' + backup)
  }

  async function load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A fresh install: an empty state is correct and writes are allowed.
        await ensureDefaultTag()
        return
      }
      writeBlock = 'sidecar state is unreadable; refusing to overwrite it (backed up). Upgrade the plugin or restore the backup.'
      await backupSidecar().catch(() => undefined)
      console.warn('[dsh-skill-hub] ' + writeBlock, error instanceof Error ? error.message : error)
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      writeBlock = 'sidecar state is not valid JSON; refusing to overwrite it (backed up). Restore the backup or delete the file to start fresh.'
      await backupSidecar().catch(() => undefined)
      console.warn('[dsh-skill-hub] ' + writeBlock, error instanceof Error ? error.message : error)
      return
    }

    const migrated = migrateStore(parsed)
    if (migrated === null) {
      writeBlock = 'sidecar state uses a newer schema than this plugin supports; refusing to overwrite it (backed up). Upgrade the plugin.'
      await backupSidecar().catch(() => undefined)
      console.warn('[dsh-skill-hub] ' + writeBlock)
      return
    }

    // 用对象字面量 + `satisfies` 收集，而不是逐条 `state.x = ...`：后者看起来
    // 更直白，但**没有任何保护** —— 对象在 emptyState() 里已经初始化，TS 不会
    // 检查「每个字段是否都赋过值」，新增一个持久化字段却忘了在这里赋值，就会
    // 变成「重启后数据静默消失」。字面量缺项时 satisfies 直接报错。
    // invocationOverrides 单独处理：磁盘上是数组，内存里是 Set。
    const hydrated = hydrateMigratedState(migrated)
    const hydratedState = {
      entries: hydrated.entries,
      config: hydrated.config,
      tagsById: hydrated.tagsById,
      sourcesByRepo: hydrated.sourcesByRepo,
      marketSources: hydrated.marketSources,
      trashByPath: hydrated.trashByPath,
      skillStats: hydrated.skillStats,
      marketStats: hydrated.marketStats,
      collectionOrder: hydrated.collectionOrder,
      sourceGroupOrder: hydrated.sourceGroupOrder,
    } satisfies Omit<StoreState, 'invocationOverrides'>
    Object.assign(state, hydratedState)
    state.invocationOverrides = new Set(hydrated.invocationOverrides)
    await ensureDefaultTag()
  }

  /**
   * 保证存在默认角色：没有任何 default 标记的 tag 时创建「通用」。
   * 新技能创建后自动归入它；用户可改名，但默认角色不可删除。
   */
  async function ensureDefaultTag(): Promise<void> {
    if ([...state.tagsById.values()].some((tag) => tag.default === true)) return
    const tag: SkillTag = { id: randomUUID(), name: DEFAULT_SCENE_NAME, skillNames: [], default: true }
    state.tagsById.set(tag.id, tag)
    await persist()
  }

  function persist(): Promise<void> {
    // The payload is built inside the queued step (not here), so every
    // concurrent mutation made before a write actually lands is included in
    // the final file instead of being rolled back by an older snapshot.
    const run = writeChain.then(async () => {
      const payload: StoreFile = {
        version: STORE_VERSION,
        disabled: [...state.entries.values()],
        config: state.config,
        ...(state.tagsById.size > 0 ? { tags: [...state.tagsById.values()] } : {}),
        ...(state.sourcesByRepo.size > 0 ? { sources: [...state.sourcesByRepo.values()] } : {}),
        ...(state.marketSources.length > 0 ? { marketSources: [...state.marketSources] } : {}),
        ...(state.trashByPath.size > 0 ? { trash: [...state.trashByPath.values()] } : {}),
        ...(state.skillStats !== undefined ? { skillStats: state.skillStats } : {}),
        ...(state.marketStats !== undefined ? { marketStats: state.marketStats } : {}),
        ...(state.collectionOrder.length > 0 ? { collectionOrder: [...state.collectionOrder] } : {}),
        ...(state.sourceGroupOrder.length > 0 ? { sourceGroupOrder: [...state.sourceGroupOrder] } : {}),
        ...(state.invocationOverrides.size > 0 ? { invocationOverrides: [...state.invocationOverrides] } : {}),
      }
      if (writeBlock !== null) throw new StoreError('conflict', writeBlock)
      await mkdir(dirname(file), { recursive: true })
      // Random sibling + exclusive create: two instances can never truncate
      // each other's temp file, and a crash never leaves a shared .tmp behind.
      const tmp = `${file}.${randomUUID()}.tmp`
      try {
        const handle = await open(tmp, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(payload, null, 2) + '\n', 'utf8')
        } finally {
          await handle.close()
        }
        await rename(tmp, file)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    // Keep the chain alive on failure; callers still observe the rejection.
    writeChain = run.catch(() => {})
    return run
  }

  // `ensureDefaultTag` 故意不导出：它是加载流程的内部收尾，slice 没有理由
  // 手动补默认角色（那会让「谁保证默认角色存在」出现第二个答案）。
  return { file, state, ensureLoaded, persist }
}
