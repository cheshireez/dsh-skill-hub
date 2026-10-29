/**
 * ZIP 导入的真实 HTTP 链路：起一个真的 `node:http` 服务器，把路由挂上去，
 * 用真的 `fetch` 发请求。
 *
 * 为什么不能只靠 `routes.test.ts` 里的假对象：`binaryBody` 是全新的读取
 * 路径，它消费的是真实的 `IncomingMessage` 异步迭代器（chunk 是 Buffer、
 * 有背压、只能读一次）。假对象把这些都简化掉了，恰恰是这类代码最容易在
 * 真机上出问题的地方。这里只留两个用例，把「真实流」这一层钉住。
 */

import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeRoutes, type SkillHubRouteDeps } from '../routes.ts'
import { SKILL_HUB_API, SKILL_HUB_WRITE_HEADER, SKILL_HUB_WRITE_VALUE, type ZipImportResponse } from '../protocol.ts'
import { SkillHubStore, statePath } from '../store.ts'

/** 最小 store-method ZIP 构造（与 zip.test.ts 同格式，独立一份避免测试互相依赖）。 */
function makeZip(files: Array<{ path: string; data: string }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const data = Buffer.from(file.data, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, eocd])
}

describe('POST /api/skill-hub/import/zip over real HTTP', () => {
  let dir: string
  let home: string
  let base: string
  let close: () => Promise<void>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-skill-hub-zip-http-'))
    home = join(dir, 'home')
    await mkdir(join(home, 'skills'), { recursive: true })
    const deps: SkillHubRouteDeps = {
      skills: { snapshot: async () => ({ skills: [], complete: true }), get: async () => undefined },
      store: new SkillHubStore(statePath(home)),
      home,
      userHome: dir,
    }
    const route = makeRoutes(deps).find((candidate) => candidate.path === SKILL_HUB_API.importZip)
    if (route === undefined) throw new Error('import-zip route is not registered')
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    base = 'http://127.0.0.1:' + String(address.port)
    close = async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) }
  })

  afterEach(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  it('unpacks a real upload end to end', async () => {
    const zip = makeZip([{ path: 'SKILL.md', data: '---\nname: http-zip\ndescription: demo\n---\nbody\n' }])
    const response = await fetch(base + SKILL_HUB_API.importZip, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', [SKILL_HUB_WRITE_HEADER]: SKILL_HUB_WRITE_VALUE },
      body: zip,
    })
    expect(response.status).toBe(200)
    const body = await response.json() as ZipImportResponse
    expect(body.imported).toEqual(['http-zip'])
    expect(await readFile(join(home, 'skills', 'http-zip', 'SKILL.md'), 'utf8')).toContain('name: http-zip')
  })

  it('rejects the same upload without the write marker, before reading the body', async () => {
    const zip = makeZip([{ path: 'SKILL.md', data: '---\nname: http-zip\ndescription: demo\n---\nbody\n' }])
    const response = await fetch(base + SKILL_HUB_API.importZip, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: zip,
    })
    expect(response.status).toBe(403)
    // 未落盘：被拒的请求不该留下任何目录。
    await expect(readFile(join(home, 'skills', 'http-zip', 'SKILL.md'), 'utf8')).rejects.toBeTruthy()
  })
})
