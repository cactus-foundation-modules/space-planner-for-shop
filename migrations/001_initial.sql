-- Space Planner for Shop - initial schema (prefix spl_).
--
-- All DDL is idempotent, so it is safe for the module migration runner to see
-- this file again on any later deploy.
--
-- Column types stay inside the backup serialiser's supported set
-- (lib/backup/serialize.ts): TEXT, INTEGER, NUMERIC, BOOLEAN, JSONB, TIMESTAMP.
-- No enums, no arrays: every state column is plain TEXT with a CHECK, and every
-- list-shaped column is JSONB. That is not fussiness - a saved plan is a
-- customer document with no copy anywhere else, so it has to survive a backup
-- and a restore without anybody thinking about it.
--
-- Shape: Member -> rooms (many) -> plans (many per room). A shopper measures a
-- space once and then tries several layouts in it. Rooms and plans are the only
-- two things a person names; everything else here is machinery.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Singleton settings row: one JSONB blob parsed through a zod schema with
-- defaults on read (lib/config.ts), so a setting added in a later version needs
-- no migration and a half-written blob falls back to defaults rather than
-- taking the planner down.
CREATE TABLE IF NOT EXISTS "spl_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "spl_settings" ("id", "config") VALUES ('singleton', '{}'::jsonb)
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Rooms and plans
-- ---------------------------------------------------------------------------

-- The measured space. Geometry only - no furniture.
--
-- `member_id` is a core Member.id and carries no foreign key, matching the
-- precedent every other module sets against core tables: a module must never be
-- the reason core cannot delete a row. The consequence is that account deletion
-- does not cascade here, so it is handled actively - see lib/db/rooms.ts and the
-- nightly sweep in app/api/cron/sweep.
--
-- `owner_user_id` is a core User.id and is null for everything this module
-- writes today. It costs one nullable column and keeps the door open for the
-- loop that turns this from a toy into a sales instrument: buyer sketches,
-- supplier refines, buyer approves. A schema where every room must belong to a
-- Member forecloses it, because staff are User rows and not Members. Exactly one
-- of the two owner columns is ever set.
CREATE TABLE IF NOT EXISTS "spl_rooms" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "member_id" TEXT,
    "owner_user_id" TEXT,
    "name" TEXT NOT NULL DEFAULT 'My room',
    "notes" TEXT NOT NULL DEFAULT '',
    -- Vertices, wall openings, interior obstructions, ceiling height, units.
    -- Millimetre integers throughout so a saved room never drifts on a float.
    "geometry" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "thumbnail_media_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_rooms_pkey" PRIMARY KEY ("id"),
    -- Exactly one owner. A room owned by nobody is unreachable; a room owned by
    -- both is ambiguous about who may read it, which is the defect class that
    -- turns a planner into a data leak.
    CONSTRAINT "spl_rooms_owner_check" CHECK (
        ("member_id" IS NOT NULL AND "owner_user_id" IS NULL)
        OR ("member_id" IS NULL AND "owner_user_id" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "spl_rooms_member_id_idx" ON "spl_rooms" ("member_id");
CREATE INDEX IF NOT EXISTS "spl_rooms_updated_at_idx" ON "spl_rooms" ("updated_at" DESC);

-- One furniture layout within one room.
--
-- `member_id` is denormalised off the room so "all my plans" and every ownership
-- check need no join; the room stays the authority and the two are always
-- written together.
--
-- `product_snapshot` is what makes a plan readable in two years: name, price and
-- image per referenced product as they were at save time. Products get renamed,
-- repriced and deleted, and a plan that renders as a grid of blank boxes because
-- a supplier range was retired is a plan the customer cannot use.
--
-- `share_token` is NULL until the plan is actually shared, so there is no token
-- to leak for a plan nobody shared.
CREATE TABLE IF NOT EXISTS "spl_plans" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "room_id" TEXT NOT NULL,
    "member_id" TEXT,
    "owner_user_id" TEXT,
    "name" TEXT NOT NULL DEFAULT 'Option A',
    "position" INTEGER NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "product_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "share_token" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "thumbnail_media_id" TEXT,
    -- Set when the member turns this plan into a quote-for-shop request, so the
    -- plan can say "you asked about this on the 4th" instead of forgetting.
    -- No foreign key: quotes belong to another module and outlive plans.
    "quote_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_plans_pkey" PRIMARY KEY ("id"),
    -- The one foreign key in this schema, because both ends are ours. Deleting a
    -- room takes its plans with it; the confirmation dialog says how many that
    -- is, by name, before it happens.
    CONSTRAINT "spl_plans_room_id_fkey" FOREIGN KEY ("room_id")
        REFERENCES "spl_rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "spl_plans_share_token_key" UNIQUE ("share_token")
);

CREATE INDEX IF NOT EXISTS "spl_plans_room_id_idx" ON "spl_plans" ("room_id");
CREATE INDEX IF NOT EXISTS "spl_plans_member_id_idx" ON "spl_plans" ("member_id");
CREATE INDEX IF NOT EXISTS "spl_plans_updated_at_idx" ON "spl_plans" ("updated_at" DESC);

-- Past versions of a plan, so overwriting one by dragging before noticing is
-- recoverable. Written on each explicit save and before every operation that is
-- destructive by nature (room geometry edit, plan overwrite, bulk variant
-- replace), capped per plan, restorable from the plan menu.
--
-- Core treats user documents this way already (Layout.history), and the
-- semantics are copied exactly - restoring a version is itself a save, so it
-- archives what it replaced. The storage diverges deliberately: a side table
-- rather than a jsonb column on the plan, because a plan's items blob is far
-- larger than a page's and core has to hand-exclude `history` from every list
-- query to stop it costing. A side table is never selected by accident.
CREATE TABLE IF NOT EXISTS "spl_plan_versions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "plan_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "items" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "product_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- A member-supplied label ("before the boss saw it") pins a version so the
    -- cap never sweeps it.
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_plan_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spl_plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id")
        REFERENCES "spl_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "spl_plan_versions_plan_version_key" UNIQUE ("plan_id", "version")
);

CREATE INDEX IF NOT EXISTS "spl_plan_versions_plan_id_idx" ON "spl_plan_versions" ("plan_id", "version" DESC);

-- ---------------------------------------------------------------------------
-- Catalogue fix-up layer
-- ---------------------------------------------------------------------------

-- The human-curated correction layer for wonky assets and odd products, so a
-- badly-oriented model gets fixed here rather than re-exported.
--
-- Split-keyed with stated precedence. A FILE-level row (keyed by p3d_models.id)
-- carries what belongs to the file: which way it faces, what its footprint
-- really is, whether it survives decimation. A PRODUCT-level row (keyed by the
-- shp_products.id) carries semantics: how the thing mounts, and notes. Where
-- both speak to the same variant, the product-level row wins - it is the more
-- specific statement.
CREATE TABLE IF NOT EXISTS "spl_model_meta" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    -- Exactly one of these two is set; `scope` says which, so a query never has
    -- to infer it from a null.
    "scope" TEXT NOT NULL DEFAULT 'file',
    "model_id" TEXT,
    "product_id" TEXT,
    -- Degrees, applied on load, after the model has been recentred and grounded.
    "yaw_offset_degrees" INTEGER NOT NULL DEFAULT 0,
    -- { widthMm, depthMm } when the measured bounding box is not the footprint
    -- you want (a chair's castors, a desk's cable tray).
    "footprint_override" JSONB,
    "no_decimation" BOOLEAN NOT NULL DEFAULT false,
    "mount_type" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    -- Stamped when a human has actually looked at this one, which is what the
    -- worst-offenders view in the admin sorts on.
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_model_meta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spl_model_meta_scope_check" CHECK (
        ("scope" = 'file' AND "model_id" IS NOT NULL AND "product_id" IS NULL)
        OR ("scope" = 'product' AND "product_id" IS NOT NULL AND "model_id" IS NULL)
    ),
    CONSTRAINT "spl_model_meta_mount_check" CHECK (
        "mount_type" IS NULL OR "mount_type" IN ('floor', 'desk-surface', 'desk-edge-clamp', 'wall')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "spl_model_meta_model_id_key" ON "spl_model_meta" ("model_id") WHERE "model_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "spl_model_meta_product_id_key" ON "spl_model_meta" ("product_id") WHERE "product_id" IS NOT NULL;

-- Per-category fallback sizes, in millimetres. Depth and height are missing from
-- roughly seven products in ten, so without this the ladder would fall straight
-- past a perfectly good width to a generic marker. An item sized from here is
-- badged "approx. size" in the planner - never a silent guess.
CREATE TABLE IF NOT EXISTS "spl_category_defaults" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "category_id" TEXT NOT NULL,
    "width_mm" INTEGER,
    "depth_mm" INTEGER,
    "height_mm" INTEGER,
    "mount_type" TEXT NOT NULL DEFAULT 'floor',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_category_defaults_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spl_category_defaults_category_id_key" UNIQUE ("category_id"),
    CONSTRAINT "spl_category_defaults_mount_check" CHECK (
        "mount_type" IN ('floor', 'desk-surface', 'desk-edge-clamp', 'wall')
    )
);

-- Materialised output of the resolution ladder, so the planner never parses
-- attribute text at request time.
--
-- `product_updated_at` is the product's own stamp at the moment we resolved it.
-- Catalogue edits arrive by Google Sheet pull, which fires no product-save event,
-- so freshness is checked by comparing stamps rather than by trusting an event
-- that never comes.
--
-- `source` says which rung answered, which is what lets the planner badge an
-- approximate size honestly and what the dimension report sorts on.
CREATE TABLE IF NOT EXISTS "spl_dimension_cache" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "product_id" TEXT NOT NULL,
    "width_mm" INTEGER,
    "depth_mm" INTEGER,
    "height_mm" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'category_default',
    -- The raw attribute text a parsed figure came out of, kept so the junk tail
    -- in the admin can show the owner what it choked on rather than a count.
    "parsed_from" TEXT NOT NULL DEFAULT '',
    -- Set when a model bounding box and the spec attributes disagree by more
    -- than the tolerance. One of the two is wrong, and that is exactly the class
    -- of defect that otherwise ships silently.
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "conflict_note" TEXT NOT NULL DEFAULT '',
    "mount_type" TEXT NOT NULL DEFAULT 'floor',
    "product_updated_at" TIMESTAMP(3),
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_dimension_cache_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spl_dimension_cache_product_id_key" UNIQUE ("product_id"),
    CONSTRAINT "spl_dimension_cache_source_check" CHECK (
        "source" IN ('glb', 'attribute', 'category_default', 'manual', 'marker')
    )
);

CREATE INDEX IF NOT EXISTS "spl_dimension_cache_stale_idx" ON "spl_dimension_cache" ("stale");
CREATE INDEX IF NOT EXISTS "spl_dimension_cache_source_idx" ON "spl_dimension_cache" ("source");
CREATE INDEX IF NOT EXISTS "spl_dimension_cache_conflict_idx" ON "spl_dimension_cache" ("conflict") WHERE "conflict" = true;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

-- The resumable cursor behind the dimension rebuild.
--
-- Twenty-two thousand products against a quarter of a million attribute rows
-- will not resolve inside the module dispatcher's sixty-second ceiling, and this
-- exact mistake is already recorded in this codebase: one unbounded call over a
-- big grid died before it could advance its phase, and every retry started over.
-- So the rebuild banks a cursor, stops well short of the ceiling, and the caller
-- loops the endpoint. The same row drives the progress bar and the stop button.
CREATE TABLE IF NOT EXISTS "spl_backfill_jobs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "kind" TEXT NOT NULL DEFAULT 'dimensions',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    -- Offset into a deterministically-ordered product list, so resuming lands
    -- exactly where it stopped rather than approximately.
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "resolved_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_backfill_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spl_backfill_jobs_status_check" CHECK (
        "status" IN ('QUEUED', 'RUNNING', 'DONE', 'CANCELLED', 'FAILED')
    )
);

CREATE INDEX IF NOT EXISTS "spl_backfill_jobs_status_idx" ON "spl_backfill_jobs" ("status");
CREATE INDEX IF NOT EXISTS "spl_backfill_jobs_created_at_idx" ON "spl_backfill_jobs" ("created_at" DESC);

-- A photoreal render of a plan, produced by an external worker.
--
-- Async because module routes share an un-overridable sixty-second ceiling and
-- background work started with after() gets starved with them. Nothing
-- render-shaped runs inline, ever.
--
-- `plan_updated_at` is the plan's stamp when the job was enqueued. A render is a
-- photograph of a moment: if the plan has moved on, the finished image is
-- labelled with the date it depicts and the plan offers a re-render, rather than
-- presenting a picture of furniture that has since been moved as if it were
-- current.
CREATE TABLE IF NOT EXISTS "spl_render_jobs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "plan_id" TEXT NOT NULL,
    "member_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "plan_updated_at" TIMESTAMP(3),
    "result_media_id" TEXT,
    "result_url" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    -- Shared secret the worker echoes back on the callback, per job, so a
    -- finished-job POST cannot be forged for someone else's plan.
    "callback_token" TEXT NOT NULL DEFAULT '',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_render_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spl_render_jobs_plan_id_fkey" FOREIGN KEY ("plan_id")
        REFERENCES "spl_plans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "spl_render_jobs_status_check" CHECK (
        "status" IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')
    )
);

CREATE INDEX IF NOT EXISTS "spl_render_jobs_plan_id_idx" ON "spl_render_jobs" ("plan_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "spl_render_jobs_status_idx" ON "spl_render_jobs" ("status");

-- ---------------------------------------------------------------------------
-- Analytics
-- ---------------------------------------------------------------------------

-- Counters, not tracking. No IP address, no session id, no personal data of any
-- kind - the same shape and the same retention discipline as the search module's
-- query log, purged by the same nightly cron against a retention setting.
--
-- It exists because the admin promises numbers ("what should we 3D-model next"
-- is answered by placement counts for products that have no model), and a
-- promise of numbers needs a table.
CREATE TABLE IF NOT EXISTS "spl_events" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "event" TEXT NOT NULL,
    "plan_id" TEXT,
    "product_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "spl_events_created_at_idx" ON "spl_events" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "spl_events_event_idx" ON "spl_events" ("event");
CREATE INDEX IF NOT EXISTS "spl_events_product_id_idx" ON "spl_events" ("product_id");
