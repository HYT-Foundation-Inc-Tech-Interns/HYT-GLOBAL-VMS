-- ============================================================================
-- HYT Wayfinder - verify_visitor matches on first + last name
-- ============================================================================
--
-- WHY
-- ---
-- The entrance poster used to ask for a full name typed exactly as stored. The
-- front desk asked for two fields instead - First name and Last name - so the
-- visitor types what they actually know, and the middle name (which they often
-- omit, and which the roster sometimes records in full and sometimes as an
-- initial) stops being something they have to get right to be let in.
--
-- WHAT
-- ----
-- The lookup now matches the FIRST WORD and the LAST WORD of users.name against
-- the two inputs:
--
--   'Gemmalyn' + 'Aranda'  matches  'Gemmalyn Ocbina Aranda'
--
-- Nothing else changes. `users.name` is still the canonical full name; no column
-- is added, dropped, or backfilled. This is a matching change, not a schema one.
--
-- WHY NOT MATCH ON COLUMNS
-- ------------------------
-- An earlier design split the name into first_name / middle_initial / last_name
-- columns and matched on those. That was rejected: the columns do not exist in
-- this database (they were removed), deriving them from free text is guesswork,
-- and matching on tokens of the one authoritative column needs none of it.
--
-- KNOWN LIMITATION
-- ----------------
-- Tokenising a free-text name is a heuristic and it will not suit every row:
--   * 'Ma. Isabel Parulan Firmalino' -> first token is 'Ma.', so typing 'Isabel'
--     will not match. The visitor must type 'Ma.'.
--   * 'Cielo De La Cruz Lim' -> last token is 'Lim'. A visitor who types the
--     full surname 'De La Cruz Lim' will not match.
-- These are accepted: the roster is small, the front desk can see the stored
-- name, and the alternative (inventing columns) is worse. If it becomes a
-- problem, the fix is a real first/last split done once, by hand, on the roster.
--
-- AMBIGUITY IS UNCHANGED
-- ----------------------
-- This still returns EVERY match, and the caller is still required to refuse
-- when more than one row comes back. Two people in one course can share both a
-- first and a last name, and picking one would show somebody a stranger's
-- verdict and mint a session for the wrong person.
--
-- SECURITY
-- --------
-- Still SECURITY DEFINER, still IDENTIFICATION ONLY (see 20260101000013 and
-- 20260101000015). It resolves who somebody claims to be; it does not
-- authenticate them. The session is minted server-side in /api/verify.
--
-- `id` is added to the result set so the route no longer has to re-query the
-- profile by name to learn the row's id. The email is already returned by this
-- function today, so this exposes nothing that was not already exposed to the
-- same caller.
--
-- Safe to re-run: both signatures are dropped first.
-- ============================================================================


-- Postgres identifies a function by its argument TYPES, so the installed
-- (TEXT, UUID) form is a DIFFERENT function and CREATE OR REPLACE would leave it
-- in place, still callable, still matching on the whole name. Dropped explicitly.
DROP FUNCTION IF EXISTS public.verify_visitor(TEXT, UUID);

-- And the new one, so re-running this file is a no-op rather than an error.
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
  -- False when the roster gave this person no address (migration
  -- 20260101000014). Informational only - the route signs them in regardless,
  -- deriving a synthetic login address from the profile id.
  has_email          BOOLEAN,
  -- Migration 20260101000015: approved, or already a signed-in account. Absent
  -- on an un-migrated database, which is read as false (fail safe -> review).
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
    -- First word of the stored full name. split_part with no delimiter present
    -- returns the whole string, so a one-word name matches on that word.
    AND lower(split_part(btrim(u.name), ' ', 1)) = lower(btrim(p_first_name))
    -- Last word of the stored full name. regexp_match returns NULL for an empty
    -- name, which compares as NULL and so matches nothing - correct.
    AND lower((regexp_match(btrim(u.name), '(\S+)\s*$'))[1]) = lower(btrim(p_last_name));
$$;

COMMENT ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) IS
  'IDENTIFICATION ONLY - resolves a first + last name and a course to an '
  'orientation record. Matches the first and last WORD of users.name, so a '
  'middle name may be omitted by the visitor. Does not create a session. '
  'Returns EVERY match (the caller refuses ambiguity). has_email is false when '
  'no address is on file; recognized is approved, or pending but already signed '
  'in before, and never true for declined.';

REVOKE ALL ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_visitor(TEXT, TEXT, UUID) TO anon, authenticated;


NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- Verify - run these after applying
-- ============================================================================
--
-- 1. First + last, middle name omitted -> the matching row.
--    SELECT * FROM public.verify_visitor('Gemmalyn', 'Aranda', '<course uuid>');
--
-- 2. Case and surrounding whitespace are folded -> still one row.
--    SELECT * FROM public.verify_visitor('  gemmalyn ', ' ARANDA ', '<course uuid>');
--
-- 3. A name not in that course -> zero rows, NOT an error.
--    SELECT count(*) FROM public.verify_visitor('Nobody', 'Here', '<course uuid>');
--
-- 4. Two people sharing a first + last name in one course -> TWO rows, which
--    the caller must treat as ambiguous rather than picking one.
--    SELECT count(*) FROM public.verify_visitor('Juan', 'Dela Cruz', '<course uuid>');
--
-- 5. The old signature must be gone. This must raise
--    "function public.verify_visitor(text, uuid) does not exist":
--    SELECT * FROM public.verify_visitor('Gemmalyn Ocbina Aranda', '<course uuid>');
