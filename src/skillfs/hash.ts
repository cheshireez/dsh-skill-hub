/**
 * 技能内容哈希：给「本地这份技能到底有没有被改过」一个确定答案。
 *
 * 现有来源记录只存上游的 commit 与按路径的字节数基线，能回答「上游变没变」，
 * 回答不了「磁盘上这份还是不是我当初导入的那份」。于是「一键全更」只能盲覆盖，
 * 用户唯一的保护是弹窗里那句他自己也判断不了的「会覆盖本地修改」。
 *
 * 哈希的粒度是**整个技能**（目录包 = 目录下全部文件；扁平技能 = 那一个文件），
 * 而不是单文件：用户改的是「这个技能」，不是「这个技能里的第 3 个文件」。
 *
 * 边界（与体积审计同一套取舍）：技能是纯文本加少量脚本，正常体积在几十 KB。
 * 走查上限存在的意义是「一个恶意或事故性的巨大目录不能把 /catalog 拖死」，
 * 不是为了支持大包。
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

/** 单个技能参与哈希的文件数上限；超出部分不参与（并在结果里体现为截断）。 */
const MAX_FILES = 2000
/** 目录走查深度上限。 */
const MAX_DEPTH = 8
/** 超过这个大小的文件不读内容，只把大小计入（避免一次同步卡在几个大二进制上）。 */
const MAX_HASH_BYTES = 8 * 1024 * 1024

interface HashEntry {
  path: string
  size: number
  /** 内容摘要；文件过大或不可读时为占位符。 */
  digest: string
}

/** 递归收集相对路径与大小。符号链接不跟随（lstat），避免指到目录外。 */
async function collect(dir: string, depth: number, out: Array<{ path: string; size: number; absolute: string }>): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  names.sort()
  for (const name of names) {
    if (out.length >= MAX_FILES) return
    // .git 是仓库元数据，.trash 是回收站，都不属于技能内容。
    if (name === '.git' || name === '.trash') continue
    const absolute = join(dir, name)
    let info
    try {
      info = await lstat(absolute)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) await collect(absolute, depth + 1, out)
    else if (info.isFile()) out.push({ path: relative(dir, absolute), size: info.size, absolute })
  }
}

/** 把一组 (相对路径, 大小, 内容摘要) 折叠成一个十六进制摘要。 */
function fold(entries: readonly HashEntry[]): string {
  const digest = createHash('sha256')
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    digest.update(entry.path)
    digest.update('\0')
    digest.update(String(entry.size))
    digest.update('\0')
    digest.update(entry.digest)
    digest.update('\0')
  }
  return digest.digest('hex')
}

/** 单文件内容摘要；不可读或过大时给一个稳定占位符。 */
async function digestFile(absolute: string, size: number): Promise<string> {
  if (size > MAX_HASH_BYTES) return 'oversize'
  try {
    return createHash('sha256').update(await readFile(absolute)).digest('hex')
  } catch {
    return 'unreadable'
  }
}

/**
 * 一个技能目录的内容哈希。目录不可读时返回 undefined（调用方据此跳过比对，
 * 而不是把它当成「改过了」—— 读不到不等于变了）。
 */
export async function hashSkillDirectory(dir: string): Promise<string | undefined> {
  const collected: Array<{ path: string; size: number; absolute: string }> = []
  await collect(dir, 0, collected)
  if (collected.length === 0) return undefined
  const entries: HashEntry[] = []
  for (const file of collected) entries.push({ path: file.path, size: file.size, digest: await digestFile(file.absolute, file.size) })
  return fold(entries)
}

/**
 * 从一个发现文件推断技能形态并算哈希：`SKILL.md`（含 `.disabled` 变体）是
 * 目录包，其余 `<name>.md` 是扁平技能。两种形态共用同一个返回契约。
 */
export async function hashSkillAt(discoveryPath: string): Promise<string | undefined> {
  const file = basename(discoveryPath).replace(/\.disabled$/, '')
  if (file === 'SKILL.md') return hashSkillDirectory(dirname(discoveryPath))
  try {
    const info = await lstat(discoveryPath)
    if (!info.isFile()) return undefined
    return fold([{ path: file, size: info.size, digest: await digestFile(discoveryPath, info.size) }])
  } catch {
    return undefined
  }
}
