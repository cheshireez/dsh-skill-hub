/**
 * Skill security review: a local, offline heuristic scan of the files about to
 * be installed into a skill root.
 *
 * Why this exists: skills are prompt payloads plus optional scripts. Once
 * installed, SKILL.md is injected into the model context and any bundled script
 * can be run by the agent, so a third-party skill is executable code with an
 * instruction channel attached. The market warning ("install = you trust the
 * author") puts that judgement on the user, but a user cannot read every file
 * before clicking install. This module gives that click a floor.
 *
 * Design constraints:
 *   - Pure and synchronous: no network, no writes, no execution of any
 *     reviewed content. It runs inside the download path, so it must never
 *     throw on a weird file — an unreadable entry is a skip, not a crash.
 *   - Paths are normalised to POSIX before matching. `path.relative()` yields
 *     `a\b` on Windows, and every rule here is written with `/`; without the
 *     normalisation the whole filename blacklist silently matches nothing.
 *   - `lstat`, not `stat`: a symlink to /etc/passwd must be reported, not
 *     followed and read as an ordinary file.
 */

import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'

/** How a finding is treated: `high` blocks the install, `medium` only warns. */
export type Severity = 'high' | 'medium'

/** One rule hit. */
export interface Finding {
  /** Stable rule id (used in reports and tests). */
  rule: string
  severity: Severity
  /** File path relative to the skill directory, POSIX separators. */
  file: string
  /** 1-based line number; 0 when the rule is file-level. */
  line: number
  /** Short excerpt of the offending text (truncated). */
  snippet: string
  /** Human-readable description of what the rule guards against. */
  message: string
}

/** Overall verdict for one skill. */
export type Verdict = 'pass' | 'warn' | 'blocked'

/** Result of reviewing one skill directory. */
export interface SecurityReport {
  verdict: Verdict
  findings: Finding[]
  scanned: {
    /** Text files actually inspected. */
    files: number
    /** Entries skipped (binary, unreadable, not a regular file). */
    skipped: number
    bytes: number
  }
  summary: string
  at: number
}

/** Extensions treated as text. Anything else is skipped (binaries match by name). */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.yml', '.yaml', '.json', '.jsonc', '.toml', '.ini', '.cfg',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.rb', '.pl', '.php', '.go', '.rs',
  '.sql', '.env', '.example', '.template', '.csv', '.xml', '.html', '.css',
])

/** File-name blacklist: a match is `high` without reading the content. */
const FILENAME_BLOCKLIST: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: /(^|\/)\.env$/i, message: 'skill bundles a .env credentials file' },
  {
    pattern: /(^|\/)(id_[a-z0-9_]*|authorized_keys|authorized_keys2|known_hosts|credentials|secrets?\.json|\.npmrc|\.netrc|\.htpasswd)$/i,
    message: 'skill bundles a credentials file (private key / authorized_keys / password file)',
  },
  {
    pattern: /\.(pem|p12|pfx|keystore|jks|ppk|asc|gpg|kdbx?|1password)$/i,
    message: 'skill bundles a certificate, private key or key store',
  },
  {
    pattern: /\.(exe|dll|so|dylib|bin|msi|appimage|deb|rpm|apk|ipa|jar)$/i,
    message: 'skill bundles an executable binary',
  },
  {
    pattern: /\.(scr|lnk|url|webloc|desktop|command|app|workflow|service|plist)$/i,
    message: 'skill bundles a launchable / auto-start file type',
  },
]

/** Suspicious entry paths one level above the skill directory. */
const SUSPICIOUS_ENTRY_NAMES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: /^\.\./, message: 'path contains an upward traversal segment' },
  {
    pattern: /(^|\/)\.(ssh|aws|azure|kube|docker|npmrc|netrc|bashrc|zshrc|profile|bash_profile)$/i,
    message: 'skill attempts to write into a home-directory credentials / startup path',
  },
]

/**
 * Line rules. SKILL.md is injected straight into the model context, so the
 * prompt-injection family is `high`: those lines are not "a risk", they are the
 * payload.
 */
const LINE_RULES: ReadonlyArray<{ id: string; severity: Severity; message: string; pattern: RegExp }> = [
  // ------------------------------------------------------------ egress
  {
    id: 'net.exfil.curl-upload',
    severity: 'high',
    message: 'uploads data to an external address (curl -d / -T / --upload-file)',
    pattern: /curl\b[^\n]*\s(-d|--data|--data-binary|--data-raw|--upload-file|-T)(\s|=)/i,
  },
  {
    id: 'net.exfil.wget-post',
    severity: 'high',
    message: 'posts data to an external address (wget --post-data / --post-file)',
    pattern: /wget\b[^\n]*\s(--post-data|--post-file)(\s|=)/i,
  },
  {
    id: 'net.exfil.request-payload',
    severity: 'high',
    message: 'sends local data over HTTP (requests.post / axios.post and friends)',
    pattern: /\b(requests|httpx|aiohttp|axios|got|superagent|node-fetch)\b[^\n]*\.(post|put|patch)\s*\(/i,
  },
  {
    id: 'net.exfil.reqbin',
    severity: 'high',
    message: 'sends data to a requestbin / webhook collection site',
    pattern: /(requestbin\.|webhook\.site|pipedream\.net|beeceptor\.|ngrok\.io|ngrok-free\.|requestcatcher\.|hookbin\.|postb\.in|tcpdump\.email)/i,
  },
  {
    id: 'net.dns.exfil',
    severity: 'high',
    message: 'possible DNS exfiltration channel (command output embedded in a lookup)',
    pattern: /(dig|nslookup|host)\b[^\n]*\$\(/i,
  },

  // ------------------------------------------------------------ credentials
  {
    id: 'cred.read.files',
    severity: 'high',
    message: 'reads local credential files (SSH keys / .aws / .npmrc / .netrc / cloud credentials)',
    pattern: /(\.ssh\/(id_[a-z0-9_]+|authorized_keys)|\.aws\/(credentials|config)|\.azure\/|\.kube\/config|\.npmrc|\.netrc|\.docker\/config\.json|\.git-credentials|\.config\/gcloud)/i,
  },
  {
    id: 'cred.read.env',
    severity: 'medium',
    message: 'reads secret-ish environment variables (API key / token / secret / password)',
    pattern: /process\.env[^\n]*(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)/i,
  },
  {
    id: 'cred.private-key-body',
    severity: 'high',
    message: 'file contains a private key body — a skill must never ship a key',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----/,
  },
  {
    id: 'cred.read.keychain',
    severity: 'high',
    message: 'reads the system keychain / credential manager',
    pattern: /(security\s+find-generic-password|cmdkey\s*\/list|keyring\.get_password)/i,
  },

  // ------------------------------------------------------------ download-and-execute
  {
    id: 'exec.download-pipe',
    severity: 'high',
    message: 'downloads remote content and pipes it straight into an interpreter',
    pattern: /(curl|wget)\b[^\n]*(\|\s*(sudo\s+)?(bash|sh|zsh|python[0-9.]*|perl|ruby|pwsh|powershell)|-o\s+[^\s|]+\s*&&\s*(sudo\s+)?(bash|sh|chmod))/i,
  },
  {
    id: 'exec.remote-source',
    severity: 'high',
    message: 'fetches and executes remote content (Invoke-Expression / eval of a response)',
    pattern: /(Invoke-Expression|Invoke-WebRequest[^\n]*-UseBasicParsing|iex\s*\(?\s*\(?New-Object|python[^\n]*-c[^\n]*urllib|eval\s*\(\s*(requests|urllib|fetch|http))/i,
  },
  {
    id: 'exec.dynamic-eval',
    severity: 'medium',
    message: 'executes a string dynamically (eval / subprocess / child_process) — review the intent',
    pattern: /\b(eval|exec)\s*\(|\bnew\s+Function\s*\(|Function\s*\(\s*['"`]|os\.system\s*\(|subprocess\.(run|Popen|call|check_output)\s*\(|child_process\.(exec|execSync)\s*\(/i,
  },

  // ------------------------------------------------------------ destructive / persistence
  {
    id: 'fs.destructive',
    severity: 'high',
    message: 'irreversible deletion or disk overwrite (rm -rf / dd / mkfs / shred / fork bomb)',
    pattern: /(rm\s+-rf\s+(\/|~|\$\{?HOME)|\bdd\s+if=|\bmkfs|\bshred\s|:\(\)\{)/i,
  },
  {
    id: 'persist.schedule',
    severity: 'high',
    message: 'installs auto-start / scheduled persistence (crontab / systemd / launchd / schtasks / registry Run)',
    pattern: /(crontab\s|>\s*\/etc\/cron|systemctl\s+enable|launchctl\s+load|schtasks\s+\/create|Register-ScheduledTask|HKLM:|HKCU:)/i,
  },
  {
    id: 'persist.startup-file',
    severity: 'high',
    message: 'writes shell startup files (.bashrc / .zshrc / .profile) for persistence',
    pattern: /(>>?\s*~?\/(\.bashrc|\.zshrc|\.profile|\.bash_profile))/i,
  },
  {
    id: 'fs.home-write',
    severity: 'medium',
    message: 'writes into the home directory (a skill should stay in its own directory and the workspace)',
    pattern: /(>\s*~\/|tee\s+~\/|>\s*\$HOME\/|>\s*\$\{HOME\}\/)/i,
  },

  // ------------------------------------------------------------ prompt injection
  {
    id: 'prompt.ignore-instructions',
    severity: 'high',
    message: 'prompt injection: instructs the model to ignore existing instructions',
    pattern: /(ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)|ignore\s+the\s+system\s+prompt|disregard\s+(all\s+)?(previous|prior)\s+instructions)/i,
  },
  {
    id: 'prompt.exfil-instruction',
    severity: 'high',
    message: 'prompt injection: instructs the model to read and send local sensitive files',
    pattern: /(read|cat|print|show|display|reveal)\b[^\n]{0,60}(\.ssh|\.aws|\.env|\.npmrc|api[_-]?key|password|secret|token|credential)/i,
  },
  {
    id: 'prompt.silent-exec',
    severity: 'high',
    message: 'prompt injection: tells the model to act without informing the user',
    pattern: /(do\s+not\s+(tell|inform|mention|disclose)\s+(the\s+)?user|without\s+(asking|informing|telling)\s+the\s+user|keep\s+this\s+(hidden|secret)\s+from\s+the\s+user|silently\s+(run|execute|do))/i,
  },
  {
    id: 'prompt.credential-ask',
    severity: 'high',
    message: 'prompt injection: asks for an API key / password / token in plain text',
    pattern: /\b(paste|enter|provide|share|type|supply|give me|input)\b[^\n]{0,40}\b(your\s+)?(api[_\s-]?key|secret\s*key|access\s*key|password|passphrase|private\s*key|secret\s*token|access\s*token|credentials|credential)\b/i,
  },
  {
    id: 'prompt.override-safety',
    severity: 'high',
    message: 'asks to bypass the safety policy / sandbox / permission limits',
    pattern: /(disable\s+(the\s+)?sandbox|bypass\s+(the\s+)?sandbox|run\s+with\s+(full|elevated|admin|sudo)\s+(access|privileges)|--danger-full-access|no\s+sandbox|escape\s+(the\s+)?(sandbox|container|jail))/i,
  },
  {
    id: 'prompt.auto-run-no-confirm',
    severity: 'medium',
    message: 'asks to act without confirmation (skip approvals / edit blindly)',
    pattern: /(never\s+ask\s+for\s+confirmation|skip\s+all\s+confirmations|bypass\s+(approval|confirmation|permission)|auto-?approve|without\s+waiting\s+for\s+approval)/i,
  },
  {
    id: 'prompt.data-collect',
    severity: 'medium',
    message: 'instructs the model to collect host details (hostname / IP / OS version)',
    pattern: /(hostname|whoami|ipconfig|ifconfig|uname\s+-a|systeminfo|env\s*\|\s*grep)/i,
  },

  // ------------------------------------------------------------ obfuscation
  {
    id: 'obfuscate.reverse-shell',
    severity: 'high',
    message: 'looks like a reverse shell (/dev/tcp, nc -e, python socket callback)',
    pattern: /(\/dev\/tcp\/|nc\b[^\n]*\s-e\s|ncat[^\n]*\s-e\s|bash\s+-i\s+>&\s*\/dev\/tcp|python[^\n]*socket[^\n]*connect)/i,
  },
  {
    id: 'obfuscate.decode-exec',
    severity: 'high',
    message: 'decodes and then executes (base64 -d | sh style hidden execution)',
    pattern: /(base64\s+(-d|--decode|-D)|openssl\s+base64\s+-d|atob\s*\(|\bxxd\s+-r\b)[^\n]{0,120}(\|\s*(bash|sh|eval|perl|python)|&&\s*(bash|sh|eval)|-o\s+[^\s]+)/i,
  },
  {
    id: 'obfuscate.charcode',
    severity: 'medium',
    message: 'rebuilds code from character codes (fromCharCode / chr), a common evasion trick',
    pattern: /(String\.fromCharCode|chr\(\s*\d+|\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){5,}|\\u00[0-9a-f]{2}(\\u00[0-9a-f]{2}){3,})/i,
  },
]

/** Whole-file rules: line-independent checks. */
const WHOLE_RULES: ReadonlyArray<{
  id: string
  severity: Severity
  message: string
  test(text: string): { line: number; snippet: string } | null
}> = [
  {
    id: 'obfuscate.big-base64',
    severity: 'high',
    message: 'contains a very long base64 blob (>400 chars) — no reason for a skill to smuggle a payload',
    test(text) {
      const match = /[A-Za-z0-9+/]{400,}={0,2}/.exec(text)
      if (match === null) return null
      return { line: lineOfOffset(text, match.index), snippet: match[0].slice(0, 60) + '…' }
    },
  },
  {
    id: 'text.zero-width',
    severity: 'high',
    message: 'hidden zero-width characters (commonly used to hide an invisible instruction)',
    test(text) {
      const match = /[\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff\u180e\u00ad]/.exec(text)
      if (match === null) return null
      const code = match[0].codePointAt(0) ?? 0
      return { line: lineOfOffset(text, match.index), snippet: '(invisible char U+' + code.toString(16).toUpperCase() + ')' }
    },
  },
  {
    id: 'text.bidi-override',
    severity: 'high',
    message: 'Unicode bidirectional override characters (displayed and parsed content can differ)',
    test(text) {
      const match = /[\u202a-\u202e\u2066-\u2069]/.exec(text)
      if (match === null) return null
      return { line: lineOfOffset(text, match.index), snippet: '(bidi override)' }
    },
  },
  {
    id: 'size.oversize',
    severity: 'medium',
    message: 'a single file exceeds 1MB, far beyond a reasonable skill document',
    test(text) {
      if (text.length <= 1024 * 1024) return null
      return { line: 0, snippet: '(' + Math.round(text.length / 1024) + ' KB)' }
    },
  },
]

/** Text cap per file: beyond this the head is reviewed and the rest ignored. */
const SCAN_TEXT_LIMIT = 2 * 1024 * 1024

/** Hard cap on entries per skill so a giant repo cannot stall the install loop. */
const MAX_FILES = 2000

/** Sentinel appended to a path that is not a regular file. */
const NOT_REGULAR = '\u0000NOTREGULAR'

/** POSIX-normalise a path (`a\b` → `a/b`). Every rule pattern assumes `/`. */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

/** 1-based line number for a character offset. */
function lineOfOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/** Severity order for sorting (high first). */
function rank(severity: Severity): number {
  return severity === 'high' ? 0 : 1
}

/** Lowercase extension including the dot, or '' when there is none. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/** Whether a path is reviewed as text. */
function isTextFile(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  const ext = extOf(name)
  if (ext !== '') return TEXT_EXTENSIONS.has(ext)
  // No extension: treat conventional script/document names as text.
  return /^(dockerfile|makefile|gnumakefile|license|readme|procfile|justfile)$/i.test(name)
}

/**
 * Collect file paths under `dir`. Symlinks and special files are reported via
 * the NOT_REGULAR suffix instead of being followed — `statSync` would follow a
 * symlink and read, say, /etc/passwd as an ordinary file.
 */
function listFiles(dir: string, base: string, out: string[], skipped: { count: number }): void {
  if (out.length >= MAX_FILES) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = join(dir, name)
    let info
    try {
      info = lstatSync(full)
    } catch {
      skipped.count += 1
      continue
    }
    // Check the link before the directory/regular checks: a symlinked directory
    // must not be recursed into either.
    if (info.isSymbolicLink()) {
      out.push(toPosix(relative(base, full)) + NOT_REGULAR)
      continue
    }
    if (info.isDirectory()) {
      listFiles(full, base, out, skipped)
      continue
    }
    if (!info.isFile()) {
      out.push(toPosix(relative(base, full)) + NOT_REGULAR)
      continue
    }
    out.push(toPosix(relative(base, full)))
  }
}

/**
 * Review one skill directory that is already on disk — in practice the
 * dot-prefixed temporary directory produced by the download stage.
 *
 * @param skillDir - absolute path of the skill directory (must contain SKILL.md)
 * @param skillName - skill name, used in the summary
 * @returns the full report; the caller decides whether to install from `verdict`
 */
export function scanSkillDir(skillDir: string, skillName: string): SecurityReport {
  const findings: Finding[] = []
  const skipped = { count: 0 }
  const relPaths: string[] = []
  listFiles(skillDir, skillDir, relPaths, skipped)

  let bytes = 0
  let scannedFiles = 0

  for (const rawRel of relPaths) {
    const notRegular = rawRel.endsWith(NOT_REGULAR)
    const rel = notRegular ? rawRel.slice(0, -NOT_REGULAR.length) : rawRel

    if (notRegular) {
      findings.push({ rule: 'fs.entry.not-regular', severity: 'high', file: rel, line: 0, snippet: '', message: 'skill contains a non-regular entry (symlink / special file)' })
      skipped.count += 1
      continue
    }

    // 1) Filename blacklist / suspicious path: decided without reading content.
    let blockedByName = false
    for (const entry of FILENAME_BLOCKLIST) {
      if (entry.pattern.test(rel)) {
        findings.push({ rule: 'filename.blocklist', severity: 'high', file: rel, line: 0, snippet: '', message: entry.message })
        blockedByName = true
        break
      }
    }
    if (!blockedByName) {
      for (const entry of SUSPICIOUS_ENTRY_NAMES) {
        if (entry.pattern.test(rel)) {
          findings.push({ rule: 'path.suspicious', severity: 'high', file: rel, line: 0, snippet: '', message: entry.message })
          blockedByName = true
          break
        }
      }
    }
    if (blockedByName) continue

    // 2) Non-text files are not reviewed by content.
    if (!isTextFile(rel)) {
      skipped.count += 1
      continue
    }

    let text: string
    try {
      const buffer = readFileSync(join(skillDir, rel))
      bytes += buffer.byteLength
      text = buffer.toString('utf8').slice(0, SCAN_TEXT_LIMIT)
    } catch {
      skipped.count += 1
      continue
    }
    scannedFiles += 1

    // 3) Whole-file rules.
    for (const rule of WHOLE_RULES) {
      const hit = rule.test(text)
      if (hit !== null) {
        findings.push({ rule: rule.id, severity: rule.severity, file: rel, line: hit.line, snippet: hit.snippet, message: rule.message })
      }
    }

    // 4) Line rules.
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line === '') continue
      for (const rule of LINE_RULES) {
        if (rule.pattern.test(line)) {
          findings.push({
            rule: rule.id,
            severity: rule.severity,
            file: rel,
            line: i + 1,
            snippet: line.trim().slice(0, 160),
            message: rule.message,
          })
        }
      }
    }
  }

  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line)

  const high = findings.filter((f) => f.severity === 'high').length
  const medium = findings.length - high
  const verdict: Verdict = high > 0 ? 'blocked' : medium > 0 ? 'warn' : 'pass'

  const parts = ['scanned ' + scannedFiles + ' file(s) in "' + skillName + '"']
  if (high > 0) parts.push(high + ' high-risk finding(s)')
  if (medium > 0) parts.push(medium + ' medium-risk finding(s)')
  const tail = verdict === 'blocked' ? ' → blocked' : verdict === 'warn' ? ' → installed with warnings' : ' → passed'
  const summary = parts.join(', ') + tail

  return { verdict, findings, scanned: { files: scannedFiles, skipped: skipped.count, bytes }, summary, at: Date.now() }
}

/** Render a report as Markdown (logs, or shown to the user). */
export function renderReport(report: SecurityReport): string {
  const lines: string[] = []
  lines.push('# Skill security report')
  lines.push('')
  lines.push('- verdict: **' + (report.verdict === 'blocked' ? 'blocked' : report.verdict === 'warn' ? 'installed with warnings' : 'passed') + '**')
  lines.push('- ' + report.summary)
  lines.push('')
  if (report.findings.length === 0) {
    lines.push('No risk findings.')
    return lines.join('\n')
  }
  const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  lines.push('| severity | rule | file | line | description |')
  lines.push('|---|---|---|---|---|')
  for (const finding of report.findings.slice(0, 60)) {
    lines.push('| ' + finding.severity + ' | ' + finding.rule + ' | ' + escapeCell(finding.file) + ' | ' + (finding.line > 0 ? finding.line : '-') + ' | ' + escapeCell(finding.message) + ' |')
  }
  return lines.join('\n')
}

/** One-line summary for logs and UI, naming the top finding. */
export function shortSummary(report: SecurityReport): string {
  if (report.findings.length === 0) return report.summary
  return report.summary + ' (top finding: ' + report.findings[0].message + ')'
}
