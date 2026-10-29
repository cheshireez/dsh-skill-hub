/**
 * 审计警告的线格式。
 *
 * 与 `skillfs/audit.ts` 的 `AuditFinding` 有意区分：这里只承载 `warn` 级。
 * 阻断级的发现不会出现在响应里 —— 它会让整个技能被拒绝，原因写在
 * `error` 文本里（用户要看的是「为什么装不上」，不是一串规则名）。
 *
 * 单独成文件而不是挂在某个域下：ZIP 导入与市场直装是两条独立的入口，
 * 但它们必须报告同一套东西，否则前端要为同一个概念写两遍渲染。
 */

export interface AuditWarningView {
  /** 规则 id（`skillfs/audit.ts` 的 `AuditRuleId`），前端按它做文案映射。 */
  rule: string
  severity: 'warn'
  /** 相对技能目录的路径，便于直接定位。 */
  file: string
  /** 1 起行号；整文件级规则（体积、文件数）省略。 */
  line?: number
  message: string
}
