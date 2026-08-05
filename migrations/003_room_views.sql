-- Space Planner for Shop - saved viewpoints.
--
-- A camera somebody parked and wants back. Until now the only way to photograph
-- a room was from one canned standpoint at the end of its longest wall, which is
-- a reasonable first guess and no use at all to the person who has just spent
-- ten minutes finding the angle that shows the meeting table AND the window.
--
-- Attached to the ROOM rather than to the plan, and that is the whole point of
-- the table. A camera pose is expressed in room coordinates, so it means nothing
-- once you take it somewhere else - but it means exactly the same thing for
-- every layout inside one room. So "Option A from the doorway" and "Option B
-- from the doorway" are two pictures from one saved view, which is the
-- comparison the customer is actually trying to make.
--
-- Idempotent throughout, like 001 and 002 - the module migration runner sees
-- this file again on later deploys, and a fresh install runs all three in order.
--
-- Column types stay inside the backup serialiser's supported set: TEXT, INTEGER,
-- JSONB, TIMESTAMP. No arrays, no enums. See 001 for why that matters here.

CREATE TABLE IF NOT EXISTS "spl_room_views" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "room_id" TEXT NOT NULL,

    -- Named by the person who saved it. "From the door", "Behind Dave".
    "name" TEXT NOT NULL DEFAULT 'View 1',
    -- Ordering is the member's, not the clock's: the list is a set of angles
    -- they compare in a particular order, and re-sorting it by save time every
    -- session would be its own small annoyance.
    "position" INTEGER NOT NULL DEFAULT 0,

    -- Where the eye is, what it is looking at, and which lens.
    --
    -- World metres, y-up, matching the scene the viewer builds - NOT plan
    -- millimetres. Storing plan units here would mean a conversion on every read
    -- and write for the sake of consistency with a table this one never joins.
    -- The shape is { position: {x,y,z}, target: {x,y,z}, fov, projection, zoom }
    -- and it is validated on the way in and again on the way out, because a
    -- camera read back from a room that has since been reshaped can point at
    -- somewhere that no longer exists.
    "camera" JSONB NOT NULL DEFAULT '{}'::jsonb,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spl_room_views_pkey" PRIMARY KEY ("id"),
    -- Deleting a room takes its viewpoints with it. There is no ownership column
    -- here on purpose: the room carries the one authority on who may see this,
    -- and a second copy of that answer is a second thing to get wrong.
    CONSTRAINT "spl_room_views_room_id_fkey" FOREIGN KEY ("room_id")
        REFERENCES "spl_rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "spl_room_views_room_id_idx" ON "spl_room_views" ("room_id", "position");
