/**
 * 来源跟踪域路由：sources 列表 / check 上游更新 / sync 同步 / delete 跟进
 * 删除 / restore 恢复 / trash/clear 清空回收站。从 routes.ts 原样搬出，
 * handler 逻辑不变。
 */

import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import {
  SKILL_HUB_API,
  type CollectionGroup,
  type SourceCheckRequest,
  type SourceCheckResponse,
  type SourceCheckResult,
  type SourceDeleteRequest,
  type SourceDeleteResponse,
  type SourceRestoreRequest,
  type SourceRestoreResponse,
  type SourceSyncRequest,
  type SourceSyncResponse,
  type SourcesResponse,
  type SourceTrashClearResponse,
} from '../protocol.ts'
import {
  collectRepoSkillFiles,
  diffRemoteSkills,
  downloadRepoSkill,
  getLatestCommit,
  loadRepoTreeAt,
  normalizeRepoInput,
  repoSkillEntry,
  repoSlug,
  skillDirOf,
  skillManifest,
} from '../repo.ts'
import { clearTrash, restoreSkill, rootOfPath, rootPath, trashSkill } from '../skillfs.ts'
import {
  homeOf,
  pathExists,
  writeError,
  writeJson,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'
import { MIN_CHECK_INTERVAL_MS, lastSourceCheck, replaceSkillDir } from './route-state.ts'

/** 来源跟踪域全部路由 spec（由 routes.ts 经 createRoute 包上统一围栏）。 */
export function sourceRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // ------------------------------------------------------------- sources
    // 来源列表 + 派生 origin 映射 + 集合组 + 回收站。
    {
      path: SKILL_HUB_API.sources,
      methods: ['GET'],
      handler: async ({ res }) => {
        const [sources, origins, trash, collectionOrder] = await Promise.all([deps.store.listSources(), deps.store.listOrigins(), deps.store.listTrash(), deps.store.getCollectionOrder()])
        const byCollection = new Map<string, string[]>()
        for (const [skillName, origin] of Object.entries(origins)) {
          const list = byCollection.get(origin)
          if (list === undefined) byCollection.set(origin, [skillName])
          else list.push(skillName)
        }
        const orderIndex = new Map(collectionOrder.map((name, i) => [name, i] as const))
        const collections: CollectionGroup[] = [...byCollection.entries()]
          .map(([name, skillNames]) => ({ name, skillNames: [...skillNames].sort((a, b) => a.localeCompare(b)) }))
          .sort((a, b) => {
            const ai = orderIndex.has(a.name) ? orderIndex.get(a.name)! : Infinity
            const bi = orderIndex.has(b.name) ? orderIndex.get(b.name)! : Infinity
            if (ai !== bi) return ai - bi
            return a.name.localeCompare(b.name)
          })
        writeJson(res, 200, { ok: true, sources, origins, collections, trash } satisfies SourcesResponse)
      },
    },
    // -------------------------------------------------------- sources/check
    // 检查指定（或全部）来源的上游更新。每个来源最多 1 次 commit 请求；
    // 仅当 commit 变化时再拉一次 tree 做逐技能差异。5 分钟节流。
    {
      path: SKILL_HUB_API.sourceCheck,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceCheckRequest
        let only: string | undefined
        if (typeof request.repo === 'string' && request.repo !== '') {
          // Normalize URLs/slugs the same way every other route does, so a
          // check for "https://github.com/a/b" finds the "a/b" record.
          const parsedOnly = normalizeRepoInput(request.repo)
          only = parsedOnly !== null ? repoSlug(parsedOnly) : undefined
        }
        const source = only !== undefined ? await deps.store.getSource(only) : undefined
        if (only !== undefined && source === undefined) { writeError(res, 404, 'source not found: ' + only); return }
        const sources = source !== undefined ? [source] : await deps.store.listSources()
        if (lastSourceCheck.size > 500) lastSourceCheck.clear()
        const results: SourceCheckResult[] = []
        for (const item of sources) {
          const base = { repo: item.repo, ...(item.ref !== undefined ? { ref: item.ref } : {}) }
          const now = Date.now()
          const last = lastSourceCheck.get(item.repo) ?? 0
          if (now - last < MIN_CHECK_INTERVAL_MS) {
            results.push({ ...base, changed: false, updated: [], deleted: [], throttled: true })
            continue
          }
          try {
            const latest = await getLatestCommit(item.repo, item.ref)
            lastSourceCheck.set(item.repo, now)
            if (item.commitSha === '') {
              // Migrated/legacy record without a snapshot: backfill the
              // commit now and report "unverified" instead of claiming every
              // skill is updated (there is no baseline to diff against yet).
              await deps.store.setSourceCommit(item.repo, latest.commitSha)
              results.push({ ...base, changed: false, updated: [], deleted: [], unverified: true, commitSha: latest.commitSha })
              continue
            }
            if (latest.commitSha === item.commitSha) {
              results.push({ ...base, changed: false, updated: [], deleted: [] })
              continue
            }
            const tree = await loadRepoTreeAt(item.repo, latest.treeSha)
            const diff = diffRemoteSkills(tree, item)
            results.push({ ...base, changed: true, commitSha: latest.commitSha, updated: diff.updated, deleted: diff.deleted })
          } catch (error) {
            results.push({ ...base, changed: false, updated: [], deleted: [], error: error instanceof Error ? error.message : String(error) })
          }
        }
        writeJson(res, 200, { ok: true, results } satisfies SourceCheckResponse)
      },
    },
    // --------------------------------------------------------- sources/sync
    // 按上游重新下载所选（或全部）技能并更新 commit 快照与 manifest。
    {
      path: SKILL_HUB_API.sourceSync,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceSyncRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        const selected = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : undefined
        const source = await deps.store.getSource(repo)
        if (source === undefined) { writeError(res, 404, 'source not found: ' + repo); return }
        const targets = selected !== undefined ? selected : source.skills
        const latest = await getLatestCommit(repo, source.ref)
        const tree = await loadRepoTreeAt(repo, latest.treeSha)
        const targetRoot = rootPath('user-dsh', homeOf(deps))
        await mkdir(targetRoot, { recursive: true })
        const synced: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        for (const name of targets) {
          // Sync writes under the user root: only accept real skill names
          // this source actually tracks (a bare join would otherwise fold
          // `..` segments out of the writable root).
          if (!isSkillName(name) || !source.skills.includes(name)) {
            failed.push({ name, error: 'skill is not tracked by this source' })
            continue
          }
          try {
            const entry = repoSkillEntry(name, source.root, repo)
            // 上游可能用分类子目录（skills/engineering/<name>/）且目录会移动：
            // 先在上游 tree 里搜真实位置，manifest 兜底，否则嵌套技能会 404。
            entry.dir = skillDirOf(source, name, tree.map((item) => item.path))
            entry.path = entry.dir + '/SKILL.md'
            const files = collectRepoSkillFiles(tree, entry.dir)
            if (files.length === 0) { failed.push({ name, error: 'skill missing upstream' }); continue }
            const targetDir = join(targetRoot, name)
            const wasDisabled = (await deps.store.getDisabled(name)) !== undefined
            if (await pathExists(targetDir)) {
              await replaceSkillDir(targetDir, async () => {
                await downloadRepoSkill(repo, latest.commitSha, entry, files, targetRoot)
              })
            } else {
              await downloadRepoSkill(repo, latest.commitSha, entry, files, targetRoot)
            }
            if (wasDisabled) {
              // Preserve the disabled state: the fresh SKILL.md must not
              // re-enter discovery.
              await rename(join(targetDir, 'SKILL.md'), join(targetDir, 'SKILL.md.disabled'))
            } else {
              await deps.store.removeDisabled(name)
            }
            await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir)
            synced.push(name)
          } catch (error) {
            failed.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        // Only advance the commit snapshot when every skill landed: a failed
        // sync keeps the old commit, so the next check still diffs the tree
        // and re-reports the missing skills instead of silently hiding them.
        if (failed.length === 0) {
          await deps.store.setSourceCommit(repo, latest.commitSha)
        }
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, repo, commitSha: latest.commitSha, synced, failed } satisfies SourceSyncResponse)
      },
    },
    // ------------------------------------------------------- sources/delete
    // 跟进上游删除：把所选技能的本地目录移入回收站（可恢复）。
    {
      path: SKILL_HUB_API.sourceDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceDeleteRequest
        const repo = typeof request.repo === 'string' ? request.repo.trim() : ''
        const skills = Array.isArray(request.skills) ? request.skills.filter((n): n is string => typeof n === 'string' && n !== '') : []
        if (repo === '') { writeError(res, 400, 'repo is required'); return }
        if (skills.length === 0) { writeError(res, 400, 'skills must be a non-empty array'); return }
        const source = await deps.store.getSource(repo)
        if (source === undefined) { writeError(res, 404, 'source not found: ' + repo); return }
        const home = homeOf(deps)
        const trashed: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        const sourceNames = new Set(source.skills)
        for (const name of skills) {
          // Every name must be a real kebab-case skill that this source
          // actually tracks; anything else must never touch the filesystem
          // (a bare `join` would otherwise fold `..` segments out of the
          // writable root — see the path-containment assert below).
          if (!isSkillName(name) || !sourceNames.has(name)) {
            failed.push({ name, error: 'skill is not tracked by this source' })
            continue
          }
          const sourcePath = join(rootPath('user-dsh', home), name)
          if (rootOfPath(sourcePath, home) === undefined) {
            failed.push({ name, error: 'skill path is outside the hub writable roots' })
            continue
          }
          if (!await pathExists(sourcePath)) {
            failed.push({ name, error: 'skill directory not found' })
            continue
          }
          try {
            // 入回收站前快照来源与场景归属，恢复时挂回（见 sourceRestore）。
            const tagIds = (await deps.store.listTags()).filter((tag) => tag.skillNames.includes(name)).map((tag) => tag.id)
            const { path } = await trashSkill(sourcePath)
            await deps.store.addTrash({
              name,
              path,
              movedAt: Date.now(),
              sourcePath,
              origin: { repo: source.repo, root: source.root, ...(source.ref !== undefined && source.ref !== '' ? { ref: source.ref } : {}), commitSha: source.commitSha },
              ...(tagIds.length > 0 ? { tagIds } : {}),
            })
            await deps.store.removeDisabled(name)
            await deps.store.removeSkillFromTags(name)
            trashed.push(name)
          } catch (error) {
            failed.push({ name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (trashed.length > 0) {
          await deps.store.setSourceSkills(repo, source.skills.filter((n) => !trashed.includes(n)))
          deps.invalidate?.()
        }
        writeJson(res, 200, { ok: true, trashed, failed } satisfies SourceDeleteResponse)
      },
    },
    // ------------------------------------------------------ sources/restore
    // 从回收站恢复一个技能目录。
    {
      path: SKILL_HUB_API.sourceRestore,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as SourceRestoreRequest
        const name = typeof request.name === 'string' ? request.name : ''
        if (name === '') { writeError(res, 400, 'name is required'); return }
        const entry = await deps.store.getTrash(name)
        if (entry === undefined) { writeError(res, 404, 'trash entry not found: ' + name); return }
        const home = homeOf(deps)
        const target = entry.sourcePath ?? join(rootPath('user-dsh', home), name)
        if (await pathExists(target)) {
          writeError(res, 409, 'skill already exists: ' + name)
          return
        }
        const path = await restoreSkill(entry, home)
        // 恢复来源归属（入回收站前快照的来源记录）与场景成员，否则恢复后
        // 的技能会变成「个人技能」并脱离原场景。
        if (entry.origin !== undefined) {
          await deps.store.addSourceSkill(entry.origin.repo, entry.origin.root, entry.origin.commitSha, entry.origin.ref, name)
        }
        for (const tagId of entry.tagIds ?? []) {
          await deps.store.addSkillToTag(tagId, name)
        }
        await deps.store.removeTrash(name)
        deps.invalidate?.()
        writeJson(res, 200, { ok: true, name, path } satisfies SourceRestoreResponse)
      },
    },
    // ------------------------------------------------- sources/trash/clear
    // 清空回收站：永久删除 .trash 里的技能，失败项保留可重试。
    {
      path: SKILL_HUB_API.sourceTrashClear,
      methods: ['POST'],
      handler: async ({ res }) => {
        const home = homeOf(deps)
        const entries = await deps.store.listTrash()
        const deleted: string[] = []
        const failed: Array<{ name: string; error: string }> = []
        for (const entry of entries) {
          try {
            await clearTrash(entry, home)
            // A permanently deleted skill must not linger in user groups.
            await deps.store.removeSkillFromTags(entry.name)
            deleted.push(entry.name)
          } catch (error) {
            failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
          }
        }
        for (const name of deleted) await deps.store.removeTrash(name)
        if (deleted.length > 0) deps.invalidate?.()
        writeJson(res, 200, { ok: true, deleted, failed } satisfies SourceTrashClearResponse)
      },
    },
  ]
}
