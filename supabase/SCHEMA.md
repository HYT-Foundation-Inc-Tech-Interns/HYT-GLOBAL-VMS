# Database Schema

Seven tables. Two of them record visits, and they deliberately answer different
questions.

Three are small lookup tables that feed the forms: `purposes` (why someone is
here), `visitor_types` (how they relate to the building) and `courses` (which
programme they are enrolled in, and which room that programme uses).

```
                       ┌──────────────┐
                       │    rooms     │
                       ├──────────────┤
                       │ id          PK│
                       │ room_number  U│  'Room 304', 'Roofdeck'
                       │ name          │  display name
                       │ floor         │  'G' | '2' | '3' | '4' | 'Roof'
                       │ building      │
                       │ qr_value      U│  encoded door QR
                       │ is_active     │
                       └───────┬──────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │ 1:N                  │ 1:N                  │ 1:N
   ┌────┴──────────┐     ┌─────┴──────────────┐       │
   │    users      │     │ clock_in_records   │       │
   ├───────────────┤     ├────────────────────┤       │
   │ id       PK   │────▶│ id             PK  │       │
   │ email      U  │     │ user_id      FK  │  │    │
   │ name         │     │ room_id       FK ─┼──┼────┘
   │ role      ENUM│     │ purpose_id    FK  │  │
   │ archived_at  │     │ time_in           │  │
   └───────┬───────┘     │ time_out          │  │
           │             │ duration_minutes G │  │
           │             │ status          G │  │
           │             └─────────┬──────────┘  │
           │                       │ 1:N          │
           │ 1:N            ┌──────┴───────┐      │
           └───────────────▶│  room_visits  │      │
                            ├──────────────┤      │
                            │ id        PK  │      │
                            │ user_id    FK │      │
                            │ room_id    FK │──────┘
                            │ clock_in_id FK │  (→ clock_in_records, nullable)
                            │ entered_at     │
                            │ exited_at      │
                            │ duration_min G │
                            │ status       G │
                            └──────────────┘

       ┌────────────┐
       │ purposes   │  purpose_id FK ──▶ label, is_active
       └────────────┘
```

## The two visit tables

| | `clock_in_records` | `room_visits` |
| --- | --- | --- |
| Question | Was this person in the building? | Which room were they in? |
| Written by | ground floor code **only** | room door codes **only** |
| Rows per visit | exactly one | one per room entered |
| Grain | one row per person per visit | append-only movement log |
| `status` | `active` / `completed` | `inside` / `left` |

Keeping these apart is what makes both reports trustworthy. If room scans went
into `clock_in_records`, every room change would need a new attendance row and
"how long was she in the building" would be unanswerable.

`room_visits.clock_in_id` ties each room entry back to the attendance visit it
happened under. Without it, someone who checks in on Monday and Tuesday has
their room scans blurred into one trail.

## Design decisions

**Rooms are referenced, never copied.** No table stores a room name as free
text. Renaming "Tech Room 201" to "Networking Lab" is a single UPDATE, and all
history stays linked because rows point at `rooms.id`.

**Names and roles are never denormalised.** `room_visits` and
`clock_in_records` store `user_id` only. Name and role come from a join, so
renaming a person updates everywhere at once. (The earlier schema carried
`user_name` / `user_role` on the records, which drifted out of sync.)

**`duration` and `status` are generated.** Postgres computes them from the
timestamps, so they cannot disagree with the data they're derived from. Both are
`NULL` while the record is open — Postgres rejects `NOW()` in a generated
column because generated expressions must be immutable, so the UI shows a live
elapsed timer instead.

**History is never deleted.** `users` has `archived_at`, and there is no DELETE
policy on it. Attendance rows use `ON DELETE RESTRICT`, so you cannot destroy an
attendance record by deleting a user — important for a system that is effectively
a log.

**One room at a time is enforced in the database**, not just the app:

```sql
CREATE UNIQUE INDEX room_visits_one_open_per_user
  ON public.room_visits (user_id) WHERE exited_at IS NULL;
```

If two scans race, the second fails loudly instead of double-counting someone.

**One open attendance row per person** is enforced the same way (migration 008),
so a double-tap or a second device cannot leave two concurrent check-ins open:

```sql
CREATE UNIQUE INDEX clock_in_one_open_per_user
  ON public.clock_in_records (user_id) WHERE time_out IS NULL;
```

**Foreign keys are indexed explicitly.** Postgres does not create these for you,
and the partial indexes on open rows (`WHERE time_out IS NULL`) are what keep
"who's in the building right now" fast as the tables grow.

## RLS

Admins are checked against `public.users` via `is_admin()` rather than JWT
claims, so changing someone's role takes effect immediately instead of waiting
for a token refresh.

Users can **open** their own attendance and **close** their own open record, but
cannot freely update one. The RLS policy limits *which rows* they may touch
(their own, still open); the column-scoped grants in migration 008 limit *which
columns* they may change (`time_out` on attendance, `exited_at` on presence), so
`time_in`, `room_id` and `entered_at` cannot be rewritten after the fact. That
closes a real hole in the previous schema, where `Users can update own records`
let anyone edit their own `time_in` — falsifiable attendance.

## Applying it

One file, one paste:

1. Create a Supabase project.
2. Dashboard → **SQL Editor → New query**.
3. Paste all of [`setup.sql`](./setup.sql) and run it.

`setup.sql` builds everything in this document — tables, indexes, triggers, RLS,
policies, grants, the `verify_visitor` and `orientation_status_for` functions,
and the seed data. It is idempotent, so re-running it changes nothing.

Then create your first admin in Supabase Auth (Authentication → Users → Add
User) and promote the profile row the trigger already created:

```sql
UPDATE public.users SET role = 'admin' WHERE email = 'admin@hyt.com';
```

## Still to decide

- **Room display names.** Seeded as "Room 301", "Tech Room 201" etc. Update the
  rooms `INSERT` in [`setup.sql`](./setup.sql) once the real names are known.
- **Course → room allocation.** The `UPDATE ... FROM (VALUES ...)` block near
  the end of `setup.sql` decides which room each course's students go to.
  Hilot and Massage are currently unmapped because no room 101 exists in the
  seed.
- **Roof access.** `Roofdeck` is a room like any other. If it should only be
  bookable, that likely needs a booking table.
