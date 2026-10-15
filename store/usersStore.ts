import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { useRoomsStore } from '@/store/roomsStore';
import type { UserRole } from '@/store/authStore';
import { composeFullName, normaliseMiddleInitial } from '@/lib/fullName';

export interface ManagedUser {
  id: string;
  /**
   * Nullable since migration 20260101000014. A cohort member whose roster row
   * carried no address has NULL here, so anything that reads it must cope.
   */
  email: string | null;
  /**
   * The display name, composed from the parts below. Kept as the single string
   * the table renders; the parts are what the edit form binds to.
   */
  name: string;
  /**
   * Name parts (migration 20260101000019). Empty strings / null on a database
   * where the backfill has not run, which the form shows as blank fields.
   */
  firstName: string;
  middleInitial: string | null;
  lastName: string;
  role: UserRole;
  createdAt: Date;
  /** Set when the account was retired. History is kept; the row is not deleted. */
  archivedAt: Date | null;

  // Descriptive visitor fields. None of these grant anything - they exist so a
  // front desk can answer "who is in the building, who are they here to see,
  // and is their pass still good". See migration 004.
  /** Resolved label from `visitor_types`, not the raw id. Null when unclassified. */
  visitorType: string | null;
  company: string | null;
  hostName: string | null;
  phone: string | null;
  /** Pass expiry. Null means the pass never expires. */
  validUntil: Date | null;
  notes: string | null;
  /**
   * What staff expect this person to be here for. Seeds the first attendance
   * record only; `clock_in_records` holds the real per-visit room and purpose.
   * Display labels are resolved by the caller, which has the rooms/purposes
   * lists loaded.
   */
  pendingRoomId: string | null;
  pendingPurposeId: string | null;
  /** FK to courses.id. A stable attribute of the visitor, not per-visit. */
  courseId: string | null;
}

/**
 * True when a pass has expired.
 *
 * Compared against the start of today rather than the current instant, so a
 * pass set to expire "on the 10th" is valid for the whole of the 10th. Using the
 * raw timestamp would expire it at midnight and lock someone out of the very
 * event they were registered for.
 */
export function isPassExpired(user: ManagedUser, now = new Date()): boolean {
  if (!user.validUntil) return false;
  const expiry = new Date(user.validUntil);
  if (Number.isNaN(expiry.getTime())) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return expiry.getTime() < startOfToday.getTime();
}

export interface NewUserInput {
  email: string;
  /** The name, in parts. `name` is composed from these server-side. */
  firstName: string;
  middleInitial?: string;
  lastName: string;
  password: string;
  visitorTypeId?: string;
  company?: string;
  hostName?: string;
  phone?: string;
  validUntil?: string;
  notes?: string;
  /** FK to rooms.id. Seeds the visitor's first attendance record at check-in. */
  pendingRoomId?: string;
  /** FK to purposes.id. Same: an expectation, not a record. */
  pendingPurposeId?: string;
  /** FK to courses.id. Persisted on users.course_id. */
  courseId?: string;
}

export interface UpdateUserInput {
  firstName: string;
  middleInitial?: string;
  lastName: string;
  email: string;
  visitorTypeId?: string;
  company?: string;
  hostName?: string;
  phone?: string;
  validUntil?: string;
  notes?: string;
  pendingRoomId?: string;
  pendingPurposeId?: string;
  courseId?: string;
}

interface UsersState {
  users: ManagedUser[];
  /** Archived accounts, kept separate so the UI can offer a "restore" action. */
  archivedUsers: ManagedUser[];
  isLoading: boolean;
  error: string | null;

  fetchUsers: () => Promise<void>;
  createUser: (input: NewUserInput) => Promise<{ success: boolean; error?: string }>;
  updateUser: (
    id: string,
    updates: UpdateUserInput
  ) => Promise<{ success: boolean; error?: string }>;
  /** Retires the account by setting `archived_at`. Nothing is deleted. */
  archiveUser: (id: string) => Promise<{ success: boolean; error?: string }>;
  /** Reverses an archive, including lifting the Supabase Auth ban. */
  restoreUser: (id: string) => Promise<{ success: boolean; error?: string }>;
  getUserCount: () => number;
  /** Active visitors grouped by `visitor_types` label. */
  getCountByVisitorType: () => { label: string; count: number }[];
  getExpiredCount: () => number;
}

/**
 * Columns that exist on every database, from migration 001 onwards.
 *
 * Deliberately does NOT include the migration-004 columns. A database that has
 * not had 004 applied yet rejects the whole query with
 * `42703 column users.visitor_type_id does not exist` if any unknown column is
 * named - so the fallback must be genuinely narrower, not just the same select
 * without the embed. Selecting the new columns "as a fallback" fails for
 * exactly the same reason as the primary query, which is a fallback that does
 * not fall back.
 */
const SELECT_COLUMNS_BASE =
  'id, email, name, role, created_at, archived_at';

/**
 * Base columns plus the visitor profile added in migration 004, and the embed
 * that resolves `visitor_type_id` to a readable label.
 *
 * The embed means the table can show "Trainee" or "VIP" rather than a raw UUID,
 * with no second round trip. `fetchUsers` retries with progressively narrower
 * selects if this fails, so the admin page still works on a database where 004
 * has not been applied yet.
 *
 * Note the admin row is NOT filtered here by column but by `.neq('role', 'admin')`
 * in `fetchUsers` - see the comment there.
 */
const SELECT_COLUMNS_FULL = `
  id, email, name, role, created_at, archived_at,
  first_name, middle_initial, last_name,
  visitor_type_id, company, host_name, phone, valid_until, notes,
  pending_room_id, pending_purpose_id, course_id,
  visitor_types ( label )
`;
const SELECT_COLUMNS_FALLBACK =
  'id, email, name, role, created_at, archived_at, visitor_type_id, company, host_name, phone, valid_until, notes';
// Used when migration 007 has not been applied. Naming a column that does not
// exist fails the whole query with a Postgres error, not a partial result, so
// the pending columns have to be dropped as a unit.
const SELECT_COLUMNS_NO_PENDING = SELECT_COLUMNS_FALLBACK;

function mapRow(row: any): ManagedUser {
  // Supabase returns a relation as an object for a many-to-one embed, but as an
  // array in some versions and query shapes. Normalise both so a missing or
  // oddly-shaped embed cannot throw here.
  const relation = Array.isArray(row.visitor_types)
    ? row.visitor_types[0]
    : row.visitor_types;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    // Absent on the fallback select (a database without migration 018), so
    // these read as blank rather than throwing.
    firstName: row.first_name ?? '',
    middleInitial: row.middle_initial ?? null,
    lastName: row.last_name ?? '',
    role: row.role as UserRole,
    createdAt: new Date(row.created_at),
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
    visitorType: relation?.label ?? null,
    company: row.company ?? null,
    hostName: row.host_name ?? null,
    phone: row.phone ?? null,
    validUntil: row.valid_until ? new Date(row.valid_until) : null,
    notes: row.notes ?? null,
    pendingRoomId: row.pending_room_id ?? null,
    pendingPurposeId: row.pending_purpose_id ?? null,
    courseId: row.course_id ?? null,
  };
}

/**
 * Posts JSON to the admin route with the caller's access token attached.
 *
 * The token is required: without it, RLS evaluates `auth.uid()` as NULL and the
 * admin check inside the route fails. Creating and archiving accounts also need
 * the service role key server-side, which is why they cannot be done from the
 * browser directly.
 */
async function adminRequest(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<{ ok: boolean; status: number; error?: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await res.json().catch(() => ({}));

  return {
    ok: res.ok,
    status: res.status,
    error: res.ok ? undefined : payload.error || `Request failed (${res.status})`,
  };
}

/**
 * Resolves a `visitor_types` id to its label using the list the rooms store
 * already fetched.
 *
 * `updateUser` mirrors the saved row into local state to avoid a refetch, but the
 * update payload carries only the id. Looking the label up here keeps the table
 * showing "VIP" rather than a UUID without a second network round trip. Returns
 * null if the list has not loaded, which is better than showing a raw id.
 */
function lookupVisitorTypeLabel(id: string): string | null {
  return useRoomsStore.getState().visitorTypes.find((t) => t.id === id)?.label ?? null;
}

export const useUsersStore = create<UsersState>()((set, get) => ({
  users: [],
  archivedUsers: [],
  isLoading: false,
  error: null,

  fetchUsers: async () => {
    set({ isLoading: true, error: null });

    // The admin row is excluded here, at the query rather than in the component.
    // There is exactly one admin (a partial unique index in migration 004), it
    // is neither created nor edited on this screen, and listing it alongside
    // visitors would only invite someone to try archiving the one account that
    // can delete the building's data. The signed-in admin still sees who they
    // are in the header, from the auth store.
    try {
      // Resolved to a plain `{ data, error }` shape so the fallback path can
      // stand in for the primary one without fighting the Postgrest response
      // union's `success: true | false` discriminant.
      const run = async (columns: string, active: boolean) => {
        let query = supabase
          .from('users')
          .select(columns)
          .neq('role', 'admin')
          .order('created_at', { ascending: false });

        query = active ? query.is('archived_at', null) : query.not('archived_at', 'is', null);

        const { data, error } = await query;
        return { data, error };
      };

      // Try the widest select first, then narrow it. Each failure means the
      // database predates a migration, so the next select drops back to columns
      // that are known to exist. The newer columns then read as null (see
      // mapRow) rather than the page showing nothing at all.
      //
      // Cascade rather than a single fallback: the embed, the 004 profile
      // columns and the 007 pending columns can fail independently (a missing
      // table gives PGRST205, a missing column gives 42703), so each step has to
      // drop one group at a time.
      //
      // NOTE: this previously referenced a `SELECT_COLUMNS_BASE` that was never
      // defined, so a database missing migration 004 threw a ReferenceError
      // instead of falling back.
      const attempts = [
        SELECT_COLUMNS_FULL,
        SELECT_COLUMNS_NO_PENDING,
        SELECT_COLUMNS_FALLBACK,
      ];

      let data: any[] | null = null;
      let usedColumns = SELECT_COLUMNS_FULL;
      let lastError: { message: string } | null = null;

      for (const columns of attempts) {
        const attempt = await run(columns, true);
        if (!attempt.error) {
          data = attempt.data;
          usedColumns = columns;
          break;
        }
        lastError = attempt.error;
      }

      if (data === null) {
        set({
          isLoading: false,
          error: lastError?.message ?? 'Failed to load users',
        });
        return;
      }

      // Archived rows use the same select that just worked, so a database
      // missing the 004 columns does not fail again on the second query.
      const archived = await run(usedColumns, false);

      // A failure to read the archived list is not fatal: the active list is
      // what the page is for, so surface it but do not block on it.
      if (archived.error) {
        console.warn('Could not load archived users:', archived.error.message);
      }

      set({
        users: (data ?? []).map(mapRow),
        archivedUsers: (archived.data ?? []).map(mapRow),
        isLoading: false,
      });
    } catch (err: any) {
      set({ isLoading: false, error: err?.message || 'Failed to load users' });
    }
  },

  // Creating an account needs a real auth.users row, which the anon key cannot
  // make. This goes through a server route using the service role key. Until
  // SUPABASE_SERVICE_ROLE_KEY is set, that route returns 501.
  createUser: async (input) => {
    set({ isLoading: true, error: null });

    try {
      const { ok, error } = await adminRequest('/api/admin/users', 'POST', input);

      if (!ok) {
        set({ isLoading: false, error: error || 'Failed to create user' });
        return { success: false, error: error || 'Failed to create user' };
      }

      // Refresh so the new row lands in the right sort position.
      await get().fetchUsers();
      set({ isLoading: false });
      return { success: true };
    } catch (err: any) {
      const message = err?.message || 'Failed to create user';
      set({ isLoading: false, error: message });
      return { success: false, error: message };
    }
  },

  // Goes through the server route rather than writing with the anon key: RLS
  // only permits updating your own row, so editing another user directly from
  // the browser would be rejected by the database.
  updateUser: async (id, updates) => {
    set({ isLoading: true, error: null });

    try {
      const { ok, error } = await adminRequest('/api/admin/users', 'PATCH', {
        id,
        ...updates,
      });

      if (!ok) {
        set({ isLoading: false, error: error || 'Failed to update user' });
        return { success: false, error: error || 'Failed to update user' };
      }

      // Keep local state in sync without a full refetch. Only the fields the
      // caller actually sent are mirrored back, so this cannot blank a column
      // that was left out of a partial update.
      set((state) => ({
        users: state.users.map((u) => {
          if (u.id !== id) return u;

          const next: ManagedUser = {
            ...u,
            // Recomposed, not echoed: the server writes `name` from the parts,
            // so mirroring the caller's `name` would drift from the database.
            name: composeFullName(
              updates.firstName,
              updates.middleInitial,
              updates.lastName
            ),
            email: updates.email,
            firstName: updates.firstName.trim(),
            middleInitial: normaliseMiddleInitial(updates.middleInitial),
            lastName: updates.lastName.trim(),
          };

          if (updates.visitorTypeId !== undefined) {
            // The label is not in the update payload, so look it up in the
            // visitor type list the caller already fetched rather than
            // refetching the user row just to resolve a display string.
            next.visitorType =
              updates.visitorTypeId === ''
                ? null
                : lookupVisitorTypeLabel(updates.visitorTypeId);
          }
          if (updates.company !== undefined) next.company = updates.company || null;
          if (updates.hostName !== undefined) next.hostName = updates.hostName || null;
          if (updates.phone !== undefined) next.phone = updates.phone || null;
          if (updates.notes !== undefined) next.notes = updates.notes || null;
          if (updates.validUntil !== undefined) {
            next.validUntil = updates.validUntil ? new Date(updates.validUntil) : null;
          }
          // Ids, not labels: the table resolves the display text from the rooms
          // and purposes lists, so mirroring the raw id is exactly right here.
          // Without these two lines the write reached the database but the list
          // kept rendering the PREVIOUS assignment until a full page reload.
          if (updates.pendingRoomId !== undefined) {
            next.pendingRoomId = updates.pendingRoomId || null;
          }
          if (updates.pendingPurposeId !== undefined) {
            next.pendingPurposeId = updates.pendingPurposeId || null;
          }

          return next;
        }),
        isLoading: false,
      }));

      return { success: true };
    } catch (err: any) {
      const message = err?.message || 'Failed to update user';
      set({ isLoading: false, error: message });
      return { success: false, error: message };
    }
  },

  // Archiving, not deleting. The new schema forbids deleting a user outright:
  // `users` is referenced by attendance with ON DELETE RESTRICT and no DELETE
  // policy is granted, so history would be destroyed (or the delete rejected).
  //
  // The server also bans the Supabase Auth login, so this is a real revocation
  // rather than a flag the app happens to check.
  archiveUser: async (id) => {
    set({ isLoading: true, error: null });

    try {
      const { ok, error } = await adminRequest(
        `/api/admin/users?id=${encodeURIComponent(id)}`,
        'DELETE'
      );

      if (!ok) {
        set({ isLoading: false, error: error || 'Failed to archive user' });
        return { success: false, error: error || 'Failed to archive user' };
      }

      // Move the row across rather than dropping it, so an archive can be
      // undone without a refetch.
      set((state) => {
        const moved = state.users.find((u) => u.id === id);
        if (!moved) return { isLoading: false };

        return {
          users: state.users.filter((u) => u.id !== id),
          archivedUsers: [
            { ...moved, archivedAt: new Date() },
            ...state.archivedUsers,
          ],
          isLoading: false,
        };
      });

      return { success: true };
    } catch (err: any) {
      const message = err?.message || 'Failed to archive user';
      set({ isLoading: false, error: message });
      return { success: false, error: message };
    }
  },

  // Undoes an archive, including lifting the Supabase Auth ban. Without the
  // server-side half of this the person would be restored in the table but
  // still unable to sign in.
  restoreUser: async (id) => {
    set({ isLoading: true, error: null });

    try {
      const { ok, error } = await adminRequest(
        `/api/admin/users?id=${encodeURIComponent(id)}&restore=1`,
        'DELETE'
      );

      if (!ok) {
        set({ isLoading: false, error: error || 'Failed to restore user' });
        return { success: false, error: error || 'Failed to restore user' };
      }

      set((state) => {
        const restored = state.archivedUsers.find((u) => u.id === id);
        if (!restored) return { isLoading: false };

        return {
          archivedUsers: state.archivedUsers.filter((u) => u.id !== id),
          users: [{ ...restored, archivedAt: null }, ...state.users],
          isLoading: false,
        };
      });

      return { success: true };
    } catch (err: any) {
      const message = err?.message || 'Failed to restore user';
      set({ isLoading: false, error: message });
      return { success: false, error: message };
    }
  },

  getUserCount: () => get().users.length,

  // Drives the "who is coming to the orientation" tally. Unclassified visitors
  // are grouped under "Unclassified" so the numbers always add up to the total
  // rather than silently under-counting.
  getCountByVisitorType: () => {
    const counts = new Map<string, number>();

    for (const user of get().users) {
      const label = user.visitorType ?? 'Unclassified';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  },

  getExpiredCount: () => {
    const now = new Date();
    return get().users.filter((u) => isPassExpired(u, now)).length;
  },
}));
