import type { BotLevel, BuildingKind, Tool, Weapon } from './types'

export const RULES_VERSION = 'forpost-0.1' as const
export const MAP_VERSION = 'forpost-maps-0.1' as const
export const BOT_VERSION = 'forpost-bot-0.1' as const
export const TICK_RATE = 30
export const ticks = (seconds: number): number => Math.ceil(seconds * TICK_RATE)
export const RULES = Object.freeze({
  preparationTicks: ticks(20), battleTicks: ticks(300), overtimeTicks: ticks(60), resultTicks: ticks(15), matchLimitTicks: ticks(1200),
  initialCredits: 220, maxCredits: 600, baseIncome: 1, extractorIncome: 0.75, stationIncome: 0.25,
  initialCharge: 40, maxCharge: 120, chargeIncome: 1, stationChargeIncome: 0.5, transportCost: 40,
  firstTransportTicks: ticks(5), transportIntervalTicks: ticks(12), transportHp: 650, transportSpeed: 0.7, escortedSpeed: 1.5,
  escortRadius: 4, unloadRadius: 3, unloadTicks: ticks(3), stationRadius: 2.5, captureTicks: ticks(4),
  baseNetworkRadius: 14, relayNetworkRadius: 12, basePower: 6, maxBuildings: 5, maxBuildOrders: 4, maxDrones: 2,
  droneCost: 60, droneWorkTicks: ticks(8), sellTicks: ticks(2), sellDamageQuietTicks: ticks(5),
  inputExpiryTicks: ticks(0.25), fighterHp: 100, fighterSpeed: 4.5, fighterRadius: 0.32, fighterVision: 18,
  builderHp: 80, builderSpeed: 4, builderRadius: 0.28, builderVision: 8, builderRespawnTicks: ticks(8),
  droneHp: 60, droneSpeed: 3.2, droneRadius: 0.30, droneVision: 14,
  fighterRegenDelayTicks: ticks(4), fighterRegenPerSecond: 15, spawnProtectionTicks: ticks(1), wallHp: 300,
  barrierHp: 180, barrierLength: 4, barrierDistance: 1.2, barrierTicks: ticks(4), barrierCooldownTicks: ticks(18),
  smokeRadius: 3.5, smokeRange: 6, smokeTicks: ticks(6), smokeCooldownTicks: ticks(18),
  repairRange: 3, repairPerSecond: 40, repairTicks: ticks(3), repairCooldownTicks: ticks(15),
  powerOrder: ['post', 'turret', 'dock', 'battery', 'extractor'] as BuildingKind[],
})
export const WEAPONS: Record<Weapon, { damage: number; interval: number; magazine: number; reloadTicks: number; range: number; pellets: number[] }> = {
  carbine: { damage: 10, interval: 0.125, magazine: 24, reloadTicks: ticks(1.8), range: 26, pellets: [0] },
  shotgun: { damage: 8, interval: 1, magazine: 5, reloadTicks: ticks(2.2), range: 11, pellets: [-6, -3.6, -1.2, 1.2, 3.6, 6] },
  rifle: { damage: 32, interval: 0.4, magazine: 8, reloadTicks: ticks(2), range: 34, pellets: [0] },
}
export const BUILDINGS: Record<BuildingKind, { cost: number; hp: number; workTicks: number; power: number; limit: number }> = {
  relay: { cost: 60, hp: 160, workTicks: ticks(3), power: 1, limit: 3 },
  generator: { cost: 90, hp: 220, workTicks: ticks(4), power: 0, limit: 1 },
  extractor: { cost: 120, hp: 220, workTicks: ticks(5), power: 1, limit: 2 },
  turret: { cost: 130, hp: 250, workTicks: ticks(5), power: 2, limit: 2 },
  dock: { cost: 120, hp: 260, workTicks: ticks(6), power: 2, limit: 1 },
  battery: { cost: 180, hp: 240, workTicks: ticks(7), power: 3, limit: 1 },
  post: { cost: 150, hp: 220, workTicks: ticks(6), power: 2, limit: 1 },
  bridge: { cost: 80, hp: 220, workTicks: ticks(4), power: 0, limit: 1 },
}
export const TOOLS: Record<Tool, { cooldownTicks: number; durationTicks: number }> = {
  barrier: { cooldownTicks: RULES.barrierCooldownTicks, durationTicks: RULES.barrierTicks },
  smoke: { cooldownTicks: RULES.smokeCooldownTicks, durationTicks: RULES.smokeTicks },
  repair: { cooldownTicks: RULES.repairCooldownTicks, durationTicks: RULES.repairTicks },
}
export const BOT_PROFILES: Record<BotLevel, { planPeriod: number; reactionTicks: number; errorDegrees: number }> = {
  novice: { planPeriod: 30, reactionTicks: 14, errorDegrees: 4 },
  normal: { planPeriod: 15, reactionTicks: 8, errorDegrees: 2 },
  strong: { planPeriod: 7.5, reactionTicks: 5, errorDegrees: 0.8 },
}
export const VISION = { fighter: 18, builder: 8, drone: 14, transport: 12, building: 6, inactiveBuilding: 2, base: 14 } as const
