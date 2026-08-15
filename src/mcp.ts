/**
 * MCP server management backed by the dsh profile's cordis.patch.yml.
 *
 * The patch file is a top-level YAML array of loader patch entries. MCP
 * servers are `insert` entries whose `name` is `@deepseek-ai/dsh-mcp-client`.
 * Reading uses js-yaml for the list view; writing is line-based so comments
 * and every non-MCP entry survive unchanged. MCP comments are re-attached to
 * the rewritten insert block instead of being discarded.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { McpSaveRequest, McpServerEntry } from './protocol.ts'
import { dshHome } from './store.ts'

/** MCP client package name marking an insert entry as an MCP server. */
export const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'

/** Resolve the active profile patch path. Defaults to the web profile. */
export function mcpPatchPath(profile = process.env.DSH_PROFILE ?? 'web', home = dshHome()): string {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** Shape of one patch document. The top-level array is all we need. */
type PatchEntry = Record<string, unknown>
type PatchDocument = PatchEntry[]

/** Read a patch file as a plain array; a missing file starts empty. */
export async function readMcpPatch(path: string): Promise<PatchDocument> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed: unknown = load(text)
  if (!Array.isArray(parsed)) return []
  return parsed as PatchDocument
}

/** One insert entry normalized into an MCP server row. */
function toMcpServer(entry: unknown): McpServerEntry | null {
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  if (record.name !== MCP_CLIENT_NAME) return null
  const id = typeof record.id === 'string' ? record.id : ''
  const config = typeof record.config === 'object' && record.config !== null ? record.config as Record<string, unknown> : {}
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : []
  return {
    id,
    name: MCP_CLIENT_NAME,
    serverName: typeof config.serverName === 'string' ? config.serverName : '',
    transport: typeof config.transport === 'string' ? config.transport : 'stdio',
    command: typeof config.command === 'string' ? config.command : '',
    args,
    failOnStartupError: config.failOnStartupError === true,
  }
}

/** Extract every MCP server from a patch document, in file order. */
export function listMcpServersFromDocument(doc: PatchDocument): McpServerEntry[] {
  const servers: McpServerEntry[] = []
  for (const entry of doc) {
    if (typeof entry !== 'object' || entry === null) continue
    const insert = entry.insert
    if (Array.isArray(insert)) {
      for (const item of insert) {
        const server = toMcpServer(item)
        if (server !== null) servers.push(server)
      }
    }
  }
  return servers
}

/** Read and list MCP servers from the active patch file. */
export async function listMcpServers(path = mcpPatchPath()): Promise<McpServerEntry[]> {
  return listMcpServersFromDocument(await readMcpPatch(path))
}

/** Validate a save request, returning a non-empty error string when invalid. */
export function validateMcpRequest(request: McpSaveRequest): string | null {
  if (request.id.trim() === '') return 'id is required'
  if (request.serverName.trim() === '') return 'serverName is required'
  if (request.command.trim() === '') return 'command is required'
  return null
}

/** True when a line opens a top-level `- insert:` entry. */
function isInsertStart(line: string): boolean {
  return /^- insert:/.test(line)
}

/** End index (exclusive) of an insert block: next top-level entry, blank line, or EOF. */
function findInsertBlockEnd(lines: readonly string[], start: number): number {
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (/^- /.test(line)) break
    if (line.trim() === '') break
    if (!/^\s/.test(line) && !line.startsWith('#')) break
    end += 1
  }
  return end
}

/** True when the line range mentions the MCP client package name. */
function isMcpRange(lines: readonly string[], start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (lines[i].includes(MCP_CLIENT_NAME)) return true
  }
  return false
}

/** Index of the next `    - ` list item inside an insert block, or blockEnd. */
function nextItemStart(lines: readonly string[], from: number, blockEnd: number): number {
  for (let i = from; i < blockEnd; i += 1) {
    if (/^ {4}- /.test(lines[i])) return i
  }
  return blockEnd
}

/** End index (exclusive) of one insert item: the next item line or block end. */
function findItemEnd(lines: readonly string[], itemStart: number, blockEnd: number): number {
  let end = itemStart + 1
  while (end < blockEnd) {
    if (/^ {4}- /.test(lines[end])) break
    end += 1
  }
  return end
}

/**
 * Collect the comment lines directly above `start`, mark them for removal,
 * and return them in original order. Stops at a blank or non-comment line.
 */
function takePrecedingComments(lines: readonly string[], start: number, drop: Set<number>): string[] {
  const comments: string[] = []
  let i = start - 1
  while (i >= 0 && lines[i].trim().startsWith('#')) {
    if (drop.has(i)) break
    comments.unshift(lines[i])
    drop.add(i)
    i -= 1
  }
  return comments
}

/** YAML-safe double-quoted scalar (JSON escaping is a YAML superset for plain values). */
function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

/** Render the rewritten MCP insert block; empty when there are no servers. */
export function buildMcpInsertBlock(servers: readonly McpServerEntry[], comments: readonly string[] = []): string {
  if (servers.length === 0) return ''
  const lines: string[] = []
  if (comments.length === 0) {
    lines.push('# MCP servers managed by dsh-skill-hub; restart dsh to apply.')
  } else {
    lines.push(...comments)
  }
  lines.push('- insert:')
  for (const server of servers) {
    lines.push('    - id: ' + yamlScalar(server.id))
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'")
    lines.push('      config:')
    lines.push('        serverName: ' + yamlScalar(server.serverName))
    lines.push('        transport: ' + yamlScalar(server.transport))
    lines.push('        command: ' + yamlScalar(server.command))
    if (server.args.length > 0) {
      lines.push('        args: ' + JSON.stringify(server.args))
    }
    if (server.failOnStartupError) {
      lines.push('        failOnStartupError: true')
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Rewrite the patch file text, preserving every non-MCP line and comment.
 * Existing MCP insert items (and the comments attached to them) are removed;
 * the new server list is appended as one insert block.
 */
export function rewriteMcpPatchText(original: string, servers: readonly McpServerEntry[]): string {
  const lines = original.split('\n')
  const drop = new Set<number>()
  const preservedComments: string[] = []
  // Comments ride along only when a replacement block will exist; removing
  // the last server keeps comments in place instead of discarding them.
  const collectComments = servers.length > 0

  for (let i = 0; i < lines.length; i += 1) {
    if (!isInsertStart(lines[i])) continue
    const blockEnd = findInsertBlockEnd(lines, i)
    let cursor = i + 1
    let anyMcp = false
    while (cursor < blockEnd) {
      const itemStart = nextItemStart(lines, cursor, blockEnd)
      if (itemStart === blockEnd) break
      const itemEnd = findItemEnd(lines, itemStart, blockEnd)
      if (isMcpRange(lines, itemStart, itemEnd)) {
        anyMcp = true
        if (collectComments) preservedComments.push(...takePrecedingComments(lines, itemStart, drop))
        for (let j = itemStart; j < itemEnd; j += 1) drop.add(j)
      }
      cursor = itemEnd
    }
    if (!anyMcp) continue

    let hasKept = false
    for (let j = i + 1; j < blockEnd; j += 1) {
      if (!drop.has(j)) {
        hasKept = true
        break
      }
    }
    if (!hasKept) {
      if (collectComments) preservedComments.unshift(...takePrecedingComments(lines, i, drop))
      for (let j = i; j < blockEnd; j += 1) drop.add(j)
    }
  }

  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!drop.has(i)) kept.push(lines[i])
  }
  const head = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  const block = buildMcpInsertBlock(servers, preservedComments)
  if (block === '') return head
  if (head === '') return block
  return head + '\n\n' + block
}

/** Read, rewrite, and write the active MCP patch file, preserving comments. */
export async function writeMcpServers(servers: readonly McpServerEntry[], path = mcpPatchPath()): Promise<void> {
  let original: string
  try {
    original = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') original = ''
    else throw error
  }
  const text = rewriteMcpPatchText(original, servers)
  await writeFile(path, text, 'utf8')
}
