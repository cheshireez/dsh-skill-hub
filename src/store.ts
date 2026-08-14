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
import type { DisabledSkill, WritableRoot } from './protocol.ts'

/** Wire shape persisted on disk. */
interface StoreFile {
  version: 1
  disabled: DisabledSkill[]
}

/** Resolve the DSH home directory (the filesystem provider's user-dsh root base). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Resolve the sidecar state path (injectable in tests). */
export function statePath(home = dshHome()): string {
  return join(home, 'dsh-skill-hub.json')
}

/** Sidecar state owner. */
export class SkillHubStore {
  private entries = new Map<string, DisabledSkill>()
  private loaded = false

  constructor(private readonly file: string = statePath()) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as StoreFile).disabled)) {
        for (const entry of (parsed as StoreFile).disabled) {
          if (typeof entry?.name === 'string' && typeof entry?.path === 'string') {
            this.entries.set(entry.name, entry)
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

  private async persist(): Promise<void> {
    const payload: StoreFile = {
      version: 1,
      disabled: [...this.entries.values()],
    }
    const tmp = this.file + '.tmp'
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }
}

