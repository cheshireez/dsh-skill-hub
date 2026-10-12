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
 */

import { readFile, stat } from 'node:fs/promises'
import type { DisabledSkill } from './protocol.ts'
import { disabledOccupancyIn, parseFrontmatter, rootPath, scanDisabledRoot, WRITABLE_ROOTS } from './skillfs.ts'
import { dshHome } from './store.ts'

/** Narrow store view used by the reconcile (SkillHubStore satisfies it). */
export interface DisabledReconcileStore {
  listDisabled(): Promise<DisabledSkill[]>
  addDisabled(entry: DisabledSkill): Promise<void>
}

/** Narrow store view used by the reverse reconcile (adds record removal). */
export interface DisabledPruneStore extends DisabledReconcileStore {
  removeDisabled(name: string): Promise<void>
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
