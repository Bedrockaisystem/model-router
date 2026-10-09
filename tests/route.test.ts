import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify, humanText, modelFor, pinIn, protectedCall } from '../hooks/route'

const TOP = 'claude-opus-5-5'
const models = { mid: 'sonnet', small: 'haiku' }

describe('classify', () => {
  test('protected work stays on top', async () => {
    expect(classify('Add a Supabase migration for the jobs table').tier).toBe('top')
    expect(classify('Fix the Stripe webhook retry').tier).toBe('top')
    expect(classify('Review the privacy policy wording').tier).toBe('top')
    expect(classify('Design the architecture for multi-tenant routing').tier).toBe('top')
    expect(classify('Check the auth middleware for a security hole').tier).toBe('top')
  })

  test('light work goes small', async () => {
    expect(classify('Fix the typo in the hero headline').tier).toBe('small')
    expect(classify('Summarize this thread').tier).toBe('small')
    expect(classify('Where is the route optimizer defined?').tier).toBe('small')
    expect(classify('Run the tests').tier).toBe('small')
  })

  test('everyday building goes mid', async () => {
    expect(classify('Build a settings page with a dark mode toggle').tier).toBe('mid')
    expect(classify('Fix the bug where the calendar shows the wrong week').tier).toBe('mid')
  })

  test('unclear or long work stays on top', async () => {
    expect(classify('hmm').tier).toBe('top')
    expect(classify('Build it. ' + 'x'.repeat(5000)).tier).toBe('top')
  })

  test('harness boilerplate does not count', async () => {
    const wake =
      '<wake reason="mention"><system-note>security permissions privacy</system-note>' +
      '<message trigger="true" from="human">Summarize this thread</message></wake>'
    expect(humanText(wake)).toBe('Summarize this thread')
    expect(classify(wake).tier).toBe('small')
  })

  test('pins and helpers', async () => {
    expect(pinIn('please #route:small for this one')).toBe('small')
    expect(pinIn('#route:auto')).toBe('auto')
    expect(pinIn('no tag')).toBeUndefined()
    expect(modelFor('small', TOP, models)).toBe('haiku')
    expect(modelFor('top', TOP, models)).toBe(TOP)
    expect(modelFor('mid', 'claude-haiku-5-5', models)).toBe('claude-haiku-5-5')
    expect(protectedCall('Edit', { file_path: 'supabase/migrations/001.sql' })).toBeDefined()
    expect(protectedCall('Edit', { file_path: 'src/components/Hero.tsx' })).toBeUndefined()
    expect(protectedCall('Bash', { command: 'npx supabase db push' })).toBeDefined()
    expect(protectedCall('Read', { file_path: 'supabase/migrations/001.sql' })).toBeUndefined()
  })
})

const engine = (on: On, seen: string[], tokens = 20000) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1000000 }, rateLimits: [] } }))
  on('clock.now', () => ({ value: 0 }))
  on('session.model', () => ({ value: TOP }))
  on('turn.step', async function* (_$, e) {
    seen.push(e.model)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
}

const step = async ($: any, turnId: string, index = 0) => {
  const stream = $.turn.step({ turnId, index, model: TOP, messageCount: 3 })
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

describe('routing', () => {
  test('a lookup turn runs on the small model, a migration turn on top', async ($, on) => {
    const seen: string[] = []
    engine(on, seen)
    await $.turn.start({ text: 'Where is the invoice list component?', turnId: 't1' })
    await step($, 't1')
    await $.turn.start({ text: 'Where is the route list component?', turnId: 't2' })
    await step($, 't2')
    await $.turn.start({ text: 'Write the Supabase migration', turnId: 't3' })
    await step($, 't3')
    // "invoice" is a payments word, so t1 stays on top; t2 is a plain lookup.
    expect(seen).toEqual([TOP, 'haiku', TOP])
  })

  test('a large context keeps the main thread on its own model', async ($, on) => {
    const seen: string[] = []
    engine(on, seen, 400000)
    await $.turn.start({ text: 'Summarize this thread', turnId: 't1' })
    await step($, 't1')
    expect(seen).toEqual([TOP])
  })

  test('a protected write escalates the rest of the turn', async ($, on) => {
    const seen: string[] = []
    engine(on, seen)
    on('tool.call', () => ({ result: 'ok' }) as any)
    await $.turn.start({ text: 'Fix the typo in the footer', turnId: 't1' })
    await step($, 't1', 0)
    const denied = await $.tool.call({ tool: 'Edit', file_path: 'supabase/migrations/002.sql', old_string: 'a', new_string: 'b' } as any)
    expect(String((denied as any).deny ?? (denied as any).text)).toContain('reserved')
    await step($, 't1', 1)
    expect(seen).toEqual(['haiku', TOP])
  })

  test('/route pins and turns routing off', async ($, on) => {
    const seen: string[] = []
    engine(on, seen)
    await $.command.run({ command: 'route', args: 'top', origin: { kind: 'composer' }, presentation: {} } as any)
    await $.turn.start({ text: 'Summarize this thread', turnId: 't1' })
    await step($, 't1')
    await $.command.run({ command: 'route', args: 'auto', origin: { kind: 'composer' }, presentation: {} } as any)
    await $.turn.start({ text: 'Summarize this thread', turnId: 't2' })
    await step($, 't2')
    await $.command.run({ command: 'route', args: 'off', origin: { kind: 'composer' }, presentation: {} } as any)
    await $.turn.start({ text: 'Summarize this thread', turnId: 't3' })
    await step($, 't3')
    expect(seen).toEqual([TOP, 'haiku', TOP])
  })

  test('an Explore subagent is sent to the small model; an explicit model is kept', async ($, on) => {
    const models: (string | undefined)[] = []
    on('clock.now', () => ({ value: 0 }))
    on('agent.spawn', (_$, e) => (models.push(e.model), { model: e.model ?? e.parentModel, agentId: `a${models.length}` }))
    const base = { tool_use_id: 'x', description: 'find files', prompt: 'List the components under src/', provider: { plugin: 'engine', tier: 'core' }, parentModel: TOP, background: false, fork: false } as any
    await $.agent.spawn({ ...base, subagentType: 'Explore' })
    await $.agent.spawn({ ...base, subagentType: 'Explore', model: 'opus' })
    await $.agent.spawn({ ...base, subagentType: 'Plan' })
    expect(models).toEqual(['haiku', 'opus', undefined])
  })
})
