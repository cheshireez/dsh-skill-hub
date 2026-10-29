/**
 * 最小 ZIP 读取器：只做技能包导入需要的那一小块 —— store / deflate 两种
 * 压缩方法、单一中央目录、不支持 ZIP64 与加密。
 *
 * 为什么不引依赖：整个插件只有 js-yaml 一个运行时依赖，而这里需要的只是
 * 「解出一组文件」，`node:zlib` 已经提供了 inflateRaw。自己解析的代价约
 * 200 行，收益是不把一个解压库的打洞史和维护负担带进安装路径 —— ZIP 是
 * 攻击面最集中的格式之一，读的那份代码越少越可控。
 *
 * 三类攻击必须在解出字节之前拦住：
 * 1. 路径穿越（zip slip）—— `../`、反斜杠、盘符或绝对路径会把文件写到
 *    技能根之外；
 * 2. 符号链接 —— 包里的 symlink 能把后续写入重定向到任意位置；
 * 3. 解压炸弹 —— 几百 KiB 的包解出几十 GiB。上限在逐条累计里检查，不是
 *    解完再算，否则内存已经炸了。
 */

import { inflateRawSync } from 'node:zlib'

/** ZIP 结构或安全校验失败。消息面向用户，不含二进制细节。 */
export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** 解出的一条文件。目录与 macOS 资源分叉已在读取阶段剔除。 */
export interface ZipEntry {
  /** 规范化后的相对路径，正斜杠分隔，不含 `.` / `..` 段。 */
  path: string
  /** 解压后字节数。 */
  size: number
  data: Buffer
}

export interface ReadZipOptions {
  /** 全部条目解压后的总字节上限，防解压炸弹。默认 32 MiB。 */
  maxTotalBytes?: number
  /** 单条解压后的字节上限。默认 10 MiB（与技能包上限一致）。 */
  maxEntryBytes?: number
  /** 条目数上限。默认 2000（500 文件 × 最多 4 个技能留余量）。 */
  maxEntries?: number
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** EOCD 固定 22 字节 + 最多 65535 字节注释。 */
const EOCD_MIN = 22
const EOCD_MAX_COMMENT = 0xffff

const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 2000

/** Unix `st_mode` 的类型位（external attributes 高 16 位）。 */
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

/** 压缩方法：0 = store，8 = deflate。其余一律拒绝。 */
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/**
 * 把包内路径规范化成安全的相对路径。
 *
 * 反斜杠先统一成正斜杠：Windows 打包工具会写出 `a\b`，Mac/Linux 上它会被
 * 当成**文件名里的一个字符**，于是 `..\..\x` 绕过所有按 `/` 做的检查。
 */
function safeEntryPath(raw: string): string {
  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/')) throw new ZipError('zip contains an absolute path: ' + raw)
  if (/^[A-Za-z]:/.test(unified)) throw new ZipError('zip contains a drive-letter path: ' + raw)
  const parts: string[] = []
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new ZipError('zip contains a path traversal segment: ' + raw)
    // NUL 会截断下游的 fs 调用，`%2e%2e` 之类不需要单独处理 —— 这里不解码。
    if (part.includes('\0')) throw new ZipError('zip contains a NUL in a path: ' + raw)
    parts.push(part)
  }
  if (parts.length === 0) throw new ZipError('zip contains an empty path entry')
  return parts.join('/')
}

/** macOS 归档附带的资源分叉与元数据，不是技能内容。 */
function isArchiveNoise(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  return path.startsWith('__MACOSX/')
    || base === '.DS_Store'
    || base === 'Thumbs.db'
    || base === '.git' || path.includes('/.git/')
}

/** 在文件尾部找中央目录结束记录。注释最长 65535 字节，必须从后往前扫。 */
function findEocd(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - EOCD_MIN - EOCD_MAX_COMMENT)
  for (let i = buffer.length - EOCD_MIN; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new ZipError('not a zip archive: no end-of-central-directory record')
}

interface CentralEntry {
  path: string
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  unixMode: number
  isDirectory: boolean
}

function readCentralDirectory(buffer: Buffer, eocd: number): CentralEntry[] {
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)

  // ZIP64 把这三个字段写成全 F 并另存扩展记录。技能包不会这么大，
  // 与其实现一套用不到的扩展解析，不如明确拒绝 —— 静默读错更危险。
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported')
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new ZipError('corrupt zip: central directory runs past the end of the file')
  }

  const entries: CentralEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) throw new ZipError('corrupt zip: truncated central directory')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) throw new ZipError('corrupt zip: bad central directory signature')

    const versionMadeBy = buffer.readUInt16LE(cursor + 4)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)

    const nameEnd = cursor + 46 + nameLength
    if (nameEnd > buffer.length) throw new ZipError('corrupt zip: truncated entry name')
    const rawName = buffer.toString('utf8', cursor + 46, nameEnd)

    // 高字节为 3 表示由 Unix 打包，external attributes 高 16 位才是 st_mode。
    const unixMode = (versionMadeBy >> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : 0
    const isDirectory = rawName.endsWith('/') || (unixMode & S_IFMT) === S_IFDIR

    entries.push({
      path: safeEntryPath(rawName),
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localOffset,
      unixMode,
      isDirectory,
    })

    cursor = nameEnd + extraLength + commentLength
  }
  return entries
}

function readEntryData(buffer: Buffer, entry: CentralEntry, maxEntryBytes: number): Buffer {
  if (entry.localOffset + 30 > buffer.length) throw new ZipError('corrupt zip: truncated local header')
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIG) throw new ZipError('corrupt zip: bad local header signature')

  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.length) throw new ZipError('corrupt zip: entry data runs past the end of the file')

  // 解压前先按声明的尺寸挡一次，别把 100 MiB 声明的条目读进来再判。
  if (entry.uncompressedSize > maxEntryBytes) {
    throw new ZipError(`${entry.path} is ${entry.uncompressedSize} bytes, over the per-file limit`)
  }

  const compressed = buffer.subarray(dataStart, dataEnd)
  if (entry.method === METHOD_STORE) return Buffer.from(compressed)
  if (entry.method === METHOD_DEFLATE) {
    try {
      // maxOutputLength 是最后一道闸：声明尺寸可以撒谎，解压器不会。
      return inflateRawSync(compressed, { maxOutputLength: maxEntryBytes })
    } catch {
      throw new ZipError(`${entry.path} could not be inflated (corrupt or over the per-file limit)`)
    }
  }
  throw new ZipError(`${entry.path} uses unsupported compression method ${entry.method}`)
}

/**
 * 读出一个 ZIP 里的全部文件。
 *
 * 目录条目、macOS 资源分叉与 `.DS_Store` 在这里就剔掉 —— 上层只关心真正的
 * 内容文件，不该每家调用方各写一遍过滤。
 * @param buffer - 整个 ZIP 文件。
 * @param options - 三项上限；默认值见常量。
 * @returns 规范化路径 + 解压内容的条目，顺序与包内一致。
 */
export function readZip(buffer: Buffer, options?: ReadZipOptions): ZipEntry[] {
  if (buffer.length < EOCD_MIN) throw new ZipError('not a zip archive: file too small')
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxEntryBytes = options?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES

  const central = readCentralDirectory(buffer, findEocd(buffer))
  if (central.length > maxEntries) {
    throw new ZipError(`zip has ${central.length} entries, over the ${maxEntries} limit`)
  }

  const entries: ZipEntry[] = []
  let total = 0
  for (const entry of central) {
    if ((entry.flags & 0x1) !== 0) throw new ZipError(`${entry.path} is encrypted; password-protected archives are not supported`)
    if ((entry.unixMode & S_IFMT) === S_IFLNK) throw new ZipError(`${entry.path} is a symlink; archives may not redirect writes outside the skill directory`)
    if (entry.isDirectory) continue
    if (isArchiveNoise(entry.path)) continue

    const data = readEntryData(buffer, entry, maxEntryBytes)
    total += data.length
    if (total > maxTotalBytes) {
      throw new ZipError(`zip expands to more than ${Math.floor(maxTotalBytes / (1024 * 1024))} MiB; refusing to unpack it`)
    }
    entries.push({ path: entry.path, size: data.length, data })
  }
  return entries
}

/**
 * 从解出的条目里找出「技能根」：包含 `SKILL.md` 的最浅目录。
 *
 * 一个包可能整体就是一个技能（`SKILL.md` 在根），也可能是一堆技能的集合
 * （每个子目录各有一个）。两种都按同一个判据识别：谁有 SKILL.md，谁的
 * 目录就是根；父目录因此自动排除，不会出现「把一个集合包当成一个大技能」。
 * @param entries - `readZip` 的结果。
 * @returns 技能目录（相对路径，'' 表示包根）到该目录下条目的映射。
 */
export function groupSkills(entries: readonly ZipEntry[]): Map<string, ZipEntry[]> {
  const found = new Set<string>()
  for (const entry of entries) {
    const base = entry.path.split('/').pop() ?? ''
    if (base.toLowerCase() !== 'skill.md') continue
    found.add(entry.path.slice(0, entry.path.length - base.length).replace(/\/$/, ''))
  }

  // 只保留最浅的根：技能内部再带一个 SKILL.md（参考子技能、模板目录）时，
  // 那个子目录属于父技能的内容，不该被单独拆成一个包。包根即技能的形态
  // 直接短路 —— 它必然包含其余所有根。
  const roots = found.has('')
    ? ['']
    : [...found]
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .reduce<string[]>((accepted, root) => {
        if (!accepted.some((ancestor) => root.startsWith(ancestor + '/'))) accepted.push(root)
        return accepted
      }, [])

  const grouped = new Map<string, ZipEntry[]>()
  for (const root of roots) {
    const prefix = root === '' ? '' : root + '/'
    // `prefix = ''` 时 startsWith('') 恒真，正好就是「包根即技能」的情形；
    // 带前缀时 `foo/` 不会误吞 `foobar/x`，因为分隔符也在前缀里。
    grouped.set(root, entries
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => {
        const relative = entry.path.slice(prefix.length)
        // 落盘的发现文件统一成规范名 `SKILL.md`：下游的启用态判定是按字面量
        // 找这个文件的，包内写成 `skill.md` 的会在落盘后变成「装了但看不见」。
        return { ...entry, path: relative.toLowerCase() === 'skill.md' ? 'SKILL.md' : relative }
      }))
  }
  return grouped
}
