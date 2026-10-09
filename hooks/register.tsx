import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RouteDecision, RouteMode, RouteTier } from '../types'
import { classify, humanText, isSearchAgent, modelFor, pinIn, protectedCall, rank } from './route'
import type { Verdict } from './route'

const NAME = 'model-router'
const pin = atom({ plugin: 'model-router', key: 'pin' } as const, null)
const modeSet = atom({ plugin: 'model-router', key: 'mode' } as const, null)
const lastTier = atom({ plugin: 'model-router', key: 'lastTier' } as const, 'top')
const log = atom({ plugin: 'model-router', key: 'log' } as const, [])

const TIERS: readonly RouteTier[] = ['top', 'mid', 'small']
const SUBAGENT_LONG_CHARS = 12000

type Config = { models: { mid: string; small: string }; contextLimit: number; fallbackMode: RouteMode }

async function modeOf($: EngineInterface, fallback: RouteMode): Promise<RouteMode> {
  return (await read($, modeSet)) ?? fallback
}

async function record($: EngineInterface, d: Omit<RouteDecision, 'at'>) {
  // The log is for /route status only: a failure here never stops routing.
  try {
    const at = await $.clock.now()
    await update($, log, list => [...list, { ...d, at }].slice(-50))
  } catch {
    // ignore
  }
}

async function statusText($: EngineInterface, config: Config) {
  const mode = await modeOf($, config.fallbackMode)
  const pinned = await read($, pin)
  const recent = (await read($, log)).slice(-10).reverse()
  const lines = recent.map(
    d => `- ${d.where}: ${d.tier} → ${d.model}${d.applied ? '' : ' (not applied)'} · ${d.reason}`,
  )

  return [
    `RouteMode: ${mode}. Pin: ${pinned ?? 'none'}. Mid: ${config.models.mid}. Small: ${config.models.small}. Context limit: ${config.contextLimit}.`,
    lines.length ? 'Recent decisions:' : 'No decisions yet.',
    ...lines,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const models = {
    mid: String(options.midModel ?? 'sonnet'),
    small: String(options.smallModel ?? 'haiku'),
  }
  const contextLimit = Number(options.contextLimit ?? 150000)
  const isModelClassifier = options.classifier === 'rules+model'

  // Per-turn plans, keyed by turnId; a reload loses them and falls back to lastTier.
  const plans = new Map<string, Verdict>()
  // Turns and subagents a protected call handed back to the top model.
  const escalated = new Set<string>()
  // Subagents this mod downshifted, by agentId.
  const routedAgents = new Map<string, RouteTier>()
  let mainTurn: { turnId: string; tier: RouteTier } | null = null

  const fallbackMode = (options.mode as RouteMode | undefined) ?? 'auto'
  const config = { models, contextLimit, fallbackMode }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Model routing for this thread: auto, top, mid, small, suggest, off or status',
    })

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if ((TIERS as readonly string[]).includes(arg)) {
      await update($, pin, () => arg as RouteTier)
      await update($, modeSet, mode => (mode === 'off' ? 'auto' : mode))
    } else if (arg === 'auto') {
      await update($, pin, () => null)
      await update($, modeSet, () => 'auto')
    } else if (arg === 'suggest' || arg === 'off') {
      await update($, modeSet, () => arg as RouteMode)
    } else if (arg !== '' && arg !== 'status') {
      return { text: 'Usage: /route [auto | top | mid | small | suggest | off | status]' }
    }

    return { text: await statusText($, config) }
  })

  on('prompt.submit', async ($, e, next) => {
    const wanted = pinIn(e.text)
    if (wanted) {
      await update($, pin, () => (wanted === 'auto' ? null : wanted))
      $.ui.toast(wanted === 'auto' ? 'Model routing back to auto' : `Model pinned to ${wanted} for this thread`)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const pinned = await read($, pin)
    let verdict: Verdict = pinned
      ? { tier: pinned, reason: 'pinned', isSure: true }
      : e.text.trim() === ''
        ? { tier: await read($, lastTier), reason: 'continuation', isSure: true }
        : classify(e.text)

    if (!verdict.isSure && isModelClassifier) {
      const label = await $.model
        .classify(humanText(e.text).slice(0, 4000), TIERS, { model: models.small })
        .catch(() => undefined)
      if (label && (TIERS as readonly string[]).includes(label)) {
        verdict = { tier: label as RouteTier, reason: 'model classifier', isSure: true }
      }
    }
    plans.set(e.turnId, verdict)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const mode = await modeOf($, fallbackMode)
    if (mode === 'off') {
      return yield* next(e)
    }

    if (e.agentId) {
      // A routed subagent that touched protected work runs on the parent's model from here on.
      if (escalated.has(e.agentId) && mode === 'auto') {
        const top = await $.session.model()
        if (top !== e.model) {
          return yield* next({ ...e, model: top })
        }
      }

      return yield* next(e)
    }

    const plan = plans.get(e.turnId) ?? { tier: await read($, lastTier), reason: 'continuation', isSure: true }
    let tier = plan.tier
    let reason = plan.reason
    if (escalated.has(e.turnId)) {
      tier = 'top'
      reason = 'escalated: protected work'
    }
    if (tier !== 'top') {
      const tokens = await $.session
        .usage()
        .then(usage => usage.context.tokens ?? 0)
        .catch(() => Infinity)
      if (tokens > contextLimit) {
        tier = 'top'
        reason = 'context too large to downshift'
      }
    }
    const model = modelFor(tier, e.model, models)
    const isApplied = mode === 'auto' && model !== e.model

    mainTurn = { turnId: e.turnId, tier: isApplied ? tier : 'top' }
    if (e.index === 0) {
      await update($, lastTier, () => plan.tier)
      await record($, { where: 'main', tier, model, reason, applied: isApplied })
      $.ui.status(
        mode === 'suggest' && model !== e.model
          ? `route: would use ${model} (${reason})`
          : `route: ${isApplied ? model : e.model} (${reason})`,
      )
    }
    if (!isApplied) {
      return yield* next(e)
    }

    // Hand the step to the smaller model; if that request fails before any output, rerun it unchanged.
    const stream = next({ ...e, model, effort: rank(model) <= 1 ? undefined : e.effort })
    let hasOutput = false
    try {
      while (true) {
        const step = await stream.next()
        if (step.done) {
          return step.value
        }
        hasOutput = true
        yield step.value
      }
    } catch (err) {
      if (hasOutput) {
        throw err
      }
      $.ui.toast(`${model} failed; rerunning this step on ${e.model}`)
      escalated.add(e.turnId)

      return yield* next(e)
    }
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId
    const isRouted = loop ? routedAgents.has(loop) : mainTurn !== null && mainTurn.tier !== 'top'
    const key = loop ?? mainTurn?.turnId
    if (!isRouted || !key || escalated.has(key) || (await modeOf($, fallbackMode)) !== 'auto') {
      return next(e)
    }
    const why = protectedCall(String(e.tool), e as unknown as Record<string, unknown>)
    if (!why) {
      return next(e)
    }
    escalated.add(key)
    await record($, { where: loop ? 'subagent' : 'main', tier: 'top', model: 'session', reason: `escalated: ${why}`, applied: true })
    $.ui.toast(`Protected work (${why}): handing back to the top model`)
    $.ui.status(`route: top (escalated)`)

    return {
      deny: `${NAME}: this call ${why}, which is reserved for the session's top model. The next step runs on that model; make this call again from there.`,
    }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const mode = await modeOf($, fallbackMode)
    if (mode === 'off' || e.fork || e.isTeammate || e.workflow || e.model) {
      return next(e)
    }
    const pinned = await read($, pin)
    const text = `${e.description}\n${e.prompt}`
    const base = classify(text, SUBAGENT_LONG_CHARS)
    let verdict: Verdict = pinned
      ? { tier: pinned, reason: 'pinned', isSure: true }
      : /^plan$/i.test(e.subagentType)
        ? { tier: 'top', reason: 'planning agent', isSure: true }
        : isSearchAgent(e.subagentType) && base.tier !== 'top'
          ? { tier: 'small', reason: `${e.subagentType} search`, isSure: true }
          : base
    const model = modelFor(verdict.tier, e.parentModel, models)
    const isApplied = mode === 'auto' && model !== e.parentModel
    await record($, { where: 'subagent', tier: verdict.tier, model, reason: verdict.reason, applied: isApplied })
    if (!isApplied) {
      return next(e)
    }
    const started = await next({ ...e, model })
    if (started.agentId) {
      routedAgents.set(started.agentId, verdict.tier)
    }

    return started
  })
}
