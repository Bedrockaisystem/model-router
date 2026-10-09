import type { RouteTier } from '../types'

export type Verdict = { tier: RouteTier; reason: string; isSure: boolean }

// Work that always stays on the session's own (top) model.
const TOP: ReadonlyArray<[RegExp, string]> = [
  [/\b(architect\w*|system design|design doc|trade-?offs?|scal(e|ing|ability))\b/i, 'architecture'],
  [/\b(secur\w*|vulnerab\w*|exploit|auth[nz]?|authenticat\w*|authori[sz]\w*|permissions?|rls|row level|csrf|xss|injection)\b/i, 'security'],
  [/\b(migrat\w*|schema|alter table|drop table|database|supabase|postgres|sql)\b/i, 'migrations'],
  [/\b(payments?|stripe|billing|invoic\w*|checkout|subscriptions?|refunds?|payouts?)\b/i, 'payments'],
  [/\b(privacy|gdpr|ccpa|pii|personal data|consent|cookies?|data[- ]sharing|retention|telemetry|analytics)\b/i, 'privacy'],
  [/\b(secrets?|credentials?|api keys?|\.env|encrypt\w*|tokens?)\b/i, 'secrets'],
  [/\b(production|deploy\w*|release|rollback|incident|outage|data loss)\b/i, 'production'],
  [/\b(legal|contract|terms of service|liabilit\w*)\b/i, 'legal'],
  [/\b(refactor|rewrite|re-?architect|race condition|concurren\w*|deadlock)\b/i, 'deep change'],
]

// Clearly light work.
const SMALL: ReadonlyArray<[RegExp, string]> = [
  [/\b(typos?|spelling|rename|reword|wording|format(ting)?|lint|prettier)\b/i, 'trivial edit'],
  [/\b(summari[sz]e|summary|tl;?dr|recap|condense)\b/i, 'summary'],
  [/\b(look ?up|where is|where's|what is|what's|which file|find|search|grep|list|show me|count)\b/i, 'lookup'],
  [/\b(run (the )?(tests?|suite|lint|build)|test run|re-?run)\b/i, 'test run'],
  [/\b(readme|changelog|docstring|comment|translate|bump (the )?version)\b/i, 'docs touch-up'],
]

// Real building work that is not protected.
const MID: ReadonlyArray<[RegExp, string]> = [
  [/\b(implement|build|add|create|write|fix|debug|feature|tests? for|update|change|wire|hook up|integrat\w*)\b/i, 'implementation'],
]

const SMALL_MAX_CHARS = 600
const LONG_PROMPT_CHARS = 4000

/**
 * The words a person wrote, without harness wrappers: a Projects wake's
 * system notes, reminders and session context are boilerplate whose words
 * (security, permissions, privacy) would pin every turn to the top model.
 */
export const humanText = (raw: string): string => {
  const stripped = raw
    .replace(/<(system-reminder|system-note|session-context)\b[^>]*>[\s\S]*?<\/\1[^>]*>/gi, ' ')
    .replace(/&lt;session-context[\s\S]*?&lt;\/session-context[^&]*&gt;/gi, ' ')
  const trigger = stripped.match(/<message\b[^>]*trigger="true"[^>]*>([\s\S]*?)<\/message>/i)
  const body = trigger?.[1] ?? stripped

  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const first = (rules: ReadonlyArray<[RegExp, string]>, text: string) =>
  rules.find(([re]) => re.test(text))?.[1]

/** Picks a tier for a task from its text alone; no model call. */
export const classify = (raw: string, longChars = LONG_PROMPT_CHARS): Verdict => {
  const text = humanText(raw)

  if (text.length === 0) {
    return { tier: 'top', reason: 'no text', isSure: false }
  }
  const top = first(TOP, text)
  if (top) {
    return { tier: 'top', reason: top, isSure: true }
  }
  if (text.length > longChars) {
    return { tier: 'top', reason: 'long brief', isSure: true }
  }
  const mid = first(MID, text)
  const small = first(SMALL, text)
  if (small && text.length <= SMALL_MAX_CHARS && (!mid || /\b(typo|rename|format|lint|comment|readme|changelog)\b/i.test(text))) {
    return { tier: 'small', reason: small, isSure: true }
  }
  if (mid || small) {
    return { tier: 'mid', reason: mid ?? small ?? 'implementation', isSure: true }
  }

  return { tier: 'top', reason: 'unclear task', isSure: false }
}

/** Per-thread override typed anywhere in a message: `#route:small`, `#route:auto`. */
export const pinIn = (raw: string): RouteTier | 'auto' | undefined => {
  const m = raw.match(/#route:(top|mid|small|auto)\b/i)

  return m?.[1] ? (m[1].toLowerCase() as RouteTier | 'auto') : undefined
}

// A write the small or mid model makes to these paths hands the turn back to the top model.
const PROTECTED_PATH = /(migrations?|supabase|schema|auth|payment|billing|stripe|webhook|privacy|consent|cookie|security|secrets?|\.env|middleware|rls|polic(y|ies))/i
const PROTECTED_COMMAND = /\b(supabase|psql|stripe|prisma migrate|drizzle-kit (push|migrate)|netlify deploy|vercel --prod|git push|terraform|kubectl|rm -rf)\b/i
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Why a tool call is top-model work, or undefined when it is not. */
export const protectedCall = (tool: string, input: Record<string, unknown>): string | undefined => {
  if (WRITE_TOOLS.has(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? '')

    return PROTECTED_PATH.test(path) ? `writes ${path}` : undefined
  }
  if (tool === 'Bash') {
    const command = String(input.command ?? '')

    return PROTECTED_COMMAND.test(command) ? `runs ${command.slice(0, 60)}` : undefined
  }

  return undefined
}

const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }

/** A model's size by family; an unknown id counts as the largest. */
export const rank = (model: string): number => {
  const family = Object.keys(RANK).find(name => model.toLowerCase().includes(name))

  return family ? (RANK[family] ?? 9) : 9
}

/**
 * The model a tier runs on: the session's own for top, else the tier's model,
 * never one larger than the session's (the router only ever downshifts).
 */
export const modelFor = (tier: RouteTier, sessionModel: string, models: { mid: string; small: string }): string => {
  if (tier === 'top') {
    return sessionModel
  }
  const target = tier === 'mid' ? models.mid : models.small

  return rank(target) < rank(sessionModel) ? target : sessionModel
}

/** Subagent types whose job is read-only searching. */
export const isSearchAgent = (type: string) => /^(explore|claude-code-guide|statusline-setup)$/i.test(type)
