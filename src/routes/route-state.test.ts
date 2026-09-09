import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IMPORT_JOB_MAX, gcImportJobs, importJobs, replaceSkillDir, type ImportJob } from './route-state.ts'

/** One import job with sane defaults; override what the test cares about. */
function job(jobId: string, createdAt: number, status: ImportJob['status'] = 'done'): ImportJob {
  return {
    jobId,
    total: 1,
    done: 1,
    totalBytes: 1,
    downloadedBytes: 1,
    startTime: createdAt,
    imported: [],
    skipped: [],
    failed: [],
    status,
    controller: new AbortController(),
    createdAt,
  }
}

describe('gcImportJobs', () => {
  afterEach(() => { importJobs.clear() })

  it('keeps running jobs when trimming the map down to the cap', () => {
    // 运行中的任务被淘汰会让 /progress、/cancel 变成 404，而下载还在后台跑。
    const running = job('running-1', 1, 'running')
    importJobs.set(running.jobId, running)
    const now = Date.now()
    for (let i = 0; i < IMPORT_JOB_MAX + 5; i++) {
      const finished = job('done-' + i, now + i, 'done')
      importJobs.set(finished.jobId, finished)
    }
    gcImportJobs()
    expect(importJobs.has('running-1')).toBe(true)
    expect(importJobs.size).toBeLessThanOrEqual(IMPORT_JOB_MAX + 1)
    // 淘汰按 createdAt 从旧到新，最新的已完成任务留下。
    expect(importJobs.has('done-' + (IMPORT_JOB_MAX + 4))).toBe(true)
  })

  it('drops finished jobs older than the TTL', () => {
    const stale = job('stale', Date.now() - 10 * 60_000, 'done')
    importJobs.set(stale.jobId, stale)
    gcImportJobs()
    expect(importJobs.has('stale')).toBe(false)
  })
})

describe('replaceSkillDir', () => {
  let dir: string

  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('replaces the target directory with the freshly downloaded content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skill-hub-replace-'))
    const target = join(dir, 'skill')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'old.txt'), 'old', 'utf8')
    await replaceSkillDir(target, async () => {
      // 下载方负责重建目标目录（downloadRepoSkill 就是这么做的）。
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'new.txt'), 'new', 'utf8')
    })
    expect(await readdir(target)).toEqual(['new.txt'])
    expect(await readFile(join(target, 'new.txt'), 'utf8')).toBe('new')
    // 备份目录（点前缀）不得残留。
    expect((await readdir(dir)).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('restores the original directory when the download fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skill-hub-replace-'))
    const target = join(dir, 'skill')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'old.txt'), 'old', 'utf8')
    await expect(replaceSkillDir(target, async () => { throw new Error('download failed') })).rejects.toThrow('download failed')
    expect(await readFile(join(target, 'old.txt'), 'utf8')).toBe('old')
    expect((await readdir(dir)).filter((name) => name.startsWith('.'))).toEqual([])
  })
})
