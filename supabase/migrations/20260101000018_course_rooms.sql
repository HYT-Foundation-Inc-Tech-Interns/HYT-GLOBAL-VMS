-- ============================================================================
-- HYT Wayfinder - one room per course
--
-- Adds `courses.room_id` so a visitor's room can be derived from the course
-- they are enrolled in, instead of being chosen by hand at the desk. The room
-- a visitor is actually recorded in is still `clock_in_records.room_id`; this
-- column only supplies the default when nobody picked one (an explicit
-- `users.pending_room_id` / manual choice always wins).
--
-- A column rather than a `course_rooms` join table: the model is one room per
-- course. Two courses may point at the same room (Hilot and Massage both use
-- Room 101), which a many-to-one FK expresses without a second table.
--
-- Nullable, and ON DELETE SET NULL, so retiring a room never deletes a course.
-- A course with no room simply gets no auto-assignment - the same as before
-- this migration, not an error.
--
-- Safe to run more than once: ADD COLUMN IF NOT EXISTS, and the seed below is
-- a plain UPDATE that is re-applied on every run.
--
-- After running, reload the PostgREST schema cache so the REST API can see the
-- new column:
--
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================


-- ----------------------------------------------------------------------------
-- courses.room_id - the room a course's visitors are assigned to
-- ----------------------------------------------------------------------------

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS room_id UUID
  REFERENCES public.rooms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS courses_room_idx
  ON public.courses (room_id)
  WHERE room_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- Seed: map each course to its room
-- ----------------------------------------------------------------------------
--
-- EDIT THIS BLOCK to change the allocation. Rooms are matched by
-- `rooms.room_number`, which is the identifier the app resolves with
-- `getRoomByNumber` - NOT the display name.
--
-- No `WHERE room_id IS NULL` guard on purpose: correcting a room number here
-- and re-running the migration should actually take effect. If a course label
-- or room number does not match a row, that pair is silently skipped (the join
-- finds nothing) rather than failing the migration.
--
-- The values below reflect the live database at the time of writing: the five
-- TESDA courses and the four rooms whose names mark them out
-- (Barista / Event Management / Hilot-Massage / Housekeeping).

UPDATE public.courses c
SET room_id = r.id
FROM (VALUES
  ('Barista NC II',                    'Roofdeck'),
  ('Events Management Services NC II', 'Room 403'),
  ('Hilot (Wellness) Services NC II',  'Room 101'),
  ('Massage NC II',                    'Room 101'),
  ('Housekeeping NC II',               'Room 201')
) AS m(course_label, room_number)
JOIN public.rooms r ON r.room_number = m.room_number
WHERE c.label = m.course_label;


-- ----------------------------------------------------------------------------
-- Confirm the end state
-- ----------------------------------------------------------------------------
-- Every course should show the room it was mapped to; an unmapped course shows
-- NULL in room_number.

SELECT c.label, r.room_number, c.room_id
FROM public.courses c
LEFT JOIN public.rooms r ON r.id = c.room_id
ORDER BY c.label;
