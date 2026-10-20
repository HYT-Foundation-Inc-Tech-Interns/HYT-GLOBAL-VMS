-- ============================================================================
-- HYT Wayfinder - complete database setup
--
-- HOW TO USE
-- ----------
--   1. Create a Supabase project.
--   2. Dashboard -> SQL Editor -> New query.
--   3. Paste this whole file. Run it.
--   4. Done. Then create your first admin (see the end of this file).
--
-- This one file replaces every previous migration. It builds the entire
-- schema, all row-level security, all functions, and the seed data.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS, DROP ... IF
-- EXISTS before CREATE, CREATE OR REPLACE, ON CONFLICT DO NOTHING). Running it
-- twice changes nothing.
--
-- DESIGN RULES (worth knowing before editing)
-- -------------------------------------------
--   * Rooms live in one place. Nothing stores a room name as free text.
--   * Names and roles are never copied onto visit rows - they are joined.
--   * `duration` and `status` are GENERATED columns, so they cannot drift from
--     the timestamps they come from.
--   * Nothing deletes attendance history. Users are archived, never removed.
--   * Attendance and presence are separate tables. See supabase/SCHEMA.md.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Types
-- ----------------------------------------------------------------------------
-- Permission level. Only two values exist; 'trainer'/'trainee' were retired
-- because no policy ever treated them differently from 'visitor'.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE public.user_role AS ENUM ('admin', 'visitor');
  END IF;
END
$$;

-- Orientation verdict, shown by /verify.
--   approved - attended orientation, cleared to enter
--   declined - did not attend, turned away
--   pending  - not yet evaluated; what self-registration gets
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'orientation_status') THEN
    CREATE TYPE public.orientation_status AS ENUM ('approved', 'declined', 'pending');
  END IF;
END
$$;


-- ----------------------------------------------------------------------------
-- 2. updated_at helper
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ----------------------------------------------------------------------------
-- 3. Lookup tables
-- ----------------------------------------------------------------------------

-- Every room in the building. qr_value is what is printed on the door and what
-- the scanner matches; it is unique so one code cannot address two doors.
CREATE TABLE IF NOT EXISTS public.rooms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_number TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  floor       TEXT NOT NULL,
  building    TEXT NOT NULL DEFAULT 'HYT-Business Center',
  qr_value    TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rooms_floor_check CHECK (floor IN ('G', '2', '3', '4', 'Roof'))
);

CREATE INDEX IF NOT EXISTS rooms_floor_idx  ON public.rooms (floor) WHERE is_active;
CREATE INDEX IF NOT EXISTS rooms_active_idx ON public.rooms (is_active);

DROP TRIGGER IF EXISTS rooms_touch_updated_at ON public.rooms;
CREATE TRIGGER rooms_touch_updated_at
  BEFORE UPDATE ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- Why someone is in the building on a given visit. A table rather than an enum
-- so adding a purpose never needs a type migration.
CREATE TABLE IF NOT EXISTS public.purposes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- How a visitor relates to the building. Descriptive only - every type here
-- has identical permissions.
CREATE TABLE IF NOT EXISTS public.visitor_types (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      TEXT NOT NULL UNIQUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- The programmes a visitor can be enrolled in. Each course maps to one room,
-- which is how a visitor's destination is assigned automatically.
CREATE TABLE IF NOT EXISTS public.courses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  room_id    UUID REFERENCES public.rooms(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS courses_room_idx ON public.courses (room_id)
  WHERE room_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 4. users - one profile row per Supabase Auth user
-- ----------------------------------------------------------------------------
-- id matches auth.users.id; Supabase Auth owns the password, this table owns
-- everything the front desk reads.

CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Nullable on purpose: some people on the roster have no usable address, and
  -- /verify sends them to the front desk instead of promising an email link.
  email       TEXT UNIQUE,
  name        TEXT NOT NULL,
  role        public.user_role NOT NULL DEFAULT 'visitor',

  -- Name split into parts so /verify can match first + last name. `name` stays
  -- the display string.
  first_name     TEXT,
  middle_initial TEXT,
  last_name      TEXT,

  visitor_type_id UUID REFERENCES public.visitor_types(id) ON DELETE SET NULL,
  course_id       UUID REFERENCES public.courses(id)       ON DELETE SET NULL,
  company         TEXT,
  host_name       TEXT,
  phone           TEXT,
  notes           TEXT,

  -- Pass expiry. Default is end of the registering day; an admin can set an
  -- explicit date, or NULL for a pass that never expires.
  valid_until TIMESTAMPTZ DEFAULT (date_trunc('day', now()) + interval '1 day' - interval '1 second'),

  -- Room and purpose assigned before check-in, applied by the scanner at
  -- check-in. Cleared afterwards.
  pending_room_id    UUID REFERENCES public.rooms(id)    ON DELETE SET NULL,
  pending_purpose_id UUID REFERENCES public.purposes(id) ON DELETE SET NULL,

  orientation_status public.orientation_status NOT NULL DEFAULT 'pending',

  -- Soft delete. Attendance history must outlive the person.
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_role_idx              ON public.users (role);
CREATE INDEX IF NOT EXISTS users_active_idx            ON public.users (archived_at);
CREATE INDEX IF NOT EXISTS users_visitor_type_idx      ON public.users (visitor_type_id);
CREATE INDEX IF NOT EXISTS users_orientation_status_idx ON public.users (orientation_status);
CREATE INDEX IF NOT EXISTS users_valid_until_idx       ON public.users (valid_until)
  WHERE valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_first_last_idx        ON public.users (lower(first_name), lower(last_name));

-- Only one admin account, enforced in the database. Oldest wins.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx
  ON public.users ((TRUE))
  WHERE role = 'admin';

DROP TRIGGER IF EXISTS users_touch_updated_at ON public.users;
CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ----------------------------------------------------------------------------
-- 5. clock_in_records - ATTENDANCE. Ground floor code only.
-- ----------------------------------------------------------------------------
-- "Was this person in the building, and for how long." One row per visit.
-- Room door codes must never write here - that is room_visits' job.

CREATE TABLE IF NOT EXISTS public.clock_in_records (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.users(id)    ON DELETE RESTRICT,
  room_id    UUID REFERENCES public.rooms(id)             ON DELETE RESTRICT,
  purpose_id UUID REFERENCES public.purposes(id)          ON DELETE RESTRICT,

  time_in  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  time_out TIMESTAMPTZ,

  -- Derived, never written by the app. NULL while the visit is open, because
  -- Postgres rejects NOW() in a generated column (not immutable).
  duration_minutes INTEGER GENERATED ALWAYS AS (
    CASE WHEN time_out IS NULL THEN NULL
         ELSE FLOOR(EXTRACT(EPOCH FROM (time_out - time_in)) / 60)::INT
    END
  ) STORED,

  status TEXT GENERATED ALWAYS AS (
    CASE WHEN time_out IS NULL THEN 'active' ELSE 'completed' END
  ) STORED,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT clock_in_time_order CHECK (time_out IS NULL OR time_out >= time_in)
);

CREATE INDEX IF NOT EXISTS clock_in_user_idx    ON public.clock_in_records (user_id);
CREATE INDEX IF NOT EXISTS clock_in_room_idx    ON public.clock_in_records (room_id);
CREATE INDEX IF NOT EXISTS clock_in_purpose_idx ON public.clock_in_records (purpose_id);
CREATE INDEX IF NOT EXISTS clock_in_time_in_idx ON public.clock_in_records (time_in DESC);
CREATE INDEX IF NOT EXISTS clock_in_open_idx    ON public.clock_in_records (user_id)
  WHERE time_out IS NULL;

-- One open attendance row per person: a double-tap or a second device cannot
-- leave two concurrent check-ins open.
CREATE UNIQUE INDEX IF NOT EXISTS clock_in_one_open_per_user
  ON public.clock_in_records (user_id)
  WHERE time_out IS NULL;

DROP TRIGGER IF EXISTS clock_in_touch_updated_at ON public.clock_in_records;
CREATE TRIGGER clock_in_touch_updated_at
  BEFORE UPDATE ON public.clock_in_records
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ----------------------------------------------------------------------------
-- 6. room_visits - PRESENCE. Room door codes only.
-- ----------------------------------------------------------------------------
-- Append-only: a scan opens a row, the next scan closes it. Never affects
-- attendance.

CREATE TABLE IF NOT EXISTS public.room_visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  room_id     UUID NOT NULL REFERENCES public.rooms(id) ON DELETE RESTRICT,
  -- Ties this room entry to the attendance visit it happened under, so a
  -- person's Monday and Tuesday room scans do not blur together.
  clock_in_id UUID REFERENCES public.clock_in_records(id) ON DELETE SET NULL,

  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exited_at  TIMESTAMPTZ,

  duration_minutes INTEGER GENERATED ALWAYS AS (
    CASE WHEN exited_at IS NULL THEN NULL
         ELSE FLOOR(EXTRACT(EPOCH FROM (exited_at - entered_at)) / 60)::INT
    END
  ) STORED,

  status TEXT GENERATED ALWAYS AS (
    CASE WHEN exited_at IS NULL THEN 'inside' ELSE 'left' END
  ) STORED,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT room_visit_time_order CHECK (exited_at IS NULL OR exited_at >= entered_at)
);

CREATE INDEX IF NOT EXISTS room_visits_user_idx     ON public.room_visits (user_id);
CREATE INDEX IF NOT EXISTS room_visits_room_idx     ON public.room_visits (room_id);
CREATE INDEX IF NOT EXISTS room_visits_clock_in_idx ON public.room_visits (clock_in_id);
CREATE INDEX IF NOT EXISTS room_visits_entered_idx  ON public.room_visits (entered_at DESC);
CREATE INDEX IF NOT EXISTS room_visits_open_idx     ON public.room_visits (room_id)
  WHERE exited_at IS NULL;

-- One person, one room at a time. If two scans race, the second fails loudly
-- instead of double-counting someone.
CREATE UNIQUE INDEX IF NOT EXISTS room_visits_one_open_per_user
  ON public.room_visits (user_id)
  WHERE exited_at IS NULL;


-- ----------------------------------------------------------------------------
-- 7. Row Level Security - enable
-- ----------------------------------------------------------------------------
-- RLS needs BOTH this and the policies in section 10. Without ENABLE the
-- policies are inert.

ALTER TABLE public.rooms            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purposes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitor_types    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clock_in_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_visits      ENABLE ROW LEVEL SECURITY;


-- ----------------------------------------------------------------------------
-- 8. Table privileges
-- ----------------------------------------------------------------------------
-- RLS and GRANT are two separate gates. Without a table privilege Postgres
-- rejects the statement with 42501 and never evaluates the policies at all.
--
-- Deliberately no DELETE anywhere: nothing may destroy attendance history.

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Reference data: readable by anyone, writable by admins (RLS decides who).
GRANT SELECT ON public.rooms         TO anon, authenticated;
GRANT SELECT ON public.purposes      TO anon, authenticated;
GRANT SELECT ON public.visitor_types TO anon, authenticated;
GRANT SELECT ON public.courses       TO anon, authenticated;

GRANT INSERT, UPDATE ON public.rooms         TO authenticated;
GRANT INSERT, UPDATE ON public.purposes      TO authenticated;
GRANT INSERT, UPDATE ON public.visitor_types TO authenticated;
GRANT INSERT, UPDATE ON public.courses       TO authenticated;

-- Profiles: archived, never deleted.
GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;

-- Attendance and presence.
GRANT SELECT, INSERT, UPDATE ON public.clock_in_records TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.room_visits      TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- service_role: used by /api/admin/users and /api/verify. Bypasses RLS, so the
-- requireAdmin check in those routes is the only gate.
GRANT SELECT, INSERT, UPDATE ON public.users            TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.clock_in_records TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.room_visits      TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.rooms            TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.purposes         TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.visitor_types    TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.courses          TO service_role;

-- Least privilege: a visitor may only stamp the close-out time on their own
-- rows, never rewrite time_in, room_id or entered_at after the fact.
REVOKE UPDATE ON public.clock_in_records FROM authenticated;
GRANT  UPDATE (time_out) ON public.clock_in_records TO authenticated;
REVOKE UPDATE ON public.room_visits FROM authenticated;
GRANT  UPDATE (exited_at) ON public.room_visits TO authenticated;


-- ----------------------------------------------------------------------------
-- 9. Functions
-- ----------------------------------------------------------------------------

-- Admin check reads public.users rather than the JWT, so a role change takes
-- effect immediately instead of waiting for the token to refresh.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin' AND archived_at IS NULL
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;


-- Create the profile row the moment an auth user exists.
-- SECURITY DEFINER because the inserting role is supabase_auth_admin, which has
-- no grants on public.users.
--
-- ON CONFLICT (id) DO NOTHING matters: /api/verify provisions a login for a
-- profile row that was imported before the login existed, so the id is often
-- already present.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NULLIF(NEW.raw_user_meta_data ->> 'name', ''),
      NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
      -- Last resort: users.email is nullable, so a login with no address would
      -- otherwise violate users.name NOT NULL and abort the auth insert.
      'Visitor'
    ),
    'visitor'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop every non-internal trigger on auth.users first. A leftover trigger from
-- an older setup would keep firing alongside ours.
DO $$
DECLARE
  trg record;
BEGIN
  FOR trg IN
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = 'auth.users'::regclass
      AND NOT tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users', trg.tgname);
  END LOOP;
END
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- Identify a visitor by first + last name and course. IDENTIFICATION ONLY: it
-- creates no session. Returns every match so the caller can refuse ambiguity.
DROP FUNCTION IF EXISTS public.verify_visitor(TEXT, UUID);
DROP FUNCTION IF EXISTS public.verify_visitor(TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.verify_visitor(
  p_first_name TEXT,
  p_last_name  TEXT,
  p_course_id  UUID
)
RETURNS TABLE (
  id                 UUID,
  orientation_status public.orientation_status,
  full_name          TEXT,
  programme          TEXT,
  course_id          UUID,
  email              TEXT,
  has_email          BOOLEAN,
  recognized         BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    u.id,
    u.orientation_status,
    u.name,
    c.label,
    u.course_id,
    u.email,
    (u.email IS NOT NULL),
    (
      u.orientation_status = 'approved'
      OR (
        u.orientation_status = 'pending'
        AND EXISTS (
          SELECT 1 FROM auth.users a
           WHERE a.id = u.id
             AND a.last_sign_in_at IS NOT NULL
        )
      )
    )
  FROM public.users u
  LEFT JOIN public.courses c ON c.id = u.course_id
  WHERE u.course_id = p_course_id
    AND u.archived_at IS NULL
    AND (
      -- Normal case: the split columns are populated.
      (
        lower(btrim(u.first_name)) = lower(btrim(p_first_name))
        AND lower(btrim(u.last_name)) = lower(btrim(p_last_name))
      )
      OR
      -- Safety net for a row where the split columns are still NULL: fall back
      -- to the first and last word of the stored full name.
      (
        u.first_name IS NULL
        AND u.last_name IS NULL
        AND lower(split_part(btrim(u.name), ' ', 1)) = lower(btrim(p_first_name))
        AND lower(reverse(split_part(reverse(btrim(u.name)), ' ', 1)))
              = lower(btrim(p_last_name))
      )
    );
$$;

COMMENT ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) IS
  'IDENTIFICATION ONLY - resolves a first + last name and a course to an '
  'orientation record. Does not create a session. Returns EVERY match (the '
  'caller refuses ambiguity). recognized = approved, or pending but already '
  'signed in before; never true for declined.';

REVOKE ALL ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) TO anon, authenticated;


-- Look up one person's orientation verdict by email.
CREATE OR REPLACE FUNCTION public.orientation_status_for(p_email TEXT)
RETURNS TABLE (
  orientation_status public.orientation_status,
  full_name          TEXT,
  programme          TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    u.orientation_status,
    u.name,
    c.label
  FROM public.users u
  LEFT JOIN public.courses c ON c.id = u.course_id
  WHERE lower(u.email) = lower(btrim(p_email))
    -- Archived rows excluded: a leftover account from a previous cohort must
    -- not surface as "approved" to whoever now owns that address.
    AND u.archived_at IS NULL
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.orientation_status_for(TEXT) IS
  'Returns the orientation verdict for one email. SECURITY DEFINER.';

REVOKE ALL ON FUNCTION public.orientation_status_for(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.orientation_status_for(TEXT) TO anon, authenticated;


-- ----------------------------------------------------------------------------
-- 10. Policies
-- ----------------------------------------------------------------------------
-- Dropped first so the file is re-runnable and so policies from an older
-- version of this schema cannot survive.

-- rooms: readable by anyone, because the registration form and the scanner
-- both need rows before anyone has signed in.
DROP POLICY IF EXISTS "rooms readable when signed in" ON public.rooms;
DROP POLICY IF EXISTS "rooms readable by anyone"      ON public.rooms;
CREATE POLICY "rooms readable by anyone"
  ON public.rooms FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "admins manage rooms" ON public.rooms;
CREATE POLICY "admins manage rooms"
  ON public.rooms FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());

-- purposes: same.
DROP POLICY IF EXISTS "purposes readable when signed in" ON public.purposes;
DROP POLICY IF EXISTS "purposes readable by anyone"       ON public.purposes;
CREATE POLICY "purposes readable by anyone"
  ON public.purposes FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "admins manage purposes" ON public.purposes;
CREATE POLICY "admins manage purposes"
  ON public.purposes FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());

-- visitor_types: same.
DROP POLICY IF EXISTS "visitor_types readable when signed in" ON public.visitor_types;
DROP POLICY IF EXISTS "visitor_types readable by anyone"      ON public.visitor_types;
CREATE POLICY "visitor_types readable by anyone"
  ON public.visitor_types FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "admins manage visitor_types" ON public.visitor_types;
CREATE POLICY "admins manage visitor_types"
  ON public.visitor_types FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());

-- courses: same.
DROP POLICY IF EXISTS "courses readable by anyone" ON public.courses;
CREATE POLICY "courses readable by anyone"
  ON public.courses FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "courses manageable by admins" ON public.courses;
CREATE POLICY "courses manageable by admins"
  ON public.courses FOR ALL
  TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- users: own row, plus admin visibility.
DROP POLICY IF EXISTS "users read own row" ON public.users;
CREATE POLICY "users read own row"
  ON public.users FOR SELECT
  USING (auth.uid() = id OR is_admin());

DROP POLICY IF EXISTS "users update own row" ON public.users;
CREATE POLICY "users update own row"
  ON public.users FOR UPDATE
  USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Self-registration fallback. Scoped tightly: own id only, visitor role only,
-- so this cannot be used to mint an admin.
DROP POLICY IF EXISTS "users insert own row" ON public.users;
CREATE POLICY "users insert own row"
  ON public.users FOR INSERT
  WITH CHECK (auth.uid() = id AND role = 'visitor');

DROP POLICY IF EXISTS "admins insert users" ON public.users;
CREATE POLICY "admins insert users"
  ON public.users FOR INSERT
  WITH CHECK (is_admin());

-- No DELETE policy on purpose: accounts are archived via archived_at.

-- clock_in_records: open and close your own visit; admins manage all.
DROP POLICY IF EXISTS "read own attendance" ON public.clock_in_records;
CREATE POLICY "read own attendance"
  ON public.clock_in_records FOR SELECT
  USING (auth.uid() = user_id OR is_admin());

DROP POLICY IF EXISTS "open own attendance" ON public.clock_in_records;
CREATE POLICY "open own attendance"
  ON public.clock_in_records FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "close own open attendance" ON public.clock_in_records;
CREATE POLICY "close own open attendance"
  ON public.clock_in_records FOR UPDATE
  USING (auth.uid() = user_id AND time_out IS NULL)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "admins manage attendance" ON public.clock_in_records;
CREATE POLICY "admins manage attendance"
  ON public.clock_in_records FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());

-- room_visits: same shape.
DROP POLICY IF EXISTS "read own presence" ON public.room_visits;
CREATE POLICY "read own presence"
  ON public.room_visits FOR SELECT
  USING (auth.uid() = user_id OR is_admin());

DROP POLICY IF EXISTS "create own presence" ON public.room_visits;
CREATE POLICY "create own presence"
  ON public.room_visits FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "close own presence" ON public.room_visits;
CREATE POLICY "close own presence"
  ON public.room_visits FOR UPDATE
  USING (auth.uid() = user_id AND exited_at IS NULL)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "admins manage presence" ON public.room_visits;
CREATE POLICY "admins manage presence"
  ON public.room_visits FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());


-- ----------------------------------------------------------------------------
-- 11. Seed data
-- ----------------------------------------------------------------------------

INSERT INTO public.purposes (label) VALUES
  ('Interview'),
  ('Orientation'),
  ('Meeting'),
  ('Training'),
  ('Consultation'),
  ('Maintenance'),
  ('Delivery'),
  ('Other')
ON CONFLICT (label) DO NOTHING;

INSERT INTO public.visitor_types (label, is_primary) VALUES
  ('Trainee',    TRUE),
  ('Trainer',    TRUE),
  ('VIP',        TRUE),
  ('Guest',      FALSE),
  ('Contractor', FALSE),
  ('Intern',     FALSE),
  ('Observer',   FALSE)
ON CONFLICT (label) DO NOTHING;

INSERT INTO public.courses (label) VALUES
  ('Orientation'),
  ('Safety Training'),
  ('Leadership'),
  ('Technical Skills'),
  ('Onboarding'),
  ('Barista NC II'),
  ('Event Management Services NC II'),
  ('Housekeeping NC II'),
  ('Hilot (Wellness) Services NC II'),
  ('Massage NC II')
ON CONFLICT (label) DO NOTHING;

-- Rooms. qr_value is what gets printed on each door; the room number is
-- encoded in it so a code stays readable even if the display name changes.
INSERT INTO public.rooms (room_number, name, floor, qr_value) VALUES
  ('Room 201', 'Tech Room 201', '2',    'HYT-ROOM-01:ROOM-201'),
  ('Room 202', 'Tech Room 202', '2',    'HYT-ROOM-01:ROOM-202'),
  ('Room 301', 'Room 301',      '3',    'HYT-ROOM-01:ROOM-301'),
  ('Room 302', 'Room 302',      '3',    'HYT-ROOM-01:ROOM-302'),
  ('Room 303', 'Room 303',      '3',    'HYT-ROOM-01:ROOM-303'),
  ('Room 304', 'Room 304',      '3',    'HYT-ROOM-01:ROOM-304'),
  ('Room 401', 'Room 401',      '4',    'HYT-ROOM-01:ROOM-401'),
  ('Room 402', 'Room 402',      '4',    'HYT-ROOM-01:ROOM-402'),
  ('Room 403', 'Room 403',      '4',    'HYT-ROOM-01:ROOM-403'),
  ('Room 404', 'Room 404',      '4',    'HYT-ROOM-01:ROOM-404'),
  ('Roofdeck', 'Roofdeck',      'Roof', 'HYT-ROOM-01:ROOFDECK')
ON CONFLICT (room_number) DO UPDATE
  SET name     = EXCLUDED.name,
      floor    = EXCLUDED.floor,
      qr_value = EXCLUDED.qr_value;

-- Each course maps to the room its students use. This is what assigns a
-- visitor's destination automatically at check-in.
--
-- EDIT THIS BLOCK to change the allocation. Rooms are matched by room_number.
-- A course or room that does not match a row is silently skipped, so check the
-- verification output at the end of this file.
UPDATE public.courses c
SET room_id = r.id
FROM (VALUES
  ('Barista NC II',                    'Roofdeck'),
  ('Event Management Services NC II',  'Room 403'),
  ('Housekeeping NC II',               'Room 201')
) AS m(course_label, room_number)
JOIN public.rooms r ON r.room_number = m.room_number
WHERE c.label = m.course_label;

-- Hilot and Massage have no room in the seed above. If the building has one,
-- add the room to the rooms INSERT and uncomment these:
--   ('Hilot (Wellness) Services NC II', 'Room 101'),
--   ('Massage NC II',                   'Room 101')


-- ----------------------------------------------------------------------------
-- 12. Finish
-- ----------------------------------------------------------------------------

-- Tells the API layer the schema changed, so PostgREST picks it up immediately.
NOTIFY pgrst, 'reload schema';

-- Expected: 11 rooms, 8 purposes, 7 visitor_types, 10 courses.
-- Every course with a room shows it in the third column; NULL means unmapped.
SELECT 'rooms' AS what, COUNT(*) AS rows FROM public.rooms
UNION ALL SELECT 'purposes',      COUNT(*) FROM public.purposes
UNION ALL SELECT 'visitor_types', COUNT(*) FROM public.visitor_types
UNION ALL SELECT 'courses',       COUNT(*) FROM public.courses;

SELECT c.label AS course, r.room_number AS room
FROM public.courses c
LEFT JOIN public.rooms r ON r.id = c.room_id
ORDER BY c.label;


-- ============================================================================
-- AFTER RUNNING THIS FILE
-- ============================================================================
--
-- 1. Create the first admin.
--    Authentication -> Users -> Add user (email + password, auto-confirm on).
--    Then, with that user's UUID:
--
--      INSERT INTO public.users (id, email, name, role)
--      VALUES ('AUTH-USER-UUID', 'admin@hyt.com', 'Admin', 'admin');
--
--    The trigger already created a 'visitor' row for that login, so instead of
--    the INSERT you can simply promote it:
--
--      UPDATE public.users SET role = 'admin' WHERE email = 'admin@hyt.com';
--
-- 2. Set the app's environment variables (see .env.example):
--      NEXT_PUBLIC_SUPABASE_URL
--      NEXT_PUBLIC_SUPABASE_ANON_KEY
--      SUPABASE_SERVICE_ROLE_KEY
--
-- 3. Start the app and sign in as the admin.
-- ============================================================================
