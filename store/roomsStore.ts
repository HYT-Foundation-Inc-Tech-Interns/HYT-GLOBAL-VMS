import { create } from 'zustand';
import { supabase } from '@/lib/supabase';

/**
 * Reference data: the rooms and purposes every other store reads.
 *
 * `rooms` is the single source of truth for what exists in the building. Nothing
 * else stores a room as free text - attendance and room visits both hold a
 * `room_id` and join back here for a name. That is why this store exists rather
 * than a hardcoded registry: rooms are created and retired through the admin UI,
 * and the scanner has to resolve a scanned code to a row without guessing.
 *
 * `purposes` lives here too because it is the same shape of lookup data and the
 * register/check-in forms need both lists at once.
 */

export interface Room {
  id: string;
  roomNumber: string;
  name: string;
  floor: string;
  building: string;
  /** Value encoded in this room's door QR code. Unique per room. */
  qrValue: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Purpose {
  id: string;
  label: string;
  isActive: boolean;
}

/**
 * A course a visitor can be enrolled in. Mirrors `purposes`/`visitor_types`:
 * a lookup table the register form and admin user modal read from, with a
 * fallback list so the picker still renders if the fetch fails.
 */
export interface Course {
  id: string;
  label: string;
  isActive: boolean;
  /**
   * FK to rooms.id (migration 20260101000018) - the room this course's visitors
   * are assigned to. Null/absent when the course is unmapped, in which case
   * there is simply no auto-assignment. `FALLBACK_COURSES` leaves it undefined.
   */
  roomId?: string | null;
}

/**
 * The purposes seeded by the migration, used as a fallback.
 *
 * The `purposes` table is readable only by signed-in users, but the
 * registration form needs the list before anyone signs in - so a brand-new
 * visitor would see an empty picker until the registration-fix migration
 * ("purposes readable by anyone") is applied. These labels are fixed by
 * `supabase/seed.sql`; once the fetch succeeds they are replaced by the real
 * rows, so the fallback is a safety net rather than a second source of truth.
 *
 * `id` is a readable placeholder, not a UUID: a purpose chosen from the
 * fallback is matched back to a real row by label before being written.
 */
export const FALLBACK_PURPOSES: Purpose[] = [
  'Interview',
  'Orientation',
  'Meeting',
  'Training',
  'Consultation',
  'Maintenance',
  'Delivery',
  'Other',
].map((label) => ({
  id: `fallback-${label.toLowerCase()}`,
  label,
  isActive: true,
}));

/**
 * How a visitor relates to the building: Trainee, Trainer, VIP, Contractor.
 *
 * Descriptive only - nothing here grants a permission. That separation is the
 * whole point: `role` says what someone may do (admin or visitor, two values),
 * while this says who they are, which is what varies at an orientation. Keeping
 * them apart is what let the trainer/trainee *roles* be removed without losing
 * the ability to record that a trainer attended.
 *
 * Readable by anyone, because the register form runs before sign-in.
 */
export interface VisitorType {
  id: string;
  label: string;
  /** Worth surfacing as a tile on the register form and the admin filter. */
  isPrimary: boolean;
  isActive: boolean;
}

/**
 * Used before `visitor_types` loads, and as the fallback when the table is
 * missing (i.e. migration 004 has not been applied yet).
 *
 * Mirrors the pattern used for `purposes`: a best-effort list so the picker
 * renders instead of appearing empty, replaced by real rows once fetched.
 */
export const FALLBACK_VISITOR_TYPES: VisitorType[] = [
  'Trainee',
  'Trainer',
  'VIP',
  'Guest',
  'Contractor',
  'Intern',
  'Observer',
].map((label) => ({
  id: `fallback-${label.toLowerCase()}`,
  label,
  isPrimary: ['Trainee', 'Trainer', 'VIP'].includes(label),
  isActive: true,
}));

/**
 * Used before `courses` loads, and as the fallback when the table is missing
 * (i.e. migration 20260101000011 has not been applied yet).
 *
 * Mirrors the pattern used for `purposes` and `visitor_types`.
 */
export const FALLBACK_COURSES: Course[] = [
  'Orientation',
  'Safety Training',
  'Leadership',
  'Technical Skills',
  'Onboarding',
].map((label) => ({
  id: `fallback-${label.toLowerCase()}`,
  label,
  isActive: true,
}));

interface RoomsState {
  rooms: Room[];
  purposes: Purpose[];
  visitorTypes: VisitorType[];
  courses: Course[];
  /**
   * In-flight guards, one per resource.
   *
   * These used to be a single shared `isLoading` flag, which made the fetches
   * block each other: whichever ran second saw the flag set and returned
   * without fetching. On /admin/users the effect calls fetchRooms() before
   * fetchPurposes(), so the purposes list was silently dropped and its picker
   * rendered empty while the room picker worked.
   */
  roomsLoading: boolean;
  purposesLoading: boolean;
  visitorTypesLoading: boolean;
  coursesLoading: boolean;
  /** Guards against refetching on every mount of every consumer. */
  hasFetched: boolean;

  fetchRooms: (force?: boolean) => Promise<void>;
  fetchPurposes: (force?: boolean) => Promise<void>;
  fetchVisitorTypes: (force?: boolean) => Promise<void>;
  fetchCourses: (force?: boolean) => Promise<void>;

  /** Active rooms in building order: ground floor, then floors ascending, then roof. */
  getActiveRooms: () => Room[];
  getAllRooms: () => Room[];
  getActivePurposes: () => Purpose[];
  getActiveVisitorTypes: () => VisitorType[];
  getActiveCourses: () => Course[];
  /** The handful of types worth showing as tiles, in label order. */
  getPrimaryVisitorTypes: () => VisitorType[];
  getRoomById: (id: string | null | undefined) => Room | undefined;
  getRoomByNumber: (roomNumber: string | null | undefined) => Room | undefined;
  /**
   * The room a course's visitors are assigned to (courses.room_id). Returns
   * undefined when the course is unknown, unmapped, or the room list has not
   * loaded - callers treat all three as "no auto-assignment".
   */
  getRoomForCourse: (courseId: string | null | undefined) => Room | undefined;
  /** Resolves a scanned door code back to its room. */
  getRoomByQr: (qrValue: string) => Room | undefined;
}

/**
 * Floor ordering. `rooms.floor` is TEXT, so a plain sort would put '10' before
 * '2' and 'Roof' before '3'. Ranked explicitly instead.
 */
const FLOOR_ORDER: Record<string, number> = { G: 0, '2': 1, '3': 2, '4': 3, Roof: 4 };

function compareRooms(a: Room, b: Room): number {
  const floorDelta =
    (FLOOR_ORDER[a.floor] ?? 99) - (FLOOR_ORDER[b.floor] ?? 99);
  if (floorDelta !== 0) return floorDelta;

  // Roofdeck has no number, so fall back to the display name rather than
  // letting '' sort to the front of the roof.
  const aKey = /\d/.test(a.roomNumber) ? a.roomNumber : a.name;
  const bKey = /\d/.test(b.roomNumber) ? b.roomNumber : b.name;
  return aKey.localeCompare(bKey, undefined, { numeric: true });
}

function mapRoom(row: any): Room {
  return {
    id: row.id,
    roomNumber: row.room_number,
    name: row.name,
    floor: row.floor,
    building: row.building,
    qrValue: row.qr_value,
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export const useRoomsStore = create<RoomsState>((set, get) => ({
  rooms: [],
  purposes: [],
  visitorTypes: [],
  courses: [],
  roomsLoading: false,
  purposesLoading: false,
  visitorTypesLoading: false,
  coursesLoading: false,
  hasFetched: false,

  fetchRooms: async (force = false) => {
    if (get().roomsLoading) return;
    if (!force && get().hasFetched) return;

    set({ roomsLoading: true });

    try {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .order('room_number');

      if (error) {
        console.error('Error fetching rooms:', error);
        set({ roomsLoading: false });
        return;
      }

      const rooms = (data ?? []).map(mapRoom).sort(compareRooms);
      set({ rooms, roomsLoading: false, hasFetched: true });
    } catch (error) {
      console.error('Error fetching rooms:', error);
      set({ roomsLoading: false });
    }
  },

  fetchPurposes: async (force = false) => {
    if (get().purposesLoading) return;
    // Only skip the fetch if real rows are already loaded. A previous fallback
    // must not block a retry, otherwise applying the fix migration would not
    // take effect until a hard reload.
    const hasRealRows = get().purposes.some((p) => !p.id.startsWith('fallback-'));
    if (!force && hasRealRows) return;

    set({ purposesLoading: true });

    try {
      const { data, error } = await supabase
        .from('purposes')
        .select('*')
        .order('label');

      if (error) {
        // Expected before the registration-fix migration is applied, and also
        // for anyone not yet signed in. Fall back to the seeded labels so the
        // pickers still render instead of silently appearing empty.
        console.warn(
          'Could not load purposes from the database; using the built-in list. ' +
            'Apply supabase/migrations/20260101000002_registration_fix.sql to fix this.',
          error
        );
        set({ purposes: FALLBACK_PURPOSES, purposesLoading: false });
        return;
      }

      set({
        purposes: (data ?? []).map((row: any) => ({
          id: row.id,
          label: row.label,
          isActive: row.is_active,
        })),
        purposesLoading: false,
      });
    } catch (error) {
      console.warn('Could not load purposes; using the built-in list.', error);
      set({ purposes: FALLBACK_PURPOSES, purposesLoading: false });
    }
  },

  fetchVisitorTypes: async (force = false) => {
    if (get().visitorTypesLoading) return;
    // Same rule as purposes: only a real row count blocks the refetch, so
    // applying migration 004 takes effect without a hard reload.
    const hasRealRows = get().visitorTypes.some(
      (t) => !t.id.startsWith('fallback-')
    );
    if (!force && hasRealRows) return;

    set({ visitorTypesLoading: true });

    try {
      const { data, error } = await supabase
        .from('visitor_types')
        .select('*')
        .order('label');

      if (error) {
        // Loud on purpose. The fallback list keeps the picker usable, but
        // nothing here warns that the real lookup is missing, so an admin
        // could classify visitors against a hardcoded list and never realise
        // migration 004 was never applied.
        console.error(
          'Could not load visitor_types from the database (' +
            error.message +
            '). Using the built-in list. Apply ' +
            'supabase/migrations/20260101000004_visitor_profiles.sql — until then ' +
            'visitor types are not persisted, and edits to type/company/host/' +
            'phone/expiry will fail to save.'
        );
        set({ visitorTypes: FALLBACK_VISITOR_TYPES, visitorTypesLoading: false });
        return;
      }

      set({
        visitorTypes: (data ?? []).map((row: any) => ({
          id: row.id,
          label: row.label,
          isPrimary: row.is_primary,
          isActive: row.is_active,
        })),
        visitorTypesLoading: false,
      });
    } catch (error) {
      console.warn('Could not load visitor types; using the built-in list.', error);
      set({ visitorTypes: FALLBACK_VISITOR_TYPES, visitorTypesLoading: false });
    }
  },

  fetchCourses: async (force = false) => {
    if (get().coursesLoading) return;
    // Same rule as purposes: only a real row count blocks the refetch, so
    // applying migration 20260101000011 takes effect without a hard reload.
    const hasRealRows = get().courses.some((c) => !c.id.startsWith('fallback-'));
    if (!force && hasRealRows) return;

    set({ coursesLoading: true });

    try {
      const { data, error } = await supabase
        .from('courses')
        .select('*')
        .order('label');

      if (error) {
        // Expected before migration 20260101000011 is applied, and also for
        // anyone not yet signed in. Fall back to the seeded labels so the
        // picker still renders instead of silently appearing empty.
        console.warn(
          'Could not load courses from the database; using the built-in list. ' +
            'Apply supabase/migrations/20260101000011_courses.sql to fix this.',
          error
        );
        set({ courses: FALLBACK_COURSES, coursesLoading: false });
        return;
      }

      set({
        courses: (data ?? []).map((row: any) => ({
          id: row.id,
          label: row.label,
          isActive: row.is_active,
          roomId: row.room_id ?? null,
        })),
        coursesLoading: false,
      });
    } catch (error) {
      console.warn('Could not load courses; using the built-in list.', error);
      set({ courses: FALLBACK_COURSES, coursesLoading: false });
    }
  },

  getActiveRooms: () => get().rooms.filter((r) => r.isActive),
  getAllRooms: () => get().rooms,
  getActivePurposes: () => get().purposes.filter((p) => p.isActive),

  getActiveVisitorTypes: () => get().visitorTypes.filter((t) => t.isActive),

  getActiveCourses: () => get().courses.filter((c) => c.isActive),

  getPrimaryVisitorTypes: () =>
    get()
      .visitorTypes.filter((t) => t.isActive && t.isPrimary)
      .sort((a, b) => a.label.localeCompare(b.label)),

  getRoomById: (id) => (id ? get().rooms.find((r) => r.id === id) : undefined),

  getRoomByNumber: (roomNumber) =>
    roomNumber
      ? get().rooms.find(
          (r) => r.roomNumber.toLowerCase() === roomNumber.toLowerCase()
        )
      : undefined,

  // Resolved through `rooms` at call time rather than snapshotted onto the
  // course, because `fetchCourses` and `fetchRooms` land independently and
  // whichever finished second would otherwise leave a stale room behind.
  getRoomForCourse: (courseId) => {
    if (!courseId) return undefined;
    const course = get().courses.find((c) => c.id === courseId);
    if (!course?.roomId) return undefined;
    return get().rooms.find((r) => r.id === course.roomId);
  },

  getRoomByQr: (qrValue) =>
    get().rooms.find(
      (r) => r.qrValue.toLowerCase() === qrValue.trim().toLowerCase()
    ),
}));