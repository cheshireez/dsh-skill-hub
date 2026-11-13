/**
 * 上游来源记录（一个 repo 恰一行）。
 *
 * 这行的职责是「让下一次检查知道拿什么比对」：`ref` + `commitSha` 是版本基线，
 * `skills[]` 是归属，`localHashes` 是「用户改过 vs 上游动了」的唯一判据，
 * `manifest` 是文件级增量基线。
 */
import type { SourceRecord } from '../protocol.ts'
import { skillDirPrefix } from '../repo/discovery.ts'
import type { StoreCore } from './core.ts'

export interface SourceSlice {
  /** All source records, sorted by repo. */
  listSources(): Promise<SourceRecord[]>
  /** One source record by repo (undefined when absent). */
  getSource(repo: string): Promise<SourceRecord | undefined>
  /** The source record that tracks a skill name (undefined when untracked). */
  getSourceForSkill(name: string): Promise<SourceRecord | undefined>
  /** Remove a source record entirely (no-op when absent). */
  deleteSource(repo: string): Promise<void>
  /** Record one imported skill in its repo-level source row. */
  addSourceSkill(repo: string, root: string, commitSha: string, ref: string | undefined, skillName: string): Promise<void>
  /** Replace a source's skill list (used after sync/confirm-delete). */
  setSourceSkills(repo: string, skills: readonly string[]): Promise<SourceRecord | undefined>
  /** Remove one skill from every source record (used when the skill is deleted). */
  removeSkillFromSources(name: string): Promise<void>
  /** Update a source's commit snapshot. */
  setSourceCommit(repo: string, commitSha: string): Promise<void>
  /** Record one skill's local content hash (sampled right after the bytes land). */
  setSourceSkillHash(repo: string, skillName: string, hash: string): Promise<void>
  /** Update a source's pinned ref (release tag / branch) when the market syncs. */
  setSourceRef(repo: string, ref: string): Promise<void>
  /** Merge per-path manifest entries into a source (incremental imports). */
  mergeSourceManifest(repo: string, manifest: Record<string, number>, dir?: string): Promise<void>
  /** skillName → collection name for every recorded origin (derived from sources). */
  listOrigins(): Promise<Record<string, string>>
}

export function sourceSlice(core: StoreCore): SourceSlice {
  const { state } = core
  return {
    async listSources(): Promise<SourceRecord[]> {
      await core.ensureLoaded()
      return [...state.sourcesByRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo))
    },

    async getSource(repo: string): Promise<SourceRecord | undefined> {
      await core.ensureLoaded()
      return state.sourcesByRepo.get(repo)
    },

    async getSourceForSkill(name: string): Promise<SourceRecord | undefined> {
      await core.ensureLoaded()
      for (const source of state.sourcesByRepo.values()) {
        if (source.skills.includes(name)) return source
      }
      return undefined
    },

    async deleteSource(repo: string): Promise<void> {
      await core.ensureLoaded()
      if (!state.sourcesByRepo.delete(repo)) return
      await core.persist()
    },

    /**
     * Record one imported skill in its repo-level source row.
     *
     * A repo owns exactly one source row, hence one pinned ref, so a later import
     * must re-pin it: keeping the first import's `ref` / `commitSha` makes
     * `sources/check` compare against a stale sha and `sources/sync` re-download
     * the old ref over content that was imported from a tag — the "pinning a tag
     * means nothing" failure of issue #15, reached through the bookkeeping
     * instead of the download. An absent `ref` means the import ran on the
     * default branch, which clears the pin rather than silently keeping it.
     */
    async addSourceSkill(repo: string, root: string, commitSha: string, ref: string | undefined, skillName: string): Promise<void> {
      await core.ensureLoaded()
      const existing = state.sourcesByRepo.get(repo)
      if (existing === undefined) {
        state.sourcesByRepo.set(repo, {
          repo,
          ...(ref !== undefined && ref !== '' ? { ref } : {}),
          root,
          commitSha,
          skills: [skillName],
        })
      } else {
        const skills = existing.skills.includes(skillName) ? existing.skills : [...existing.skills, skillName].sort((a, b) => a.localeCompare(b))
        const next: SourceRecord = { ...existing, skills }
        if (ref !== undefined && ref !== '') next.ref = ref
        else delete next.ref
        if (commitSha !== '') next.commitSha = commitSha
        state.sourcesByRepo.set(repo, next)
      }
      await core.persist()
    },

    async setSourceSkills(repo: string, skills: readonly string[]): Promise<SourceRecord | undefined> {
      await core.ensureLoaded()
      const existing = state.sourcesByRepo.get(repo)
      if (existing === undefined) return undefined
      const names = [...new Set(skills.filter((n) => n.trim() !== ''))].sort((a, b) => a.localeCompare(b))
      if (names.length === 0) {
        state.sourcesByRepo.delete(repo)
      } else {
        const next: SourceRecord = { ...existing, skills: names }
        // 被移出来源的技能不该留着哈希：下次同名导入会拿旧哈希比对，误报「本地已改」。
        if (existing.localHashes !== undefined) {
          const localHashes: Record<string, string> = {}
          for (const name of names) {
            const hash = existing.localHashes[name]
            if (hash !== undefined) localHashes[name] = hash
          }
          if (Object.keys(localHashes).length > 0) next.localHashes = localHashes
          else delete next.localHashes
        }
        state.sourcesByRepo.set(repo, next)
      }
      await core.persist()
      return state.sourcesByRepo.get(repo)
    },

    async removeSkillFromSources(name: string): Promise<void> {
      await core.ensureLoaded()
      let changed = false
      for (const [repo, source] of state.sourcesByRepo) {
        if (!source.skills.includes(name)) continue
        const skills = source.skills.filter((n) => n !== name)
        if (skills.length === 0) {
          state.sourcesByRepo.delete(repo)
        } else {
          // 名字没了，哈希也没有意义；留着会让同名技能下次导入时被误判成「已改」。
          const localHashes: Record<string, string> = {}
          for (const [key, value] of Object.entries(source.localHashes ?? {})) if (key !== name) localHashes[key] = value
          const next: SourceRecord = { ...source, skills }
          if (Object.keys(localHashes).length > 0) next.localHashes = localHashes
          else delete next.localHashes
          state.sourcesByRepo.set(repo, next)
        }
        changed = true
      }
      if (changed) await core.persist()
    },

    async setSourceCommit(repo: string, commitSha: string): Promise<void> {
      await core.ensureLoaded()
      const existing = state.sourcesByRepo.get(repo)
      if (existing === undefined) return
      state.sourcesByRepo.set(repo, { ...existing, commitSha })
      await core.persist()
    },

    /**
     * Record one skill's local content hash (sampled right after the bytes land).
     * This is the only thing that can tell "the user edited this" apart from
     * "upstream moved", so it is written on every import and every sync.
     */
    async setSourceSkillHash(repo: string, skillName: string, hash: string): Promise<void> {
      await core.ensureLoaded()
      const existing = state.sourcesByRepo.get(repo)
      if (existing === undefined || hash === '') return
      state.sourcesByRepo.set(repo, { ...existing, localHashes: { ...(existing.localHashes ?? {}), [skillName]: hash } })
      await core.persist()
    },

    async setSourceRef(repo: string, ref: string): Promise<void> {
      await core.ensureLoaded()
      const existing = state.sourcesByRepo.get(repo)
      if (existing === undefined || ref.trim() === '') return
      state.sourcesByRepo.set(repo, { ...existing, ref: ref.trim() })
      await core.persist()
    },

    /**
     * Merge per-path manifest entries into a source (incremental imports).
     * When `dir` is given, every baseline path under that skill directory is
     * dropped first, so files the upstream removed never linger in the
     * baseline and skew later update diffs.
     *
     * `dir` may be '' — a skill whose SKILL.md sits at the repo root. Its prefix
     * is empty, so the whole baseline is replaced: that skill owns the tree, and
     * keeping stale paths would make every later diff report "changed" forever.
     */
    async mergeSourceManifest(repo: string, manifest: Record<string, number>, dir?: string): Promise<void> {
      await core.ensureLoaded()
      const existing = state.sourcesByRepo.get(repo)
      if (existing === undefined || Object.keys(manifest).length === 0) return
      const base: Record<string, number> = { ...(existing.manifest ?? {}) }
      if (dir !== undefined) {
        const prefix = skillDirPrefix(dir)
        for (const path of Object.keys(base)) {
          if (path.startsWith(prefix)) delete base[path]
        }
      }
      state.sourcesByRepo.set(repo, { ...existing, manifest: { ...base, ...manifest } })
      await core.persist()
    },

    async listOrigins(): Promise<Record<string, string>> {
      await core.ensureLoaded()
      const origins: Record<string, string> = {}
      for (const source of state.sourcesByRepo.values()) {
        for (const name of source.skills) origins[name] = source.repo
      }
      return origins
    },
  }
}
