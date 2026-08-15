/**
 * Built-in skill market: a curated list of community skills that can be
 * installed in one click. Each entry points at a SKILL.md file in a public
 * GitHub repo (raw.githubusercontent.com); the import route downloads,
 * validates, and writes it into the user-dsh root.
 *
 * The current list is the Anthropic Skills reference collection (MIT-adjacent
 * / per-file license terms) — real, maintained skills that are plain
 * SKILL.md + frontmatter and therefore run under dsh as-is.
 */

/** One installable market skill. */
export interface MarketEntry {
  /** Frontmatter name the skill must declare (also the install directory). */
  name: string
  /** One-line summary shown in the market list. */
  description: string
  /** GitHub repository in owner/repo form. */
  repo: string
  /** Path of the SKILL.md file inside the repo (root-relative). */
  path: string
}

/** Curated market rows (verified resolvable at these repo paths). */
export const MARKET: readonly MarketEntry[] = [
  { name: 'docx', description: 'Create, read, and edit Word documents (.docx/.dotx)', repo: 'anthropics/skills', path: 'skills/docx/SKILL.md' },
  { name: 'pdf', description: 'Read, merge, split, and create PDFs', repo: 'anthropics/skills', path: 'skills/pdf/SKILL.md' },
  { name: 'pptx', description: 'Create and edit PowerPoint presentations (.pptx)', repo: 'anthropics/skills', path: 'skills/pptx/SKILL.md' },
  { name: 'xlsx', description: 'Read and edit spreadsheets (.xlsx/.csv)', repo: 'anthropics/skills', path: 'skills/xlsx/SKILL.md' },
  { name: 'skill-creator', description: 'Create and improve Agent Skills', repo: 'anthropics/skills', path: 'skills/skill-creator/SKILL.md' },
]

/** Resolve one market row by name. */
export function marketEntry(name: string): MarketEntry | undefined {
  return MARKET.find((entry) => entry.name === name)
}
