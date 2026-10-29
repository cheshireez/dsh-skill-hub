import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { groupSkills, readZip, ZipError } from './zip.ts'

/** 一条待写入测试包的条目。`mode` 是 Unix st_mode；符号链接位由用例显式传。 */
interface FakeEntry {
  path: string
  data: string | Buffer
  method?: 0 | 8
  flags?: number
  mode?: number
}

/**
 * 手工拼一个 ZIP。故意不依赖被测代码，也不做 CRC —— 读取器不校验 CRC，
 * 填 0 让构造保持简单；格式本身（签名、偏移、长度字段）必须是真的，
 * 否则测的就不是同一个东西了。
 */
function makeZip(entries: FakeEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(raw) : raw

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, payload)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    // 高字节 3 = 由 Unix 打包，这样 external attributes 才会被读成 st_mode。
    header.writeUInt16LE((3 << 8) | 20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(entry.flags ?? 0, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(payload.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + payload.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, eocd])
}

describe('readZip — 正常读取', () => {
  it('reads stored entries and keeps their order', () => {
    const zip = makeZip([
      { path: 'SKILL.md', data: '---\nname: demo\n---\nbody\n' },
      { path: 'scripts/run.sh', data: 'echo hi\n' },
    ])
    const entries = readZip(zip)
    expect(entries.map((entry) => entry.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(entries[1]?.data.toString('utf8')).toBe('echo hi\n')
  })

  it('inflates deflate entries', () => {
    const body = 'x'.repeat(4096)
    const entries = readZip(makeZip([{ path: 'SKILL.md', data: body, method: 8 }]))
    expect(entries[0]?.size).toBe(4096)
    expect(entries[0]?.data.toString('utf8')).toBe(body)
  })

  it('drops directories, __MACOSX forks and .DS_Store', () => {
    const zip = makeZip([
      { path: 'skill/', data: '', mode: 0o040755 },
      { path: 'skill/SKILL.md', data: 'body' },
      { path: '__MACOSX/skill/._SKILL.md', data: 'fork' },
      { path: 'skill/.DS_Store', data: 'junk' },
    ])
    expect(readZip(zip).map((entry) => entry.path)).toEqual(['skill/SKILL.md'])
  })

  it('normalizes backslashes and redundant segments', () => {
    const entries = readZip(makeZip([{ path: 'dir\\sub/./SKILL.md', data: 'body' }]))
    expect(entries[0]?.path).toBe('dir/sub/SKILL.md')
  })
})

describe('readZip — 安全拒绝', () => {
  it('rejects path traversal', () => {
    expect(() => readZip(makeZip([{ path: '../evil.md', data: 'x' }]))).toThrow(ZipError)
  })

  it('rejects traversal hidden behind backslashes', () => {
    expect(() => readZip(makeZip([{ path: '..\\..\\evil.md', data: 'x' }]))).toThrow(/traversal/)
  })

  it('rejects absolute and drive-letter paths', () => {
    expect(() => readZip(makeZip([{ path: '/etc/passwd', data: 'x' }]))).toThrow(/absolute/)
    expect(() => readZip(makeZip([{ path: 'C:/Windows/x', data: 'x' }]))).toThrow(/drive-letter/)
  })

  it('rejects symlink entries', () => {
    const zip = makeZip([{ path: 'link', data: '/etc/passwd', mode: 0o120777 }])
    expect(() => readZip(zip)).toThrow(/symlink/)
  })

  it('rejects encrypted entries', () => {
    const zip = makeZip([{ path: 'SKILL.md', data: 'x', flags: 1 }])
    expect(() => readZip(zip)).toThrow(/encrypted/)
  })

  it('rejects an entry over the per-file limit before inflating', () => {
    const zip = makeZip([{ path: 'big.md', data: 'y'.repeat(2048), method: 8 }])
    expect(() => readZip(zip, { maxEntryBytes: 1024 })).toThrow(/per-file limit/)
  })

  it('rejects a package whose total expands past the limit', () => {
    const zip = makeZip([
      { path: 'a.md', data: 'a'.repeat(600) },
      { path: 'b.md', data: 'b'.repeat(600) },
    ])
    expect(() => readZip(zip, { maxTotalBytes: 1000 })).toThrow(/refusing to unpack/)
  })

  it('rejects too many entries', () => {
    const zip = makeZip([
      { path: 'a.md', data: 'a' },
      { path: 'b.md', data: 'b' },
      { path: 'c.md', data: 'c' },
    ])
    expect(() => readZip(zip, { maxEntries: 2 })).toThrow(/over the 2 limit/)
  })

  it('rejects a non-zip buffer', () => {
    expect(() => readZip(Buffer.from('definitely not a zip file at all'))).toThrow(/not a zip archive/)
  })
})

describe('groupSkills — 识别技能根', () => {
  it('treats the package root as one skill', () => {
    const entries = readZip(makeZip([
      { path: 'SKILL.md', data: 'body' },
      { path: 'scripts/a.sh', data: 'echo' },
    ]))
    const grouped = groupSkills(entries)
    expect([...grouped.keys()]).toEqual([''])
    expect(grouped.get('')?.map((entry) => entry.path).sort()).toEqual(['SKILL.md', 'scripts/a.sh'])
  })

  it('splits a collection package into one skill per directory', () => {
    const entries = readZip(makeZip([
      { path: 'alpha/SKILL.md', data: 'a' },
      { path: 'alpha/ref.md', data: 'ra' },
      { path: 'beta/SKILL.md', data: 'b' },
    ]))
    const grouped = groupSkills(entries)
    expect([...grouped.keys()].sort()).toEqual(['alpha', 'beta'])
    expect(grouped.get('alpha')?.map((entry) => entry.path).sort()).toEqual(['SKILL.md', 'ref.md'])
    expect(grouped.get('beta')?.map((entry) => entry.path)).toEqual(['SKILL.md'])
  })

  it('accepts lowercase skill.md and does not swallow sibling names', () => {
    const entries = readZip(makeZip([
      { path: 'one/skill.md', data: 'a' },
      { path: 'one/deep/SKILL.md', data: 'nested is not a root' },
      { path: 'onetwo/SKILL.md', data: 'b' },
    ]))
    const grouped = groupSkills(entries)
    expect([...grouped.keys()].sort()).toEqual(['one', 'onetwo'])
    expect(grouped.get('one')?.map((entry) => entry.path).sort()).toEqual(['SKILL.md', 'deep/SKILL.md'])
  })

  it('returns nothing when no SKILL.md is present', () => {
    const entries = readZip(makeZip([{ path: 'readme.md', data: 'no skill here' }]))
    expect(groupSkills(entries).size).toBe(0)
  })
})
