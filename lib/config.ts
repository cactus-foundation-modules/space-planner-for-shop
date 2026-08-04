import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'

// Module settings: one JSONB blob on the spl_settings singleton, parsed with
// defaults on every read. A setting added in a later version needs no migration,
// and a half-written blob falls back to defaults rather than taking the planner
// down with it.
//
// The defaults are chosen so that installing this module changes nothing a
// shopper can see until the owner puts the planner somewhere. The cart and
// product-page buttons are the exception - they are the whole point, so they are
// on, and they are individually switchable for an owner who would rather place
// the block themselves.

export const SplConfigSchema = z.object({
  // ---- Where the planner shows up -------------------------------------------
  showOnCart: z.boolean().default(true),
  cartButtonLabel: z.string().default('View in Space Planner'),
  showOnProduct: z.boolean().default(true),
  productButtonLabel: z.string().default('See it in your room'),
  plannerHeading: z.string().default('Plan your space'),
  plannerIntro: z.string().default('Draw your room, drop furniture in it, and see what fits before you buy a thing.'),

  // ---- Quotas ---------------------------------------------------------------
  // Enforced server-side with a plain-English message rather than a 400. A bored
  // visitor with a script must not be able to fill the table, and a genuine
  // customer must never meet a number they cannot understand.
  maxRoomsPerMember: z.number().int().min(1).max(500).default(25),
  maxPlansPerRoom: z.number().int().min(1).max(200).default(25),
  maxItemsPerPlan: z.number().int().min(10).max(400).default(200),
  maxVersionsPerPlan: z.number().int().min(1).max(100).default(20),

  // ---- Runtime budgets ------------------------------------------------------
  // Per UNIQUE MODEL, never per placed item: twenty identical desks share one
  // geometry, and a cap counting instances would refuse exactly the office
  // fit-out this tool exists for.
  maxUniqueModels: z.number().int().min(2).max(64).default(14),
  maxModelBytes: z.number().int().min(1_000_000).max(80_000_000).default(12_000_000),
  decimationEnabled: z.boolean().default(true),
  /** Fraction of triangles kept. Conservative - the camera rarely gets under a metre. */
  decimationTarget: z.number().min(0.1).max(1).default(0.45),
  textureMaxPx: z.number().int().min(256).max(4096).default(1024),

  // ---- Guidance -------------------------------------------------------------
  // Rules of thumb for arranging furniture. Not a workplace assessment, not
  // fire-safety or means-of-escape guidance, and not a building-regulations
  // check - the wording that says so travels with every warning and every
  // printed output, and the owner can adjust these or switch them off.
  clearanceWarningsEnabled: z.boolean().default(true),
  walkwayClearanceMm: z.number().int().min(0).max(5000).default(1000),
  deskChairClearanceMm: z.number().int().min(0).max(5000).default(900),
  guidanceDisclaimer: z.string().default(
    'These spacings are rules of thumb to help you arrange furniture. They are not a workplace assessment, fire-safety advice or a building-regulations check.',
  ),
  bomDisclaimer: z.string().default(
    'Guidance only - please check the measurements on site. Prices were correct when this plan was saved and exclude any discounts, which are applied at checkout.',
  ),

  // ---- Outputs --------------------------------------------------------------
  quoteEnabled: z.boolean().default(true),
  emailPlanEnabled: z.boolean().default(true),
  rendersEnabled: z.boolean().default(false),
  deliveryColumnEnabled: z.boolean().default(true),
  /**
   * Whole-room GLB download. Off by default, and deliberately the owner's call.
   *
   * Signed asset urls exist so a scraped model link stops working and a
   * third-party site cannot embed the models at all. A one-click download that
   * bundles a dozen supplier models into one unsigned file is precisely the
   * scraper, supplied by us, with a button on it. The floor plan, the item list
   * and the render serve a customer who wants their layout elsewhere, and none
   * of them hands over the geometry.
   */
  glbExportEnabled: z.boolean().default(false),

  // ---- Housekeeping ---------------------------------------------------------
  /** Rooms untouched for this long are flagged to the owner, never destroyed. */
  roomIdleFlagMonths: z.number().int().min(0).max(120).default(24),
  /** How long the anonymous event counters are kept. Zero keeps them for ever. */
  eventRetentionDays: z.number().int().min(0).max(3650).default(180),
  /** How many stale dimension rows the nightly sweep re-resolves. Bounded on purpose. */
  nightlyDimensionSweep: z.number().int().min(0).max(5000).default(500),

  // ---- Abuse ----------------------------------------------------------------
  rateLimitWindowMin: z.number().int().min(1).max(1440).default(60),
  maxRendersPerWindow: z.number().int().min(1).max(200).default(10),
  maxQuotesPerWindow: z.number().int().min(1).max(200).default(5),
  maxPlanEmailsPerWindow: z.number().int().min(1).max(200).default(10),
})

export type SplConfig = z.infer<typeof SplConfigSchema>
export const SPL_CONFIG_DEFAULTS: SplConfig = SplConfigSchema.parse({})

export async function getSplConfig(): Promise<SplConfig> {
  const rows = await prisma.$queryRaw<{ config: unknown }[]>`
    SELECT "config" FROM "spl_settings" WHERE "id" = 'singleton'
  `
  const parsed = SplConfigSchema.safeParse(rows[0]?.config ?? {})
  return parsed.success ? parsed.data : SPL_CONFIG_DEFAULTS
}

const CACHE_TTL_MS = 10_000
let cached: SplConfig | null = null
let cachedAt = 0

/** Cached read for the hot paths - every planner page load asks for this. */
export async function getSplConfigCached(): Promise<SplConfig> {
  const now = Date.now()
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached
  const config = await getSplConfig()
  cached = config
  cachedAt = now
  return config
}

export function invalidateSplConfigCache(): void {
  cached = null
  cachedAt = 0
}

// Merge-then-validate, upserted rather than updated so a missing singleton row
// heals itself on first save instead of the write quietly affecting zero rows.
export async function updateSplConfig(patch: Partial<SplConfig>): Promise<SplConfig> {
  const current = await getSplConfig()
  const next = SplConfigSchema.parse({ ...current, ...patch })
  const serialised = JSON.stringify(next)
  await prisma.$executeRaw`
    INSERT INTO "spl_settings" ("id", "config", "updated_at")
    VALUES ('singleton', ${serialised}::jsonb, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE
      SET "config" = ${serialised}::jsonb, "updated_at" = CURRENT_TIMESTAMP
  `
  invalidateSplConfigCache()
  return next
}

/** Whether the render worker is actually reachable, as opposed to merely enabled. */
export function renderWorkerConfigured(): boolean {
  return Boolean(process.env.SPACE_PLANNER_RENDER_URL && process.env.SPACE_PLANNER_RENDER_SECRET)
}
