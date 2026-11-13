/**
 * Sidecar reconcile for hub-disabled skills.
 *
 * The catalog merges two sources: enabled skills come from the provider
 * (SKILL.md discovery), disabled skills come from the sidecar's `disabled`
 * records. The two can drift — a sidecar restored from a backup, a hand
 * edit, or an older build can leave a `SKILL.md.disabled` file on disk with
 * no record, which makes the skill invisible in every view (it is neither
 * enabled nor disabled) and leaves its origin collection rendering as an
 * empty shell. This walk rebuilds the missing records from disk at startup.
 *
 * 启动对账的范围与判据（扩范围前先读这段）：
 * - `disabled` 台账：双向都做 —— 补缺失记录、修路径、删死记录。
 * - `trash`：只做反向（记录在、条目不在 → 删记录），见 `pruneStaleTrash`。
 * - `sources`：**不做自动清理**。判断「某个 skills[] 名字是否还有效」需要
 *   全量 catalog，而启动时工作区可能尚未挂载 —— 按「扫不到就删」会把用户
 *   的来源归属和 `localHashes` 基线删掉，下次导入变成「本地已改」。这项
 *   清理已有正确时机：删除技能时走 `removeSkillFromSources`。
 * - `invocationOverrides`：**不做启动清理**。覆盖的语义是「这个发现文件不要自动
 *   调用」，文件暂时不存在时它是惰性的；用户恢复同一路径的文件时，那条覆盖
 *   正是他当初的意图。按「文件不在就删」会让技能在恢复文件后悄悄复活。
 *   （事件驱动的清理是另一回事：`retireNamePlaceholders` 替换占位时会清掉指向
 *   该发现文件的覆盖 —— 那时文件确实被移走了，留着会让新落地的同名技能继承
 *   幽灵停用。两处判据不同，别合并。）
 */

import { readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { DisabledSkill, TrashEntry } from './protocol.ts'
import { disabledOccupancyIn, parseFrontmatter, rootPath, scanDisabledRoot, WRITABLE_ROOTS } from './skillfs.ts'
import { dshHome } from './store/paths.ts'

/** Narrow store view used by the reconcile (SkillHubStore satisfies it). */
export interface DisabledReconcileStore {
  listDisabled(): Promise<DisabledSkill[]>
  addDisabled(entry: DisabledSkill): Promise<void>
}

/** Narrow store view used by the reverse reconcile (adds record removal). */
export interface DisabledPruneStore extends DisabledReconcileStore {
  removeDisabled(name: string): Promise<void>
}

/** Narrow store view used by the trash reconcile. */
export interface TrashReconcileStore {
  listTrash(): Promise<TrashEntry[]>
  removeTrash(path: string): Promise<void>
}

/**
 * Add sidecar disabled records for every `.disabled` discovery file that has
 * none yet. Existing records (matched by path or by name) win, so this never
 * rewrites user data; unreadable or invalid files are skipped (they surface
 * in the diagnostics scan instead). Returns the records added.
 */
export async function reconcileDisabledSkills(store: DisabledReconcileStore, home = dshHome()): Promise<DisabledSkill[]> {
  const known = await store.listDisabled()
  const knownNames = new Set(known.map((entry) => entry.name))
  const knownPaths = new Set(known.map((entry) => entry.path))
  const added: DisabledSkill[] = []
  for (const root of WRITABLE_ROOTS) {
    for (const path of await scanDisabledRoot(rootPath(root, home))) {
      if (knownPaths.has(path)) continue
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch {
        continue
      }
      const parsed = parseFrontmatter(text)
      if ('error' in parsed) continue
      const { name, description } = parsed.value
      if (knownNames.has(name)) continue
      let disabledAt = 0
      try {
        disabledAt = (await stat(path)).mtimeMs
      } catch {
        continue // 扫描途中被删除
      }
      const record: DisabledSkill = { name, description, path, root, disabledAt }
      await store.addDisabled(record)
      knownNames.add(name)
      knownPaths.add(path)
      added.push(record)
    }
  }
  return added
}

/** 反向对账的结果：修好路径的记录 + 被清掉的死记录。 */
export interface DisabledPruneResult {
  /** 记录还在、但 path 指向的文件已不在：已改指向现存的 `.disabled` 文件。 */
  repaired: DisabledSkill[]
  /** 文件与禁用占位都已不存在：记录已删除，名字被释放。 */
  removed: string[]
}

/**
 * 反向对账：`reconcileDisabledSkills` 只处理「磁盘有 `.disabled`、sidecar 没记录」。
 * 反方向（sidecar 有记录、磁盘上那个文件已经不在了）以前永不清理，于是留下一条
 * 干掉不掉的记录：`/toggle` 启用会 rename 失败，`/create` 被 409 挡住，`/skill/delete`
 * 也 rename 失败 —— 名字被永久锁死（issue #16 类，实测 G5）。
 *
 * 两种处理，都不动启用态技能：
 * - 名字在该 root 下仍有 `.disabled` 占位（目录包或扁平形态）→ 把记录指向真实文件；
 * - 一个都没有 → 删记录，把名字还给用户。
 *
 * 只处理合法可写 root 的记录；root 值异常（历史损坏数据）时原样保留，不擅自删。
 */
export async function pruneStaleDisabledSkills(store: DisabledPruneStore, home = dshHome()): Promise<DisabledPruneResult> {
  const result: DisabledPruneResult = { repaired: [], removed: [] }
  for (const record of await store.listDisabled()) {
    let exists = false
    try {
      exists = (await stat(record.path)).isFile()
    } catch {
      exists = false
    }
    if (exists) continue
    if (!WRITABLE_ROOTS.includes(record.root)) continue
    const occupancy = await disabledOccupancyIn(rootPath(record.root, home), record.name)
    if (occupancy === undefined) {
      await store.removeDisabled(record.name)
      result.removed.push(record.name)
      continue
    }
    const repaired: DisabledSkill = { ...record, path: occupancy }
    await store.addDisabled(repaired)
    result.repaired.push(repaired)
  }
  return result
}

/**
 * 回收站对账：记录还在、它指向的条目已经不在磁盘上，就把记录清掉。
 *
 * 什么时候会出现这种孤儿：用户手动清了 `.trash` 目录、外部同步工具重建了
 * 技能目录、或从备份恢复 sidecar 时目录没跟着回来。不清的后果是两条撤销
 * 路径表现不一致 —— `restoreSkill` 走 `rename` 直接 ENOENT 报错，而
 * `clearTrash` 因为 `rm --force` 反而「成功」，用户点恢复永远失败。
 *
 * 判据（宁可不删，不可错删）：
 * - 只有 `ENOENT` / `ENOTDIR` 算「不存在」。`EACCES` / `EIO` / 挂载点抖动
 *   一律**保留记录**：磁盘暂时读不到不等于用户删了，按「读不到就删」会把
 *   整份回收站记录清空，那才是真的数据丢失；
 * - 只处理 `<某处>/.trash/<name>` 形态的记录，非法路径原样保留（与
 *   `pruneStaleDisabledSkills` 对异常 root 的处理一致）。
 *
 * 只删**记录**，不碰磁盘：目录已经不在，这里没有任何可删的实体。
 */
export async function pruneStaleTrash(store: TrashReconcileStore): Promise<TrashEntry[]> {
  const removed: TrashEntry[] = []
  for (const entry of await store.listTrash()) {
    if (basename(dirname(entry.path)) !== '.trash') continue
    let gone = false
    try {
      await stat(entry.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      gone = code === 'ENOENT' || code === 'ENOTDIR'
    }
    if (!gone) continue
    await store.removeTrash(entry.path)
    removed.push(entry)
  }
  return removed
}

/** 一次性迁移所需的 store 视图：策略写入 + 台账读写。 */
export interface DisabledMigrationStore extends DisabledReconcileStore {
  addInvocationOverride(path: string): Promise<void>
}

/**
 * 第一轮重构的一次性迁移：把 rename 时代留下的 *.disabled 文件改回启用态文件名，
 * 并把「停用」这件事从磁盘形态搬到策略（invocationOverrides + sidecar 台账）。
 *
 * 必须在 reconcileDisabledSkills / pruneStaleDisabledSkills **之前**跑：迁移后磁盘
 * 上不再有 .disabled 文件，两条旧对账自然不再补记录；台账 path 改指向仍存在的
 * SKILL.md，反向对账也不会误删。幂等：第二次启动扫描为空，什么也不做。
 *
 * 同名两形态（SKILL.md 与 SKILL.md.disabled 同时存在）时**不覆盖**启用件，只把
 * 策略挂上去，避免搬移时丢掉用户真正启用的那份。
 */
export async function migrateRenamedDisabledSkills(store: DisabledMigrationStore, home = dshHome()): Promise<string[]> {
  const byPath = new Map((await store.listDisabled()).map((entry) => [entry.path, entry]))
  const migrated: string[] = []
  for (const root of WRITABLE_ROOTS) {
    for (const disabledPath of await scanDisabledRoot(rootPath(root, home))) {
      const enabledPath = disabledPath.slice(0, -'.disabled'.length)
      const policyPath = resolve(enabledPath)
      let exists = false
      try {
        exists = (await stat(enabledPath)).isFile()
      } catch {
        exists = false
      }
      if (!exists) {
        try {
          await rename(disabledPath, enabledPath)
        } catch {
          continue
        }
      }
      await store.addInvocationOverride(policyPath)
      const record = byPath.get(disabledPath)
      if (record !== undefined) {
        await store.addDisabled({ ...record, path: policyPath })
      } else {
        // 孤儿 .disabled（sidecar 被恢复过）：补一条台账，否则技能会变回启用态。
        const name = basename(enabledPath) === 'SKILL.md' ? basename(dirname(enabledPath)) : basename(enabledPath, '.md')
        const text = await readFile(enabledPath, 'utf8').catch(() => '')
        const parsed = parseFrontmatter(text)
        await store.addDisabled({
          name,
          description: 'error' in parsed ? '' : parsed.value.description,
          path: policyPath,
          root,
          disabledAt: Date.now(),
        })
      }
      migrated.push(enabledPath)
    }
  }
  return migrated
}
