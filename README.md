# HYT Wayfinder

A visitor management and 3D wayfinding system for the HYT Global Institute
building. Visitors register, check in by scanning the QR code at their lobby
station, and are shown an animated 3D route to their destination. Staff get
occupancy and check-in record dashboards.

> **Looking for an overview?** See [PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md) for
> what the system does, how it's organised, what you can do with it, and known
> gaps. This README is the setup and reference guide.
>
> Database design: [supabase/SCHEMA.md](./supabase/SCHEMA.md).

## Features

- Supabase email/password auth with a single admin account and a shared `visitor` role
- Visitor profiles: classification (trainee / trainer / VIP / contractor), host, company, phone, pass expiry and notes
- Real access revocation — archiving a visitor bans their login in Supabase Auth, and can be undone
- Self-service registration with purpose and destination assignment
- Lobby kiosk station that prints the ground floor attendance code and one room door code per room
- QR scanning on mobile (`html5-qrcode`): the ground floor code clocks in/out, room door codes track who is inside which room
- **Option D scan flow** — nobody has to remember to check out of a room; scanning a different room is a move, and checking out of the building closes any open room visit
- Animated 3D route visualization per destination (Three.js / React Three Fiber)
- First-person 3D building exploration with collision detection
- Live occupancy where every room is clickable and drops down who is inside it
- Room management CRUD (`/admin/rooms`) — add, rename and deactivate rooms
- Admin dashboard, attendance records, room visit history, and user management
- Dark mode and responsive/mobile layouts

## Tech Stack

- Next.js 14 (App Router) + React 18 + TypeScript (strict)
- Three.js / React Three Fiber / Drei
- Supabase (Auth + Postgres + Row Level Security)
- Zustand for client state (with `persist`)
- Tailwind CSS
- html5-qrcode + react-qr-code

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project (free tier is fine)

### Installation

```bash
npm install
```

### Environment variables

Copy `.env.example` to `.env.local` and fill in your Supabase credentials:

```bash
cp .env.example .env.local
```

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Project URL, e.g. `https://xxxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | `anon`/`public` key. Safe in the browser — RLS protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | for admin create/delete | **Server-only.** Bypasses RLS. Never prefix it with `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_APP_URL` | recommended | Base URL of the app |
| `DATABASE_URL` | optional | Direct Postgres connection string |
| `SMTP_*` | optional | Outbound email |

`.env.local` is gitignored — never commit real credentials.

### Database

Seven tables: `rooms`, `purposes`, `visitor_types`, `courses`, `users`,
`clock_in_records` and `room_visits`.

Setting up a database is **one step**:

1. Create a Supabase project.
2. Open **SQL Editor → New query**.
3. Paste all of [`supabase/setup.sql`](./supabase/setup.sql) and run it.

That file builds the whole schema — tables, indexes, triggers, row-level
security, policies, grants, the two RPC functions, and the seed data (rooms,
purposes, visitor types, courses). It is idempotent, so re-running it is safe.

Then create your first admin — instructions are at the bottom of `setup.sql`:

```sql
-- after adding the user in Authentication -> Users
UPDATE public.users SET role = 'admin' WHERE email = 'admin@hyt.com';
```

This is a **fresh** schema, not an upgrade path: it creates clean tables rather
than `ALTER`ing old ones, so there is no data migration to run.

> **Old-format room posters still work.** Codes printed as
> `HYT-KIOSK-01-CHECKIN-STATION:<ROOM>` are read as the room they name, so a door
> scan records presence and never touches attendance. Reprinting them in the
> `HYT-ROOM-01:<ROOM>` format is worth doing when convenient, but is not required.

Design notes in [supabase/SCHEMA.md](./supabase/SCHEMA.md) explain the ERD and
three things that are easy to get wrong:

- `duration_minutes` and `status` are **generated columns** — Postgres computes
  them, and any INSERT or UPDATE that includes them fails. Never write them.
- `room_visits` has no `room_label`; join `rooms` for the display name.
- Rooms are referenced by **id**, never copied as text.

### Create the first admin

1. Supabase Dashboard → Authentication → Users → **Add User**
2. Create `admin@hyt.com` with a password and auto-confirm enabled
3. Insert the matching profile row:

```sql
INSERT INTO public.users (id, email, name, role)
VALUES (
  'REPLACE-WITH-AUTH-USER-UUID',
  'admin@hyt.com',
  'Admin User',
  'admin'
);
```

The UUID is the `id` shown on the Authentication → Users page.

### Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `npm run dev` goes through
`scripts/next-with-canonical-path.js`, which normalizes the project directory's
letter casing before starting Next.js. This matters on Windows, where a
mixed-case path otherwise produces two module copies and
`Invariant: Missing ActionQueueContext`.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing page; redirects by role |
| `/login`, `/register` | Authentication |
| `/check-in` | Mobile QR scanner and check-in/out (visitor) |
| `/station` | Lobby kiosk — prints the check-in QR code and each room's door code |
| `/visitor` | Visitor view |
| `/occupancy` | Live room occupancy. Each room is a button that drops down who is inside (admin only) |
| `/admin` | Admin dashboard |
| `/admin/records` | Attendance records (check-in/out) |
| `/admin/room-records` | Room visit history, grouped per room |
| `/admin/rooms` | Room management: add, rename, deactivate (admin only) |
| `/admin/users` | Visitor management: classify, set pass expiry, archive/restore (requires `SUPABASE_SERVICE_ROLE_KEY`) |
| `/api/admin/users` | Server route for visitor create/edit/archive/restore |

`/clock-in` permanently redirects to `/check-in`, so existing bookmarks and
printed links keep working.

## QR codes

There are two kinds of QR code, and they are deliberately different things.

**Attendance — exactly one, on the ground floor.** `HYT-KIOSK-CHECKIN-STATION`.
This is the only code that records attendance. Scanning it clocks you in;
scanning it again clocks you out. It carries no room, so the 3D route you get
is resolved from your assigned destination instead of from the code.

**Room presence — one per room, on the door.** `HYT-ROOM-01:<ROOM_ID>`.
Scanning one records that you are inside that room right now. It never touches
attendance, so scanning the wrong poster can't change your check-in status.
Rows are append-only: scanning a room closes any room you were in before, so
"who was in Room 304 at 3pm" is answerable, not just "who is there now".

`parseQrValue()` in `lib/wayfinding.ts` decides which kind was scanned and
returns `null` for anything unrecognised rather than guessing.

### Attendance flow

The goal is that **nobody has to remember to check out of a room**. The system
already knows where they are, so it does not ask them to report it.

1. **Arrive** — scan the ground floor code. Opens a `clock_in_records` row with
   `time_in` and shows the 3D route to your assigned destination.
2. **Enter a room** — scan that room's door code. Opens a `room_visits` row.
   Attendance is untouched.
3. **Leave the building** — scan the ground floor code again. Sets `time_out` and
   closes any room visit still open.

Three scans for a normal visit. The four rules the scanner enforces:

- **R1** — a room scan without an active check-in is **refused**. Otherwise anyone
  could put themselves in a room they never entered the building for.
- **R2** — checking out while recorded inside a room **prompts first**, naming the
  room, because that scan ends two things at once.
- **R3** — if they confirm, both rows close together; if they cancel, they stay
  checked in and in the room. The two tables can never disagree about where
  someone is.
- **R4** — scanning a *different* room is a move: the current room closes, the new
  one opens. A partial unique index (`room_visits_one_open_per_user`) enforces
  one open room per person; the client closes before inserting so it doesn't trip.

There is no mode toggle. `parseQrValue()` decides which kind of code was scanned
from its prefix, so the flow stays one-button. Instead the scanner shows the
current state as a plain line — *"Checked in · In Room 304"*.

### Tables

| Table | Written by | Answers |
| --- | --- | --- |
| `clock_in_records` | ground floor code only | Who is checked in, and since when |
| `room_visits` | room door codes only | Who is in which room, and when they moved |

Keeping these apart is load-bearing. If one code did both jobs, a visitor standing
at the wrong poster could clock themselves out, and "who is in Room 304 right now"
would be a guess.

Two invariants worth preserving: **attendance is only ever written by the entrance
code**, and **presence is only ever written by room codes** (except closing an open
row on clock-out, per R3). Never write `user_name` or `user_role` onto visit rows —
join from `users`, because denormalising them is what caused drift before.

The two are reported separately on purpose:

- **`/admin/records`** — attendance. Who is in the building, since when.
- **`/admin/room-records`** — presence. Per room, who entered and when, with
  search and date filters. Every visit is a row, so "who was in Room 304 at 3pm"
  is answerable after the fact.
- **`/admin/rooms`** — the rooms themselves: add, rename, deactivate.
- **`/occupancy`** — live. Every room is a button that drops down the people inside
  it with their entry times. Several can be open at once so two rooms can be
  compared. Rooms come from the `rooms` table, so empty ones still appear.
- **`/station`** — each room poster shows a live headcount. Clicking it (at any
  count, including 0) opens that room's records: who is inside now, and who
  already left today with their times and duration. The count is screen-only and
  is deliberately left out of the print window, since a printed number would be
  stale the moment it went up.

To add a room, use `/admin/rooms` — it writes to the `rooms` table, which every
consumer reads. The register form's room picker, `/station`, `/occupancy` and the
scanner all pick it up from there. `lib/wayfinding.ts` additionally needs a route entry
if the new room should get a 3D walkthrough; without one, a visitor assigned to it
falls back to the default route.

## Controls

**Desktop** — `W`/`A`/`S`/`D` or arrow keys to move, mouse to look (click to
lock the pointer), `Space` to jump.

**Mobile** — drag on the left half to move, drag on the right half to look.

## Project structure

```
app/
  page.tsx                  # Landing / role-based redirect
  login/, register/         # Auth pages
  check-in/                 # Mobile QR scan + check-in
  station/                  # Attendance + room door QR codes
  visitor/, occupancy/
  admin/                    # Dashboard, records, room-records, rooms, users
  api/admin/users/route.ts  # Server-only user create/delete
components/                 # 3D scene, camera, building, QR scanner, route
hooks/                      # First-person + mobile controls, role guard, profile
lib/                        # Supabase client, wayfinding registry, WebGL check
store/                      # Zustand: auth, users, records, roomPresence, rooms, clockIn, theme
scripts/                    # next-with-canonical-path.js (Windows casing fix)
supabase/setup.sql           # The whole database in one file - paste and run
supabase/SCHEMA.md           # ERD and design notes
public/                     # Static assets
```

## Commands

```bash
npm run dev     # dev server
npm run build   # production build
npm start       # serve the production build
npm run lint    # ESLint
```

There is no test runner configured. The QR parser (`parseQrValue` in
`lib/wayfinding.ts`) is pure and would be the natural first target.

## Security notes

- Row Level Security is enabled on every table: `rooms`, `purposes`, `users`,
  `clock_in_records`, `room_visits`, and `visitor_types`.
- `rooms`, `purposes` and `visitor_types` are lookup data — labels with no user
  information — so they are readable by anyone. That is deliberate: the register
  form runs before anyone has signed in, and its pickers would otherwise be
  empty for a brand-new visitor.
- The `anon` key is embedded in the client bundle by design; RLS, not the key,
  is what protects the data.
- `SUPABASE_SERVICE_ROLE_KEY` is only read inside
  `app/api/admin/users/route.ts`, which runs on the server. Without it, create
  and delete return `501` and read/update keep working.
- The admin route verifies the caller is an admin using their own access token;
  the service key is never sent back to the browser.
- **Exactly one admin exists**, enforced by a partial unique index rather than by
  the UI, and it is hidden from `/admin/users`. A second admin is a liability:
  anyone who can edit users could otherwise grant themselves the keys.
- **Public registration can only ever create a `visitor`.** The `handle_new_user`
  trigger hardcodes the role and ignores whatever the client sends.
- Attendance history is never deleted — `users` uses `archived_at`, and the
  foreign keys are `ON DELETE RESTRICT`.

### Assigned room and purpose

Both the register form and the admin form collect an assigned room and a purpose. They
look the same but store differently, and both end up in the same place:

- **Register** keeps the values in the visitor's session (room *number*, purpose
  *label*) and additionally writes them to `users.pending_room_id` /
  `pending_purpose_id`.
- **Admin** has no session belonging to the new visitor, so it writes straight to
  those two columns. The picker stores the room *id* here, not the number.

At sign-in, `pendingFromProfile()` in `store/authStore.ts` resolves those ids back to
the room number and purpose label, so `QRScanner` reads one shape regardless of how
the account was created. It fetches the rooms and purposes lists first when the
columns are present, so the assignment is there the first time the scanner runs.

These are **pending intent, not a record**. The authoritative room and purpose are on
`clock_in_records`, one row per visit, because a person can attend a Meeting today and
an Orientation next week. The pending columns only seed the first visit, and an admin
can change them any time before the person arrives.

### Pass expiry

`users.valid_until` decides whether a pass still works. `NULL` means it never expires,
and `isPassExpired` compares against the **start** of today rather than the current
instant — so a pass set to expire "on the 10th" is valid for the whole of the 10th.
Comparing against the raw timestamp would lock someone out at midnight the night
before the event they came for.

The two creation paths differ on purpose:

- **Self-registration** — no date is asked. The form sends the end of the registering
  day, and `20260101000006_default_pass_expiry.sql` sets the same value as a column
  DEFAULT, so even a writer that forgets the field still gets a one-day pass rather
  than one that never expires.
- **Admin** — the "Pass valid until" date input is manual, and an explicit `NULL`
  bypasses the DEFAULT. Staff know whether someone is on site for a week; a blanket
  one-day rule would lock them out with no self-service fix.

An expired pass is refused at sign-in and at check-in, and is flagged red in the admin
user list. **Their attendance history is kept** — expiry closes the door, it does not
erase the record. Existing rows are untouched by that migration.

### Roles vs visitor types

These are different things and the distinction is deliberate:

- `role` answers **"what may this person do"** — and there are only two values,
  `admin` and `visitor`.
- The visitor profile answers **"who is this person"** — many values: trainee,
  trainer, VIP, contractor, plus company, host, phone, pass expiry and notes.
  These live in the `visitor_types` lookup table, joined from `users.visitor_type_id`.

The `trainer` and `trainee` *roles* were removed: no RLS policy ever distinguished
them from `visitor`, and `/trainer` was a byte-identical copy of `/visitor`. The
enum labels still exist in Postgres, which cannot drop them — see
`20260101000003_retire_trainee_roles.sql`.

At an event the people arriving are trainees, trainers and VIPs, but none of them
need different *permissions*. Putting them on `role` is what created the dead roles
in the first place.

## Deployment

See the [Vercel deployment guide](./VERCEL_DEPLOYMENT.md). Remember to set the
environment variables for all three Vercel environments and redeploy — Vercel
only injects variables into new builds.

## License

Private project for HYT Global Institute
