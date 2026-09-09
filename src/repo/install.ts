/**
 * 技能目录下载与落地：单文件下载（raw 优先、contents 兜底）、整目录
 * 临时目录 + 原子 rename、启动时清理残留导入临时目录。
 * 从 repo.ts 抽出。
 */

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RepoSkillEntry } from '../protocol.ts'
import { errorText } from '../error-text.ts'
import { mapConcurrent } from '../concurrency.ts'
import { parseFrontmatter } from '../skillfs.ts'
import { RepoFetchError, fetchError, githubAuthHeaders, isAbortError } from './github-client.ts'
import type { RepoFile } from './types.ts'

/**
 * Download one GitHub file as a buffer. Tries raw.githubusercontent.com
 * first (no API quota); on any failure falls back to the api.github.com
 * contents endpoint with the raw media type (rate-limited, but reachable
 * from networks that block the raw host).
 */
export async function downloadGitHubFile(repo: string, ref: string, path: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodedPath}`
  let firstError: string | null = null
  let response: Response | null = null
  try {
    response = await fetchImpl(rawUrl, { headers: githubAuthHeaders(), ...(signal !== undefined ? { signal } : {}) })
  } catch (error) {
    if (isAbortError(error)) throw error
    firstError = errorText(error)
  }
  if (response === null || !response.ok) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    // Fallback: api.github.com/contents with the raw media type.
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodedPath}`
    try {
      response = await fetchImpl(apiUrl, { headers: { accept: 'application/vnd.github.raw', ...githubAuthHeaders() }, ...(signal !== undefined ? { signal } : {}) })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new RepoFetchError('download failed: ' + (firstError ?? (errorText(error))))
    }
  }
  if (response === null || !response.ok) {
    throw fetchError('download failed', response)
  }
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new RepoFetchError('download read failed: ' + (errorText(error)))
  }
}

/**
 * Download a full skill directory into a temporary dir, validate SKILL.md,
 * then atomically rename it into place. The target root is created when missing.
 * Callers pass a target root and a skill entry plus its collected files.
 */
export async function downloadRepoSkill(
  repo: string,
  ref: string,
  entry: RepoSkillEntry,
  files: readonly RepoFile[],
  targetRoot: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  onProgress?: (bytes: number, file: string) => void,
): Promise<{ targetDir: string; skillPath: string }> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const targetDir = join(targetRoot, entry.name)
  await mkdir(targetRoot, { recursive: true })
  // Dot-prefixed so a leftover temp dir can never surface as a skill in the
  // provider's discovery scan (scanRoot skips dot entries).
  const tempDir = await mkdtemp(join(targetRoot, '.' + entry.name + '.import-'))
  let renamed = false
  try {
    await mapConcurrent(files, 6, async (file) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const relative = file.path.slice(entry.dir.length + 1)
      if (relative === '' || relative.includes('..')) throw new RepoFetchError('unsafe repo path: ' + file.path)
      const target = join(tempDir, relative)
      const buffer = await downloadGitHubFile(repo, ref, file.path, fetchImpl, signal)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
      onProgress?.(buffer.length, relative)
    })

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    let text: string
    try {
      text = await readFile(join(tempDir, 'SKILL.md'), 'utf8')
    } catch {
      throw new RepoFetchError('downloaded skill has no SKILL.md')
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) throw new RepoFetchError('downloaded skill rejected: ' + parsed.error, 422)
    if (parsed.value.name !== entry.name) {
      throw new RepoFetchError('downloaded skill declares name "' + parsed.value.name + '", expected "' + entry.name + '"', 422)
    }

    await rename(tempDir, targetDir)
    renamed = true
    return { targetDir, skillPath: join(targetDir, 'SKILL.md') }
  } finally {
    if (!renamed) {
      // 尽力清理临时目录，失败只打日志，不再静默吞掉；finally 保证 abort/异常都能清理
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch (firstError) {
        // 并发 worker 可能仍在写入，稍等 60ms 重试一次
        await new Promise((resolve) => setTimeout(resolve, 60))
        try {
          await rm(tempDir, { recursive: true, force: true })
        } catch (secondError) {
          console.warn(`[skill-hub] cleanup tempDir failed ${tempDir}:`, errorText(secondError), 'first:', errorText(firstError))
        }
      }
    }
  }
}

/**
 * 启动时扫描并清理残留的 `.*.import-*` 临时目录（Issue #3 第4点）。
 * 越积越多的点前缀目录不会显示为 skill，但会占空间，尽早回收。
 */
export async function cleanupLeftoverImportDirs(targetRoot: string): Promise<number> {
  const { readdir, rm: rm2 } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(targetRoot)
  } catch {
    return 0
  }
  let cleaned = 0
  for (const name of names) {
    if (!/^\..*\.import-/.test(name)) continue
    const full = join(targetRoot, name)
    try {
      await rm2(full, { recursive: true, force: true })
      cleaned += 1
    } catch (error) {
      console.warn(`[skill-hub] startup cleanup failed ${full}:`, errorText(error))
    }
  }
  if (cleaned > 0) console.warn(`[skill-hub] startup cleaned ${cleaned} leftover import temp dir(s) in ${targetRoot}`)
  return cleaned
}
