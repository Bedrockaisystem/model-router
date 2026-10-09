export type RouteTier = 'top' | 'mid' | 'small'

export type RouteMode = 'auto' | 'suggest' | 'off'

export type RouteDecision = {
  at: number
  where: 'main' | 'subagent'
  tier: RouteTier
  model: string
  reason: string
  applied: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      pin: RouteTier | null
      mode: RouteMode | null
      lastTier: RouteTier
      log: RouteDecision[]
    }
  }
}
