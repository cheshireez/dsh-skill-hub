import { load } from 'js-yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { errorText } from '../error-text.ts'

/** One parsed frontmatter outcome (official provider semantics). */
export interface FrontmatterValue {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  /** Instruction body after the frontmatter block, trimmed. */
  content: string
}

/** Parse a SKILL.md the way the official filesystem provider does. */
export function parseFrontmatter(text: string): { value: FrontmatterValue } | { error: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (match === null) return { error: 'missing YAML frontmatter (--- block)' }
  let data: unknown
  let rawFrontmatter = match[1]
  try {
    data = load(rawFrontmatter)
  } catch (error) {
    const repaired = repairFrontmatterScalarFields(rawFrontmatter)
    if (repaired !== null) {
      try {
        data = load(repaired)
        rawFrontmatter = repaired
      } catch {
        return { error: 'invalid YAML frontmatter: ' + (errorText(error)) }
      }
    } else {
      return { error: 'invalid YAML frontmatter: ' + (errorText(error)) }
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'frontmatter must be a YAML mapping' }
  }
  const record = data as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') return { error: 'frontmatter requires a name field' }
  if (!isSkillName(name)) return { error: 'invalid skill name "' + name + '" (must be kebab-case)' }
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  if (description === '') return { error: 'frontmatter requires a description field' }
  const whenToUse = typeof record.whenToUse === 'string' && record.whenToUse.trim() !== '' ? record.whenToUse.trim() : undefined
  if (Object.hasOwn(record, 'disableModelInvocation')) return { error: 'frontmatter field "disableModelInvocation" is unsupported; use "disable-model-invocation"' }
  if (Object.hasOwn(record, 'modelInvocable')) return { error: 'frontmatter field "modelInvocable" is unsupported; use "disable-model-invocation"' }
  if (Object.hasOwn(record, 'userInvocable')) return { error: 'frontmatter field "userInvocable" is unsupported; use "user-invocable"' }
  let invocation: { modelInvocable: boolean; userInvocable: boolean }
  try {
    const disableModel = frontmatterBoolean(record, 'disable-model-invocation')
    const userInvocable = frontmatterBoolean(record, 'user-invocable')
    invocation = { modelInvocable: disableModel !== true, userInvocable: userInvocable !== false }
  } catch (error) {
    return { error: errorText(error) }
  }
  return { value: { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}), invocation, content: (match[2] ?? '').trim() } }
}

/**
 * Repair bare scalar fields that contain an unquoted colon (e.g. `description: Build for AWS: ECS`)
 * or an invalid flow-like scalar (`@`, `` ` ``, `[`, `{`). Mirrors codex `repair_frontmatter_scalar_fields`:
 * line-oriented, only touches lines where quoting makes the YAML valid, and preserves block scalars.
 * Returns the repaired frontmatter string when at least one line was quoted, otherwise null.
 */
function repairFrontmatterScalarFields(frontmatter: string): string | null {
  let changed = false
  let blockScalarIndent: number | null = null
  const repairedLines: string[] = []
  for (const line of frontmatter.split('\n')) {
    const indent = line.search(/[^ ]/)
    const effectiveIndent = indent === -1 ? line.length : indent
    if (blockScalarIndent !== null) {
      if (line.trim() === '' || effectiveIndent > blockScalarIndent) {
        repairedLines.push(line)
        continue
      }
      blockScalarIndent = null
    }
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      repairedLines.push(line)
      continue
    }
    const key = line.slice(0, colonIndex)
    const value = line.slice(colonIndex + 1)
    if (key.trim() === '' || value.length === 0 || !/^\s/.test(value)) {
      repairedLines.push(line)
      continue
    }
    const trimmedStart = value.trimStart()
    const leadingWhitespace = value.slice(0, value.length - trimmedStart.length)
    let scalar = trimmedStart
    let comment = ''
    // Split trailing `# comment` only when `#` is preceded by whitespace and
    // followed by whitespace/end (YAML comment rule). This preserves `#1` as content.
    for (let idx = 0; idx < trimmedStart.length; idx += 1) {
      if (trimmedStart[idx] === '#') {
        const prev = idx === 0 ? ' ' : trimmedStart[idx - 1]
        const next = idx + 1 < trimmedStart.length ? trimmedStart[idx + 1] : ' '
        if (/\s/.test(prev) && /\s/.test(next)) {
          const commentStart = trimmedStart.slice(0, idx).trimEnd().length
          scalar = trimmedStart.slice(0, commentStart)
          comment = trimmedStart.slice(commentStart)
          break
        }
      }
    }
    scalar = scalar.trimEnd()
    if (scalar === '') {
      repairedLines.push(line)
      continue
    }
    const firstChar = scalar[0]
    if (firstChar === '|' || firstChar === '>') {
      blockScalarIndent = effectiveIndent
      repairedLines.push(line)
      continue
    }
    if (firstChar === "'" || firstChar === '"') {
      repairedLines.push(line)
      continue
    }
    let hasColonSeparator = false
    for (let i = 0; i < scalar.length - 1; i += 1) {
      if (scalar[i] === ':' && /\s/.test(scalar[i + 1])) {
        hasColonSeparator = true
        break
      }
    }
    let invalidFlowLike = false
    if ((firstChar === '[' || firstChar === '{' || firstChar === '@' || firstChar === '`')) {
      try {
        load(scalar)
      } catch {
        invalidFlowLike = true
      }
    }
    if (!hasColonSeparator && !invalidFlowLike) {
      repairedLines.push(line)
      continue
    }
    const quotedScalar = "'" + scalar.replace(/'/g, "''") + "'"
    repairedLines.push(key + ':' + leadingWhitespace + quotedScalar + comment)
    changed = true
  }
  return changed ? repairedLines.join('\n') : null
}

/** Try to repair a SKILL.md's frontmatter in place (unquoted colon etc.). Returns the new file text or null when not fixable. */
export function repairFrontmatterFileText(text: string): string | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (match === null) return null
  const repaired = repairFrontmatterScalarFields(match[1])
  if (repaired === null) return null
  try {
    load(repaired)
  } catch {
    return null
  }
  const body = match[2] ?? ''
  return '---\n' + repaired + '\n---' + (body !== '' ? '\n' + body : '')
}

/** Official boolean grammar: true/false, 1/0, and the common string spellings. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new TypeError('frontmatter field "' + key + '" must be a boolean')
}
