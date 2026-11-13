/**
 * 技能内容审计：安装前拦截与常驻体检共用的一套纯函数规则。
 *
 * 三条设计约束：
 * 1. 零依赖、纯字符串处理。宿主每 5 秒轮询一次 /catalog，扫描必须廉价，
 *    否则面板响应时间会随技能数量线性变慢（与 scanDiagnostics 同一理由）。
 * 2. 规则只认结构特征（不可见字符、命令管道、凭据路径），不做语义判断。
 *    语义/LLM 判断误报率高且要模型调用，不属于一个管理器的职责边界；
 *    这里的目标是「让藏起来的东西显形」，不是「判定作者意图」。
 * 3. 编码伪装不算二进制豁免。文本文件里的 NUL / UTF-16 / 非法 UTF-8
 *    本身就是阻断级发现 —— 否则往 SKILL.md 插一个 NUL 就能整体绕过审计。
 *
 * 两级严重度：
 * - `block`：安装阶段拒绝落盘。只用于「没有任何正当用途」的特征 ——
 *   裸 ESC 控制字符、Unicode 标签字符、双向控制符、编码伪装、体积越界。
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
  | 'suspicious-encoding'

export type AuditSeverity = 'block' | 'warn'

/** 一条审计发现。`file` 相对技能目录，便于在面板上直接定位。 */
export interface AuditFinding {
  rule: AuditRuleId
  severity: AuditSeverity
  file: string
  /** 1 起行号；整文件级规则（体积、文件数、编码伪装）省略。 */
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
/** 双向控制符：Trojan Source 式视觉重排（含 ALM / LRM / RLM）。 */
const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/
/** 零宽字符：可能来自从网页复制的正文，也可能用于隐藏内容。 */
const ZERO_WIDTH_RE = /[\u00AD\u180E\u200B-\u200D\u2060\u2061-\u2064\uFEFF]/

/**
 * 危险命令：只匹配「下载后直接执行」这一族。普通的 `curl URL` 取数据不在此列。
 * 反斜杠续行由 auditSkillText 预先折成空格，所以 `curl URL \⏎ | sh` 也命中。
 */
const DANGEROUS_COMMANDS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, label: 'remote script piped straight into a shell' },
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?python[0-9.]*\b/, label: 'remote script piped straight into python' },
  { re: /\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/, label: 'base64 payload decoded into a shell' },
  { re: /\beval\s+["']?\$\(\s*(?:curl|wget)\b/, label: 'eval of a downloaded command' },
  { re: /\b(?:curl|wget)\b[^\n]*?(?:>|>>|-o\s+)\s*[\w./-]+[^\n]*?(?:&&|;)\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, label: 'downloaded script saved to a file and then executed' },
  { re: /\b(?:ba|z|k)?sh\s*<\(\s*(?:curl|wget)\b/, label: 'process substitution executing a downloaded script' },
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

/** 明确二进制的资源只查体积：把 PNG 字节喂给文本规则只会产生噪声。 */
const BINARY_FILE_RE = /\.(?:png|jpe?g|gif|webp|ico|bmp|avif|svgz|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|pdf|mp3|mp4|wav|ogg|webm|mov|bin|dat|db|sqlite|wasm|so|dll|dylib|exe|pyc|class|jar)$/i

/** 归一化后的可审计文本。`disguised` 表示检测到编码伪装，调用方须阻断。 */
export interface AuditText {
  text: string
  disguised: boolean
}

/**
 * 剥掉 NUL / C0 控制字符 / 替换字符，保留 \t \n \r 与 ESC（ESC 自身是一条
 * block 规则，不能在这里被抹掉），让剩余可见文本仍能命中规则。
 */
function stripHiddenBytes(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\uFFFD]/g, '')
}

/**
 * 把待落盘文件归一化成可审计文本。**所有导入入口必须共用这一个函数**。
 *
 * 旧判据「含 NUL 或解出 U+FFFD 就整体跳过文本规则」是可绕过的：往
 * `SKILL.md` 或 `scripts/*.sh` 插一个 NUL、或把文件存成 UTF-16，就能让
 * 隐藏字符 / 危险命令 / 凭据路径全部失效。现在按「这是什么文件」决定，
 * 而不是按「字节长什么样」：文本类文件一律扫描，编码伪装本身即阻断级
 * 发现；真正的二进制资源仍只查体积。
 */
export function asAuditText(relativePath: string, buffer: Buffer): AuditText | undefined {
  const name = relativePath.split('/').pop() ?? relativePath
  if (BINARY_FILE_RE.test(name)) return undefined

  // UTF-16 LE/BE BOM：解码后仍要扫描，并标记为伪装（技能规范是 UTF-8）。
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: stripHiddenBytes(buffer.subarray(2).toString('utf16le')), disguised: true }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = tmp
    }
    return { text: stripHiddenBytes(swapped.toString('utf16le')), disguised: true }
  }

  // UTF-8 BOM 是合法编码标记，剥掉后不算异常。
  const body = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3) : buffer
  const decoded = body.toString('utf8')
  const disguised = body.includes(0) || decoded.includes('\uFFFD')
  return { text: disguised ? stripHiddenBytes(decoded) : decoded, disguised }
}

/** 预计算每行起点；每个 finding 查行号用二分，避免 O(文件长度 × finding 数)。 */
function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function lineOf(starts: readonly number[], index: number): number {
  let lo = 0
  let hi = starts.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= index) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found + 1
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
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  // 反斜杠续行折成**等长**空格，index 与原文本逐字节对齐（行号不偏），
  // 同时让 `curl URL \⏎ | sh` 这类 shell 单行写法能被规则命中。
  const scanned = body.replace(/\\\r\n/g, '   ').replace(/\\\n/g, '  ')
  const starts = lineStartsOf(body)
  const push = (rule: AuditRuleId, severity: AuditSeverity, message: string, index: number): void => {
    findings.push({ rule, severity, file: relativePath, line: lineOf(starts, index), message })
  }

  if (ANSI_RE.test(scanned)) {
    push('ansi-escape', 'block', 'contains a raw ESC control character — it can rewrite what a terminal displays (escape-sequence injection, CWE-150)', scanned.search(ANSI_RE))
  }

  const tags = collect(scanned, UNICODE_TAG_RE)
  if (tags.count > 0) {
    push('unicode-tag', 'block', `contains ${tags.count} invisible Unicode tag character(s); text hidden there is not rendered by any editor, so a reviewer cannot see what the agent reads`, tags.first)
  }

  const bidi = collect(scanned, BIDI_RE)
  if (bidi.count > 0) {
    push('bidi-control', 'block', `contains ${bidi.count} bidirectional control character(s); they can make the file read differently than it executes`, bidi.first)
  }

  const zeroWidth = collect(scanned, ZERO_WIDTH_RE)
  if (zeroWidth.count > 0) {
    push('zero-width', 'warn', `contains ${zeroWidth.count} zero-width character(s); usually a copy-paste artifact, but they can also split a keyword so a reviewer's search misses it`, zeroWidth.first)
  }

  for (const { re, label } of DANGEROUS_COMMANDS) {
    const hit = re.exec(scanned)
    if (hit !== null && hit.index !== undefined) {
      push('dangerous-command', 'warn', `contains ${label}: \`${hit[0].trim().slice(0, 120)}\``, hit.index)
      break
    }
  }

  for (const { re, label } of CREDENTIAL_PATHS) {
    const hit = re.exec(scanned)
    if (hit !== null && hit.index !== undefined) {
      push('credential-path', 'warn', `references ${label}; check the surrounding instructions actually need it`, hit.index)
      break
    }
  }

  return findings
}

/** description 超出规范上限（按 Unicode 码点计，emoji 不再算 2 个字符）。 */
export function auditDescription(file: string, description: string): AuditFinding[] {
  const length = [...description].length
  if (length <= MAX_DESCRIPTION_CHARS) return []
  return [{
    rule: 'description-too-long',
    severity: 'warn',
    file,
    message: `description is ${length} characters; the Agent Skills spec caps it at ${MAX_DESCRIPTION_CHARS} and longer ones get truncated by clients, which silently stops the skill from auto-activating`,
  }]
}

/** 一个待落盘/待检查的技能文件。`text` 只在能当作文本读时提供。 */
export interface AuditBundleFile {
  /** 相对技能目录的路径。 */
  path: string
  size: number
  /** 文本内容；二进制资源省略。 */
  text?: string
  /** 编码伪装（NUL / UTF-16 / 非法 UTF-8）：文本类文件不该长这样。 */
  disguised?: boolean
}

/**
 * 审计一个完整技能目录：体积/数量上限 + 每个文本文件的规则扫描。
 * `block` 级发现（体积越界、编码伪装、隐藏字符）意味着不该落盘。
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
    if (file.disguised === true) {
      findings.push({
        rule: 'suspicious-encoding',
        severity: 'block',
        file: file.path,
        message: 'text file uses an encoding disguise (NUL bytes, UTF-16, or invalid UTF-8); a normal SKILL.md/script is UTF-8, and hiding bytes here is how an install-time audit gets bypassed',
      })
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
