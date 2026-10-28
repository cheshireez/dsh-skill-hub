/**
 * 技能内容审计：安装前拦截与常驻体检共用的一套纯函数规则。
 *
 * 两条设计约束：
 * 1. 零依赖、纯字符串处理。宿主每 5 秒轮询一次 /catalog，扫描必须廉价，
 *    否则面板响应时间会随技能数量线性变慢（与 scanDiagnostics 同一理由）。
 * 2. 规则只认结构特征（不可见字符、命令管道、凭据路径），不做语义判断。
 *    语义/LLM 判断误报率高且要模型调用，不属于一个管理器的职责边界；
 *    这里的目标是「让藏起来的东西显形」，不是「判定作者意图」。
 *
 * 两级严重度：
 * - `block`：安装阶段拒绝落盘。只用于「没有任何正当用途」的特征 ——
 *   裸 ESC 控制字符、Unicode 标签字符、双向控制符、以及体积越界。
 * - `warn`：落盘但标记。零宽字符、危险命令、凭据路径、超长描述都可能
 *   出现在正常技能里（比如一个教人用 curl 的技能），交给人判断。
 */

/** 规则 id：稳定，测试与文案都按它断言。 */
export type AuditRuleId =
  | 'ansi-escape'
  | 'unicode-tag'
  | 'bidi-control'
  | 'zero-width'
  | 'dangerous-command'
  | 'credential-path'
  | 'file-too-large'
  | 'bundle-too-large'
  | 'too-many-files'
  | 'description-too-long'

export type AuditSeverity = 'block' | 'warn'

/** 一条审计发现。`file` 相对技能目录，便于在面板上直接定位。 */
export interface AuditFinding {
  rule: AuditRuleId
  severity: AuditSeverity
  file: string
  /** 1 起行号；整文件级规则（体积、文件数）省略。 */
  line?: number
  message: string
}

/** 单文件字节上限：技能是纯文本加少量脚本，2 MiB 已远超正常体积。 */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024
/** 单个技能总字节上限。 */
export const MAX_SKILL_BUNDLE_BYTES = 10 * 1024 * 1024
/** 单个技能文件数上限。 */
export const MAX_SKILL_FILES = 500
/** agentskills.io 规范对 description 的硬上限。 */
export const MAX_DESCRIPTION_CHARS = 1024

/** 裸 ESC —— 终端转义注入（CWE-150）的起点，正常技能正文不含。 */
const ANSI_RE = /\u001B/
/** Unicode 标签字符区，唯一用途是承载不可见文本。 */
const UNICODE_TAG_RE = /[\u{E0000}-\u{E007F}]/u
/** 双向控制符：Trojan Source 式视觉重排。 */
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/
/** 零宽字符：可能来自从网页复制的正文，也可能用于隐藏内容。 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/

/**
 * 危险命令：只匹配「下载后直接执行」这一族，也就是审计报告里出现频率最高、
 * 且人类肉眼最容易滑过去的那几种形态。普通的 `curl URL` 取数据不在此列。
 */
const DANGEROUS_COMMANDS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, label: 'remote script piped straight into a shell' },
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?python[0-9.]*\b/, label: 'remote script piped straight into python' },
  { re: /\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/, label: 'base64 payload decoded into a shell' },
  { re: /\beval\s+["']?\$\(\s*(?:curl|wget)\b/, label: 'eval of a downloaded command' },
  { re: /\bnc\b[^\n]*\s-e\s/, label: 'netcat with command execution' },
  { re: /\/dev\/tcp\//, label: 'raw TCP socket via /dev/tcp' },
]

/** 凭据路径：技能正文提到这些路径本身未必有恶意，但值得让人看一眼上下文。 */
const CREDENTIAL_PATHS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /(?:^|[\s"'`/])\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)\b/, label: 'SSH private key' },
  { re: /(?:^|[\s"'`/])\.aws\/credentials\b/, label: 'AWS credentials file' },
  { re: /(?:^|[\s"'`/])\.netrc\b/, label: 'netrc credentials file' },
  { re: /Library\/Keychains\b/, label: 'macOS keychain' },
  { re: /(?:^|[\s"'`])\.docker\/config\.json\b/, label: 'Docker registry credentials' },
  { re: /(?:^|\s)\/etc\/shadow\b/, label: 'system password database' },
]

/** 1 起行号（按 `\n` 计）。 */
function lineOf(text: string, index: number): number {
  let line = 1
  const end = Math.min(index, text.length)
  for (let i = 0; i < end; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/** 首个匹配位置与总数。每次新建带 `g` 的正则，避免 lastIndex 跨调用残留。 */
function collect(text: string, re: RegExp): { first: number; count: number } {
  const global = new RegExp(re.source, 'gu')
  let first = -1
  let count = 0
  let match: RegExpExecArray | null
  while ((match = global.exec(text)) !== null) {
    if (first === -1) first = match.index
    count += 1
    if (match[0].length === 0) global.lastIndex += 1
  }
  return { first, count }
}

/**
 * 审计一段技能文本（SKILL.md 正文、脚本、参考文档都适用）。
 * 纯函数：同样的输入永远给同样的结果，便于单测与「改动前后对比」。
 */
export function auditSkillText(relativePath: string, text: string): AuditFinding[] {
  const findings: AuditFinding[] = []
  // 文件开头的 BOM 是合法编码标记，不算零宽隐藏；先剥掉再检测。
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const push = (rule: AuditRuleId, severity: AuditSeverity, message: string, index: number): void => {
    findings.push({ rule, severity, file: relativePath, line: lineOf(body, index), message })
  }

  if (ANSI_RE.test(body)) {
    push('ansi-escape', 'block', 'contains a raw ESC control character — it can rewrite what a terminal displays (escape-sequence injection, CWE-150)', body.search(ANSI_RE))
  }

  const tags = collect(body, UNICODE_TAG_RE)
  if (tags.count > 0) {
    push('unicode-tag', 'block', `contains ${tags.count} invisible Unicode tag character(s); text hidden there is not rendered by any editor, so a reviewer cannot see what the agent reads`, tags.first)
  }

  const bidi = collect(body, BIDI_RE)
  if (bidi.count > 0) {
    push('bidi-control', 'block', `contains ${bidi.count} bidirectional control character(s); they can make the file read differently than it executes`, bidi.first)
  }

  const zeroWidth = collect(body, ZERO_WIDTH_RE)
  if (zeroWidth.count > 0) {
    push('zero-width', 'warn', `contains ${zeroWidth.count} zero-width character(s); usually a copy-paste artifact, but they can also split a keyword so a reviewer's search misses it`, zeroWidth.first)
  }

  for (const { re, label } of DANGEROUS_COMMANDS) {
    const hit = re.exec(body)
    if (hit !== null && hit.index !== undefined) {
      push('dangerous-command', 'warn', `contains ${label}: \`${hit[0].trim().slice(0, 120)}\``, hit.index)
      break
    }
  }

  for (const { re, label } of CREDENTIAL_PATHS) {
    const hit = re.exec(body)
    if (hit !== null && hit.index !== undefined) {
      push('credential-path', 'warn', `references ${label}; check the surrounding instructions actually need it`, hit.index)
      break
    }
  }

  return findings
}

/** description 超出规范上限：部分客户端会截断，技能因此静默失去自动激活能力。 */
export function auditDescription(file: string, description: string): AuditFinding[] {
  if (description.length <= MAX_DESCRIPTION_CHARS) return []
  return [{
    rule: 'description-too-long',
    severity: 'warn',
    file,
    message: `description is ${description.length} chars; the Agent Skills spec caps it at ${MAX_DESCRIPTION_CHARS} and longer ones get truncated by clients, which silently stops the skill from auto-activating`,
  }]
}

/** 一个待落盘/待检查的技能文件。`text` 只在能当作文本读时提供。 */
export interface AuditBundleFile {
  /** 相对技能目录的路径。 */
  path: string
  size: number
  /** 文本内容；二进制或未下载时省略。 */
  text?: string
}

/**
 * 审计一个完整技能目录：体积/数量上限 + 每个文本文件的规则扫描。
 * `block` 级发现（体积越界）意味着不该落盘；文本级 `block` 由调用方决定。
 */
export function auditSkillBundle(files: readonly AuditBundleFile[], description?: string): AuditFinding[] {
  const findings: AuditFinding[] = []
  if (files.length > MAX_SKILL_FILES) {
    findings.push({
      rule: 'too-many-files',
      severity: 'block',
      file: '.',
      message: `skill has ${files.length} files; the hub imports at most ${MAX_SKILL_FILES} per skill`,
    })
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
    findings.push({
      rule: 'bundle-too-large',
      severity: 'block',
      file: '.',
      message: `skill is ${formatBytes(totalBytes)} in total; the hub imports at most ${formatBytes(MAX_SKILL_BUNDLE_BYTES)} per skill`,
    })
  }
  for (const file of files) {
    if (file.size > MAX_SKILL_FILE_BYTES) {
      findings.push({
        rule: 'file-too-large',
        severity: 'block',
        file: file.path,
        message: `${formatBytes(file.size)} is over the ${formatBytes(MAX_SKILL_FILE_BYTES)} per-file limit`,
      })
      continue
    }
    if (file.text !== undefined) findings.push(...auditSkillText(file.path, file.text))
  }
  if (description !== undefined) findings.push(...auditDescription('SKILL.md', description))
  return findings
}

/** 阻断性发现的单行摘要（导入失败时的错误文本）。 */
export function blockingReason(findings: readonly AuditFinding[]): string | undefined {
  const blocked = findings.filter((finding) => finding.severity === 'block')
  if (blocked.length === 0) return undefined
  const head = blocked.slice(0, 3).map((finding) => `${finding.file}${finding.line !== undefined ? ':' + String(finding.line) : ''} ${finding.message}`)
  const rest = blocked.length > head.length ? ` (+${blocked.length - head.length} more)` : ''
  return 'skill rejected by content audit: ' + head.join('; ') + rest
}

/** 字节数的人读形式（诊断文案用）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
