import { describe, expect, it } from 'vitest'
import { buildMcpInsertBlock, listMcpServersFromDocument, MCP_CLIENT_NAME, rewriteMcpPatchText, validateMcpRequest } from './mcp.ts'
import type { McpServerEntry } from './protocol.ts'

function server(id: string, overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id,
    name: MCP_CLIENT_NAME,
    serverName: id,
    transport: 'stdio',
    command: '/usr/local/bin/' + id,
    args: [],
    failOnStartupError: false,
    ...overrides,
  }
}

describe('listMcpServersFromDocument', () => {
  it('extracts MCP insert entries and ignores other entries', () => {
    const doc = [
      { insert: [{ id: 'mcp-a', name: MCP_CLIENT_NAME, config: { serverName: 'a', transport: 'stdio', command: '/bin/a', args: [] } }] },
      { insert: [{ id: 'skin-1', name: 'dsh-skin', config: {} }] },
      { disabled: [{ id: 'mcp-b', name: MCP_CLIENT_NAME }] },
    ]
    const servers = listMcpServersFromDocument(doc)
    expect(servers.map((item) => item.id)).toEqual(['mcp-a'])
    expect(servers[0].serverName).toBe('a')
  })
})

describe('rewriteMcpPatchText', () => {
  it('preserves file header comments while replacing the MCP block', () => {
    const original = [
      '# Patch layer for this profile.',
      '# A second header line.',
      '',
      '# godot-ai MCP server comment.',
      '- insert:',
      '    - id: mcp-godot-ai',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: godot-ai',
      '        transport: stdio',
      '        command: /usr/local/bin/godot-ai',
      '',
    ].join('\n')
    const rewritten = rewriteMcpPatchText(original, [server('mcp-godot-ai', { serverName: 'godot-ai' })])
    expect(rewritten).toContain('# Patch layer for this profile.')
    expect(rewritten).toContain('# A second header line.')
    // MCP comment follows the block to its new location.
    expect(rewritten).toContain('# godot-ai MCP server comment.')
    expect(rewritten).toContain('- insert:')
    expect(rewritten).toContain('id: "mcp-godot-ai"')
  })

  it('keeps non-MCP insert entries intact', () => {
    const original = [
      '- insert:',
      '    - id: skin-1',
      "      name: 'dsh-skin'",
      '      config: {}',
      '- insert:',
      '    - id: mcp-a',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: a',
      '        transport: stdio',
      '        command: /bin/a',
      '',
    ].join('\n')
    const rewritten = rewriteMcpPatchText(original, [server('mcp-b')])
    expect(rewritten).toContain("name: 'dsh-skin'")
    expect(rewritten).not.toContain('mcp-a')
    expect(rewritten).toContain('id: "mcp-b"')
  })

  it('appends a block to a file with no MCP entries', () => {
    const original = [
      '# Only a skin entry lives here.',
      '- id: ui-skin-x',
      '  disabled: true',
      '',
    ].join('\n')
    const rewritten = rewriteMcpPatchText(original, [server('mcp-new')])
    expect(rewritten).toContain('# Only a skin entry lives here.')
    expect(rewritten).toContain('id: ui-skin-x')
    expect(rewritten).toContain('id: "mcp-new"')
  })

  it('builds a block from scratch for an empty file', () => {
    const rewritten = rewriteMcpPatchText('', [server('mcp-a'), server('mcp-b')])
    expect(rewritten).toContain('id: "mcp-a"')
    expect(rewritten).toContain('id: "mcp-b"')
  })

  it('removes the last MCP server and leaves a clean file', () => {
    const original = [
      '# Header comment stays.',
      '- insert:',
      '    - id: mcp-a',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: a',
      '        transport: stdio',
      '        command: /bin/a',
      '',
    ].join('\n')
    const rewritten = rewriteMcpPatchText(original, [])
    expect(rewritten).toContain('# Header comment stays.')
    expect(rewritten).not.toContain('mcp-a')
    expect(rewritten).not.toContain('- insert:')
  })
})

describe('buildMcpInsertBlock', () => {
  it('renders a valid insert block with args and flags', () => {
    const block = buildMcpInsertBlock([server('mcp-a', { args: ['--config', 'x'], failOnStartupError: true })], ['# custom note'])
    expect(block).toContain('# custom note')
    expect(block).toContain('- insert:')
    expect(block).toContain('args: ["--config","x"]')
    expect(block).toContain('failOnStartupError: true')
  })

  it('returns empty for no servers', () => {
    expect(buildMcpInsertBlock([])).toBe('')
  })
})

describe('validateMcpRequest', () => {
  it('requires id, serverName, and command', () => {
    expect(validateMcpRequest({ id: '', serverName: 'a', transport: 'stdio', command: '/bin/a', args: [], failOnStartupError: false })).toBe('id is required')
    expect(validateMcpRequest({ id: 'a', serverName: '', transport: 'stdio', command: '/bin/a', args: [], failOnStartupError: false })).toBe('serverName is required')
    expect(validateMcpRequest({ id: 'a', serverName: 'a', transport: 'stdio', command: '', args: [], failOnStartupError: false })).toBe('command is required')
    expect(validateMcpRequest({ id: 'a', serverName: 'a', transport: 'stdio', command: '/bin/a', args: [], failOnStartupError: false })).toBeNull()
  })
})
