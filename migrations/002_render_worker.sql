-- Space Planner for Shop - the picture service, provisioned rather than plumbed.
--
-- Setting up photoreal pictures used to mean two environment variables and a
-- machine somebody built by hand. This adds the alternative: the owner presses a
-- button, the site makes its own Fly.io app, and every picture gets a machine of
-- its own that destroys itself when it is done. The environment variables still
-- work and still win, for anyone who would rather point at a worker they run
-- themselves.
--
-- Idempotent throughout, like 001 - the module migration runner will see this
-- file again on later deploys, and a fresh install runs both in order.
--
-- Column types stay inside the backup serialiser's supported set: TEXT, BOOLEAN,
-- TIMESTAMP. No arrays, no enums. See 001 for why that matters here.

-- ---------------------------------------------------------------------------
-- Where the picture service lives
-- ---------------------------------------------------------------------------
--
-- A singleton, like spl_settings, and separate from it ON PURPOSE: the Fly token
-- is a credential, and spl_settings is handed to the owner-facing settings API
-- whole. Keeping the secret in its own table means the settings route cannot
-- leak it by growing a field, which is exactly how these things escape.

CREATE TABLE IF NOT EXISTS "spl_render_worker" (
    "id" TEXT NOT NULL DEFAULT 'singleton',

    -- Fly.io API token. NULL means "borrow the one the video converter uses"
    -- (Media > Video, or MEDIA_WORKER_FLY_TOKEN / SEQUENCE_FLY_TOKEN), which is
    -- the ordinary case: most sites have one key for one Fly account.
    "fly_token" TEXT,
    -- The app this site made for itself. NULL = never provisioned.
    "app_name" TEXT,
    "region" TEXT NOT NULL DEFAULT 'lhr',
    -- Bearer the worker checks on an inbound job, so a stranger who finds the
    -- app's hostname cannot spend the owner's money rendering their own scenes.
    "worker_token" TEXT NOT NULL DEFAULT '',
    -- Pinned worker image. Stored rather than hardcoded so a site can be moved
    -- forward (or held back) without waiting for a module release.
    "image" TEXT NOT NULL DEFAULT '',
    -- Set when this site created the app itself, and therefore may delete it.
    -- An app the owner pointed us at by hand is never torn down from here.
    "self_provisioned" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_render_worker_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spl_render_worker_singleton_check" CHECK ("id" = 'singleton')
);

-- ---------------------------------------------------------------------------
-- Which machine is rendering which picture
-- ---------------------------------------------------------------------------
--
-- One machine per job is the whole design: ten customers asking at once get ten
-- machines rather than a queue, and each one is destroyed the moment its picture
-- lands. That only works if the row knows which machine belongs to it - without
-- this column a lost callback leaves a machine nobody can name, running on
-- somebody's bill until they notice.

ALTER TABLE "spl_render_jobs" ADD COLUMN IF NOT EXISTS "machine_id" TEXT NOT NULL DEFAULT '';

-- The sweep's question is "which live jobs have a machine to clean up", asked
-- once a night against a table that is mostly finished rows.
CREATE INDEX IF NOT EXISTS "spl_render_jobs_machine_idx"
    ON "spl_render_jobs" ("machine_id")
    WHERE "machine_id" <> '';
