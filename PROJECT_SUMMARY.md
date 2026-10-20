# HYT Wayfinder — Project Summary

What this project does, how it is put together, and what you can do with it.

---

## 1. What it does

A visitor management and 3D wayfinding system for the HYT Global Institute
building. It replaces a paper sign-in sheet with two separate things:

**1. Attendance — who is in the building.**
One QR code at the ground floor entrance. Visitors scan it on their phone to
check in, and scan it again to check out. This is the only code that records
attendance.

**2. Room presence — who is in which room.**
One QR code per room, posted on that room's door. Scanning it records that the
person is in that room right now, and closes the room they were in before. This
never touches attendance.

Keeping these two apart matters. If a single code did both jobs, a visitor
standing at the wrong poster could clock themselves out, and "who is in Room
304 right now" would be a guess. As built, attendance is trustworthy and the
occupancy view is based on real scans rather than assumptions.

On top of that, the app gives every visitor an animated 3D route to their
assigned room, drawn with Three.js.

---

## 2. The two kinds of QR code

| | Attendance | Room presence |
| --- | --- | --- |
| Value | `HYT-KIOSK-CHECKIN-STATION` | `HYT-ROOM-01:<ROOM_ID>` |
| How many | Exactly one | One per room |
| Where | Ground floor entrance | On each room door |
| Effect | Clocks in / clocks out | Records presence only |
| Table written | `clock_in_records` | `room_presence` |

`parseQrValue()` in `lib/wayfinding.ts` decides which kind was scanned, based on
the prefix, and returns `null` for anything unrecognised rather than guessing.

Room presence rows are **append-only**. Scanning a room closes your previous
open row first, so you can never be counted in two rooms at once, and the full
movement history survives. That makes "who was in Room 304 at 3pm" answerable
after the fact, not just "who is there now".

---

## 3. Roles and who sees what

| Role | Can do |
| --- | --- |
| `visitor` | Register, scan in/out, view their 3D route |
| `admin` | Everything: station, occupancy, attendance records, room visits, user management |

Public registration can only ever produce a `visitor`: the `handle_new_user`
trigger hardcodes that role and ignores anything the client sends.

There is **exactly one admin**, enforced by a partial unique index rather than
by the UI, and it is hidden from `/admin/users` — it is neither listed nor
editable there. A second admin is a liability, not a convenience: anyone who can
edit users could otherwise grant themselves the keys.

The `trainer` and `trainee` roles were removed. They were never granted
anything: no RLS policy distinguished them from `visitor`, and `/trainer` was a
byte-identical copy of `/visitor`. The enum labels still exist in Postgres,
which cannot drop them — see `20260101000003_retire_trainee_roles.sql`.

### Visitor types are not roles

At an event the people arriving are trainees, trainers and VIPs, but none of
those need different *permissions*. Putting them on `role` is what created the
dead roles above. So classification lives in a separate `visitor_types` lookup
table joined from `users.visitor_type_id`, alongside `company`, `host_name`,
`phone`, `valid_until` and `notes`.

`role` answers "what may this person do" (two values). The visitor profile
answers "who is this person" (many values). Neither grants anything the other
does not. See `20260101000004_visitor_profiles.sql`.

`valid_until` is enforced at login and on session restore, so an orientation's
credentials stop working the morning after the event without anyone archiving
rows by hand.

Admin-only pages are enforced with `useRoleGuard`, which redirects non-admins to
`/admin`.

---

## 4. Pages

| Route | Who | What it does |
| --- | --- | --- |
| `/` | Anyone | Redirects by auth state and role |
| `/login` | Anyone | Sign in |
| `/register` | Anyone | Create a visitor account |
| `/check-in` | visitor | Mobile scanner: check in/out, scan room doors, view 3D route |
| `/visitor` | visitor | Visitor view |
| `/station` | admin | Print the attendance code and each room's door code. Room posters show a live headcount. Live occupancy moved to `/admin` |
| `/occupancy` | admin | Who is inside which room right now |
| `/admin` | admin | Dashboard |
| `/admin/records` | admin | Attendance records (check-in/out), searchable, exportable |
| `/admin/room-records` | admin | Room visit history, grouped per room |
| `/admin/users` | admin | Manage visitors: classify, set host/company/pass expiry, archive and restore |
| `/api/admin/users` | server | Visitor create/edit/archive/restore via the service role key |

---

## 5. How the code is organised

```
app/                    Pages (Next.js App Router)
components/             3D scene, QR scanner, kiosk, route animation
store/                  Zustand state: auth, users, records, roomPresence, clockIn
lib/wayfinding.ts       QR registry + parser — the single source of truth for rooms
lib/supabase.ts         Supabase client
hooks/                  First-person/mobile controls, role guard, profile sync
supabase/setup.sql      Whole database in one file — paste into the SQL editor
scripts/                next-with-canonical-path.js (Windows path-casing fix)
```

Roughly 7,600 lines across ~40 source files. The largest are the kiosk view
(643), the attendance records page (606), and the user management page (583).

### The two stores worth knowing about

`lib/wayfinding.ts` is the single source of truth for rooms. Both the kiosk
(which prints codes) and the scanner (which reads them) derive everything from
it, so **adding a room is a one-entry change** — add a route here, plus the
destination to `DESTINATIONS` in `store/authStore.ts`.

`store/roomPresenceStore.ts` owns all room-presence reads and writes. Nothing
else touches the `room_presence` table.

---

## 6. Setting it up

Full instructions are in [README.md](./README.md). The short version:

```bash
npm install
cp .env.example .env.local    # then fill in your Supabase keys
# Paste supabase/setup.sql into the Supabase SQL editor and run it
npm run dev
```

Environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Public key; safe in the browser — RLS protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | for account create/delete | **Server-only.** Bypasses RLS. Never prefix with `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_APP_URL` | recommended | Base URL |
| `SMTP_*`, `DATABASE_URL`, `QR_EXPIRY_HOURS` | optional | Not currently wired up |

Deploy with [VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md). Set the environment
variables for all three Vercel environments and redeploy — Vercel only injects
variables into new builds.

---

## 7. What you can do with it

**Straight away, with no code changes:**

- Print the attendance code and post it at the entrance; print one room code per
  room door. Both are generated on `/station`.
- See who is in the building and who is in which room, live.
- Search and export the full attendance history.
- Review every room visit, per room, with dates and durations.
- Create accounts and assign roles and destinations.
- Deploy to Vercel.

**Small changes, in the files named:**

- **Add a room** — add an entry to `lib/wayfinding.ts` with its waypoints, and to
  `DESTINATIONS` in `store/authStore.ts`. The kiosk, scanner, occupancy view and
  room-records page all pick it up automatically.
- **Change the route animation** — waypoints are plain coordinates in
  `lib/wayfinding.ts`; the 3D draw is in `components/RouteVisualization.tsx`.
- **Swap in a real building model** — load a `.glb` in `components/Building.tsx`
  and adjust collision bounds in `hooks/useFirstPersonControls.ts`.
- **Rebrand the colours** — the palette lives in `tailwind.config.ts` and
  `app/globals.css`.
- **Change what a role can see** — `useRoleGuard` in each page, plus the
  redirects in `app/page.tsx`.

**Natural next features:**

- Export room visits (the attendance page already has CSV/PDF export; room
  visits do not).
- Live updates via Supabase Realtime, so occupancy refreshes without a reload.
- Visitor self-service clock-out from the phone rather than scanning to leave.
- Multiple stations, if you ever add a second entrance — the QR values do carry a
  station id (`HYT-KIOSK-01-`, `HYT-ROOM-01-`), but that id is hardcoded in
  `lib/wayfinding.ts`, so a second entrance means generalising the constants and
  the parser, not just adding a data row.
- Email notifications via the unused `SMTP_*` variables.

---

## 8. Known gaps

Worth knowing before you rely on this:

- **Database setup is one file.** `supabase/setup.sql` builds the entire schema
  and seeds it. See [supabase/SCHEMA.md](./supabase/SCHEMA.md) for the ERD and
  design notes. The code and the schema match.
- **Old-format room posters still work.** Codes printed as
  `HYT-KIOSK-01-CHECKIN-STATION:<ROOM>` resolve to the room they name, so a door
  scan records presence and never touches attendance. Reprinting in the
  `HYT-ROOM-01:<ROOM>` format is optional.
- **Account create/delete returns `501`** until `SUPABASE_SERVICE_ROLE_KEY` is
  set. Read and update still work.
- **No automated tests.** The QR parser and presence logic have been tested
  manually; there is no test runner configured.
- **`prisma:*` scripts in `package.json` are dead** — they point at a Prisma
  setup that was replaced by Supabase. Safe to delete.
- **Demo credentials were shown on the login page.** They were removed from the
  UI, but if those accounts exist, treat the passwords as compromised and reset
  them.
