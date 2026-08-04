import { prisma } from '@/lib/db/prisma'

// The picture service's own settings row - see migrations/002_render_worker.sql
// for why the Fly token lives here rather than in the settings blob.
//
// Everything in here is machinery, not preference: an owner never types any of
// it. It is written once when they press the button and read on every render.

export type SplRenderWorker = {
  flyToken: string | null
  appName: string | null
  region: string
  workerToken: string
  image: string
  selfProvisioned: boolean
}

type Row = {
  fly_token: string | null
  app_name: string | null
  region: string
  worker_token: string
  image: string
  self_provisioned: boolean
}

const EMPTY: SplRenderWorker = {
  flyToken: null,
  appName: null,
  region: 'lhr',
  workerToken: '',
  image: '',
  selfProvisioned: true,
}

export async function getRenderWorker(): Promise<SplRenderWorker> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "fly_token", "app_name", "region", "worker_token", "image", "self_provisioned"
    FROM "spl_render_worker" WHERE "id" = 'singleton' LIMIT 1
  `
  const row = rows[0]
  if (!row) return EMPTY
  return {
    flyToken: row.fly_token,
    appName: row.app_name,
    region: row.region,
    workerToken: row.worker_token,
    image: row.image,
    selfProvisioned: row.self_provisioned,
  }
}

/** Upserted rather than updated, so a site that has never provisioned heals
 * itself on first save instead of the write quietly affecting zero rows. */
export async function saveRenderWorker(next: SplRenderWorker): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "spl_render_worker" ("id", "fly_token", "app_name", "region", "worker_token", "image", "self_provisioned", "updated_at")
    VALUES ('singleton', ${next.flyToken}, ${next.appName}, ${next.region}, ${next.workerToken}, ${next.image}, ${next.selfProvisioned}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE
      SET "fly_token" = ${next.flyToken},
          "app_name" = ${next.appName},
          "region" = ${next.region},
          "worker_token" = ${next.workerToken},
          "image" = ${next.image},
          "self_provisioned" = ${next.selfProvisioned},
          "updated_at" = CURRENT_TIMESTAMP
  `
}

/** Forget the app but keep the token, for a teardown that is going to be
 * followed by another go. */
export async function clearRenderWorkerApp(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "spl_render_worker"
    SET "app_name" = NULL, "worker_token" = '', "image" = '', "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
}
