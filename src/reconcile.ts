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
import { parseFrontmatter, rootPath, scanDisabledRoot, WRITABLE_ROOTS } from './skillfs.ts'
import { dshHome } from './store.ts'

/** Narrow store view used by the reconcile (SkillHubStore satisfies it). */
export interface DisabledReconcileStore {
  listDisabled(): Promise<DisabledSkill[]>
  addDisabled(entry: DisabledSkill): Promise<void>
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
