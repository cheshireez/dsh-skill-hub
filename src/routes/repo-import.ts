/**
 * 仓库导入域路由：repo 发现 / repoImport 异步导入任务 / progress 轮询 /
 * cancel 取消。从 routes.ts 原样搬出，handler 逻辑不变。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  SKILL_HUB_API,
  type RepoDiscoverResponse,
  type RepoImportCancelRequest,
  type RepoImportCancelResponse,
  type RepoImportProgressResponse,
  type RepoImportRequest,
  type RepoImportResponse,
} from '../protocol.ts'
import {
  cleanupLeftoverImportDirs,
  collectRepoSkillFiles,
  discoverRepoEntries,
  downloadRepoSkill,
  getLatestCommit,
  getLatestReleaseTag,
  isAbortError,
  listRepoBranches,
  loadRepoTree,
  normalizeRepoInput,
  repoSlug,
  skillManifest,
} from '../repo.ts'
import { rootPath } from '../skillfs.ts'
import {
  homeOf,
  knownSkillNames,
  pathExists,
  queryParam,
  writeError,
  writeJson,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'
import { gcImportJobs, importJobs, type ImportJob } from './route-state.ts'

/** 仓库导入域全部路由 spec（由 routes.ts 经 createRoute 包上统一围栏）。 */
export function repoImportRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // ---------------------------------------------------------------- repo
    // Discover importable skills in a public GitHub repo (any top-level root containing SKILL.md).
    {
      path: SKILL_HUB_API.repo,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const input = queryParam(url, 'repo') ?? ''
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        // Version resolution: explicit @ref wins; then the market source's
        // pinned ref (branch picked earlier); then the latest release;
        // a repo without releases must be pinned to a branch by the user
        // (branches returned, ref null).
        let ref = parsed.ref
        if (ref === undefined || ref === '') {
          const pinned = await deps.store.getMarketSource(repo)
          if (pinned?.ref !== undefined && pinned.ref !== '') {
            ref = pinned.ref
          }
        }
        if (ref === undefined || ref === '') {
          const releaseTag = await getLatestReleaseTag(repo)
          if (releaseTag !== undefined) {
            ref = releaseTag
            // Auto-pin an existing but unpinned market source to the resolved
            // release, so the row shows the tracked version from the first scan.
            const existing = await deps.store.getMarketSource(repo)
            if (existing !== undefined && (existing.ref === undefined || existing.ref === '')) {
              await deps.store.setMarketSourceRef(repo, releaseTag)
            }
          } else {
            const branches = await listRepoBranches(repo)
            if (branches.length === 0) { writeError(res, 404, 'repo has no branches to scan'); return }
            writeJson(res, 200, { ok: true, repo, ref: null, branches, entries: [] } satisfies RepoDiscoverResponse)
            return
          }
        }
        const { ref: resolvedRef, tree, truncated } = await loadRepoTree(repo, ref)
        const existing = await knownSkillNames(deps)
        const entries = discoverRepoEntries(tree, repo, existing)
        writeJson(res, 200, { ok: true, repo, ref: resolvedRef, entries, ...(truncated ? { truncated: true } : {}) } satisfies RepoDiscoverResponse)
      },
    },
    // ----------------------------------------------------------- repo/import  B方案 Job
    // Install selected repo skills — now async job (B方案：轮询 + 选项2后台继续)
    // POST returns jobId instantly (<500ms), GET /progress polls for done.
    {
      path: SKILL_HUB_API.repoImport,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as RepoImportRequest
        const input = typeof request.repo === 'string' ? request.repo.trim() : ''
        const paths = Array.isArray(request.paths) ? request.paths.filter((path): path is string => typeof path === 'string' && path !== '') : []
        if (paths.length === 0) { writeError(res, 400, 'paths must be a non-empty array'); return }
        const parsed = normalizeRepoInput(input)
        if (parsed === null) { writeError(res, 400, 'repo must be owner/repo or a github.com URL'); return }
        const repo = repoSlug(parsed)
        const ref = typeof request.ref === 'string' && request.ref !== '' ? request.ref : parsed.ref
        const { ref: resolvedRef, tree } = await loadRepoTree(repo, ref)
        const existing = await knownSkillNames(deps)
        const entries = discoverRepoEntries(tree, repo, existing)
        // truncated tree is still usable for the selected paths the user already picked from the prior discover response
        const byPath = new Map(entries.map((entry) => [entry.path, entry]))
        const selected = paths.map((path) => byPath.get(path)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        if (selected.length === 0) { writeError(res, 400, 'no matching skills for selected paths'); return }
        if (selected.length > 500) { writeError(res, 400, 'select at most 500 skills per import'); return }
        const totalBytes = selected.reduce((sum, entry) => sum + entry.totalBytes, 0)
        if (totalBytes > 200 * 1024 * 1024) { writeError(res, 400, 'selected skills exceed the 200MB import limit'); return }

        let commitSha = ''
        try {
          const latest = await getLatestCommit(repo, resolvedRef)
          commitSha = latest.commitSha
        } catch {
          // empty snapshot ok
        }

        const jobId = 'imp_' + randomUUID().slice(0, 8)
        const controller = new AbortController()
        const now = Date.now()
        const job: ImportJob = {
          jobId,
          repo,
          ref: resolvedRef,
          total: selected.length,
          done: 0,
          totalBytes,
          downloadedBytes: 0,
          startTime: now,
          imported: [],
          skipped: [],
          failed: [],
          status: 'running',
          controller,
          createdAt: now,
        }
        gcImportJobs()
        importJobs.set(jobId, job)

        // 启动时顺手清理一次残留临时目录（best-effort，不阻塞响应）
        const targetRootEarly = rootPath('user-dsh', homeOf(deps))
        void cleanupLeftoverImportDirs(targetRootEarly).catch(() => {})

        // 后台执行，不阻塞响应（选项2：关面板也继续跑，唯有 /cancel 才 abort）
        void (async () => {
          const targetRoot = rootPath('user-dsh', homeOf(deps))
          await mkdir(targetRoot, { recursive: true })
          const defaultTag = await deps.store.getDefaultTag()
          let needInvalidate = false
          for (const entry of selected) {
            if (controller.signal.aborted) break
            job.current = entry.name
            job.currentFile = entry.dir + '/SKILL.md'
            if (entry.existing) {
              job.skipped.push({ name: entry.name, reason: 'exists' })
              job.downloadedBytes += entry.totalBytes
              job.done += 1
              continue
            }
            if (await pathExists(join(targetRoot, entry.name))) {
              job.skipped.push({ name: entry.name, reason: 'exists' })
              job.downloadedBytes += entry.totalBytes
              job.done += 1
              continue
            }
            if (controller.signal.aborted) break
            const files = collectRepoSkillFiles(tree, entry.dir)
            try {
              const result = await downloadRepoSkill(repo, resolvedRef, entry, files, targetRoot, fetch, controller.signal, (bytes, file) => {
                job.downloadedBytes += bytes
                job.currentFile = entry.dir + '/' + file
              })
              await deps.store.addSourceSkill(repo, entry.root, commitSha, resolvedRef, entry.name)
              await deps.store.mergeSourceManifest(repo, skillManifest(tree, entry.dir), entry.dir)
              if (defaultTag !== undefined) await deps.store.addSkillToTag(defaultTag.id, entry.name)
              job.imported.push({ name: entry.name, origin: entry.origin, path: result.skillPath })
              needInvalidate = true
            } catch (error) {
              if (isAbortError(error) || controller.signal.aborted) {
                // 取消时不记为 failed，保留已完成的 imported/skipped，直接跳出
                break
              }
              job.failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
            } finally {
              job.done += 1
            }
          }
          if (controller.signal.aborted) {
            job.status = 'cancelled'
            job.current = undefined
            job.currentFile = undefined
          } else {
            job.status = 'done'
            job.current = undefined
            job.currentFile = undefined
            // 确保字节进度最终对齐（避免浮点/并发尾差）
            job.downloadedBytes = job.totalBytes
          }
          if (needInvalidate) deps.invalidate?.()
        })().catch((error) => {
          job.status = 'error'
          job.error = error instanceof Error ? error.message : String(error)
          job.current = undefined
          job.currentFile = undefined
        })

        writeJson(res, 200, { ok: true, jobId, total: selected.length, totalBytes } satisfies RepoImportResponse)
      },
    },
    // 进度轮询（含字节级进度和速度）
    {
      path: SKILL_HUB_API.repoImportProgress,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const jobId = queryParam(url, 'jobId') ?? ''
        if (jobId === '') { writeError(res, 400, 'jobId is required'); return }
        const job = importJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'import job not found: ' + jobId); return }
        const elapsedSec = Math.max(0.5, (Date.now() - job.startTime) / 1000)
        const bytesPerSecond = job.status === 'running' ? Math.round(job.downloadedBytes / elapsedSec) : undefined
        writeJson(res, 200, {
          ok: true,
          jobId: job.jobId,
          status: job.status,
          total: job.total,
          done: job.done,
          ...(job.current !== undefined ? { current: job.current } : {}),
          ...(job.currentFile !== undefined ? { currentFile: job.currentFile } : {}),
          totalBytes: job.totalBytes,
          downloadedBytes: job.downloadedBytes,
          ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
          imported: [...job.imported],
          skipped: [...job.skipped],
          failed: [...job.failed],
          ...(job.error !== undefined ? { error: job.error } : {}),
        } satisfies RepoImportProgressResponse)
      },
    },
    // 取消任务（选项2：唯有点取消才停）
    {
      path: SKILL_HUB_API.repoImportCancel,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const request = body as unknown as RepoImportCancelRequest
        const jobId = typeof request.jobId === 'string' ? request.jobId : ''
        if (jobId === '') { writeError(res, 400, 'jobId is required'); return }
        const job = importJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'import job not found: ' + jobId); return }
        if (job.status === 'running') {
          job.controller.abort()
          job.status = 'cancelled'
        }
        writeJson(res, 200, { ok: true, jobId: job.jobId, status: job.status as 'cancelled' | 'done' } satisfies RepoImportCancelResponse)
      },
    },
  ]
}
