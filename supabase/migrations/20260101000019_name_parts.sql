-- ============================================================================
-- HYT Wayfinder - first_name / middle_initial / last_name, and first+last verify
-- ============================================================================
--
-- WHY
-- ---
-- The single free-text `name` is being split into three real columns so the
-- forms can collect a first name, an optional middle initial and a last name,
-- and so the entrance check can ask for just a first and last name.
--
-- These columns existed once (20260101000014) but were removed from this
-- database, so this migration re-creates them and fills them in.
--
-- `name` IS KEPT AND IS NOT DERIVED
-- ---------------------------------
-- `name` stays the canonical display string and keeps whatever it already
-- holds. It is deliberately NOT recomputed from the three parts, because the
-- roster stores full middle names ("Gemmalyn Ocbina Aranda") while the forms
-- only collect an initial - deriving would rewrite every existing row to
-- "Gemmalyn O. Aranda" and throw away the middle name.
--
-- So: the three columns are what the forms read and write and what the check
-- matches on; `name` remains what the UI displays and what
-- `orientation_status_for` returns.
--
-- THE BACKFILL IS A HEURISTIC
-- ---------------------------
-- For "First Middle Last" the last word is the surname and the word before it
-- is the middle name, which is how the roster is written. So:
--   'Gemmalyn Ocbina Aranda' -> Gemmalyn / O / Aranda
--   'Mary Grace Miclat Antalan' -> Mary / M / Antalan   (not 'G')
--   'Jhay Ilagan' -> Jhay / (none) / Ilagan
-- It will still be wrong for names that do not follow that shape, e.g.
-- 'Cielo De La Cruz Lim' -> first 'Cielo', middle 'Cruz', last 'Lim'. Those are
-- for an admin to correct on /admin/users; verification only uses first+last.
--
-- NO REGEX
-- --------
-- Word splitting uses split_part / string_to_array / reverse rather than
-- regexp_match. A backslash inside a normal SQL string literal depends on
-- `standard_conforming_strings`, and getting that wrong silently matches
-- nothing - which is exactly the failure this migration exists to fix.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS, the backfill only touches rows with
-- both parts NULL, and the function is dropped then recreated.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The three columns
-- ----------------------------------------------------------------------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_name     TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS middle_initial TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_name      TEXT;

COMMENT ON COLUMN public.users.first_name IS
  'Given name. Backfilled from the first word of `name`; written by the '
  'registration and admin forms from here on.';
COMMENT ON COLUMN public.users.middle_initial IS
  'Single upper-case letter, or NULL when there is no middle name. No period.';
COMMENT ON COLUMN public.users.last_name IS
  'Surname. Backfilled from the last word of `name`.';


-- ----------------------------------------------------------------------------
-- 2. Backfill from `name`
-- ----------------------------------------------------------------------------
-- array_remove drops the empty strings that a double space would produce, so
-- the word positions are always real words.
WITH parts AS (
  SELECT
    u.id,
    array_remove(string_to_array(btrim(u.name), ' '), '') AS w
  FROM public.users u
  WHERE u.first_name IS NULL
    AND u.last_name IS NULL
    AND btrim(u.name) <> ''
)
UPDATE public.users u
SET
  first_name     = p.w[1],
  last_name      = p.w[array_length(p.w, 1)],
  middle_initial = CASE
                     WHEN array_length(p.w, 1) >= 3
                       THEN upper(left(p.w[array_length(p.w, 1) - 1], 1))
                     ELSE NULL
                   END
FROM parts p
WHERE u.id = p.id
  AND array_length(p.w, 1) >= 1;


-- ----------------------------------------------------------------------------
-- 3. Normalise any middle initial already written
-- ----------------------------------------------------------------------------
-- One upper-case letter, no period, so 'o', 'O' and 'O.' all become 'O'.
UPDATE public.users
SET middle_initial = upper(left(btrim(middle_initial), 1))
WHERE middle_initial IS NOT NULL
  AND btrim(middle_initial) <> ''
  AND middle_initial IS DISTINCT FROM upper(left(btrim(middle_initial), 1));

UPDATE public.users
SET middle_initial = NULL
WHERE middle_initial IS NOT NULL
  AND btrim(middle_initial) = '';


-- ----------------------------------------------------------------------------
-- 4. Index the pair the check matches on
-- ----------------------------------------------------------------------------
-- Case-folded, because the lookup folds both sides. ~131 rows does not need it,
-- but it is free and it stops the index being forgotten if the table grows.
CREATE INDEX IF NOT EXISTS users_first_last_idx
  ON public.users (lower(first_name), lower(last_name));


-- ----------------------------------------------------------------------------
-- 5. verify_visitor: match first + last name
-- ----------------------------------------------------------------------------
-- Drop both signatures. (TEXT, UUID) is the original; (TEXT, TEXT, UUID) is
-- what 20260101000017 installed. Postgres keys a function on its argument
-- types, so CREATE OR REPLACE alone would leave the older one callable.
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
      -- Safety net for a row the backfill skipped (both parts still NULL).
      -- Falls back to the first and last WORD of the stored full name, using
      -- reverse/split_part rather than a regex.
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
  'orientation record. Matches users.first_name / users.last_name, falling back '
  'to the first and last word of users.name for rows where those are NULL. Does '
  'not create a session. Returns EVERY match (the caller refuses ambiguity). '
  'recognized = approved, or pending but already signed in before; never true '
  'for declined.';

REVOKE ALL ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) TO anon, authenticated;


NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- Verify - run these after applying
-- ============================================================================

-- 1. How many rows still have no parts? Expect 0 (or only rows whose name is
--    empty, which cannot happen - `name` is NOT NULL).
SELECT count(*) AS missing_parts
FROM public.users
WHERE first_name IS NULL OR last_name IS NULL;

-- 2. Spot-check the split. The middle initial should be the word BEFORE the
--    surname, not the second word.
SELECT name, first_name, middle_initial, last_name
FROM public.users
ORDER BY last_name, first_name
LIMIT 25;

-- 3. Only the 3-arg function must remain.
SELECT pg_get_function_identity_arguments(oid) AS args
FROM pg_proc
WHERE proname = 'verify_visitor'
  AND pronamespace = 'public'::regnamespace;

-- 4. The real test. Replace the course id. Should return the one row.
-- SELECT * FROM public.verify_visitor('Gemmalyn', 'Aranda', '<course uuid>');

-- 5. Case and whitespace are folded. Should return the same single row.
-- SELECT * FROM public.verify_visitor('  gemmalyn ', ' ARANDA ', '<course uuid>');

-- 6. A name not in that course -> zero rows, NOT an error.
-- SELECT count(*) FROM public.verify_visitor('Nobody', 'Here', '<course uuid>');
