import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase } from '@/lib/supabase';
import { useRoomsStore } from '@/store/roomsStore';

/**
 * System permission level. Drives what a person may see and do.
 *
 * Only two levels exist, because only two behave differently: an admin runs the
 * building, everyone else is a visitor using the mobile check-in. The trainer and
 * trainee roles were removed - they were never granted anything by any RLS policy
 * and their portal was byte-identical to the visitor one.
 *
 * Note the `user_role` enum in Postgres still declares 'trainer' and 'trainee'.
 * They are retired but retained in the type, because Postgres cannot drop an enum
 * label and recreating the type would mean dropping and rebuilding a column on a
 * table that attendance history depends on. Nothing writes them any more; see
 * 20260101000003_retire_trainee_roles.sql, which normalises existing rows.
 */
export type UserRole = 'admin' | 'visitor';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /**
   * The room this person is assigned to, held pending.
   *
   * There is no destination column on `users` any more: the assigned room is
   * recorded per visit on `clock_in_records.room_id`. This value is applied to
   * the visitor's first attendance record when they check in (see QRScanner),
   * after which the database is the source of truth.
   */
  destination?: string;
  /**
   * Why this person is here, held pending.
   *
   * Like the assigned room, purpose is deliberately NOT on the user row: the
   * schema puts `purpose_id` on `clock_in_records` so it can change per visit
   * (a visitor attends a Meeting one day and an Orientation the next). This
   * value only seeds the visitor's first attendance record at check-in, after
   * which they pick a purpose per visit and the database is the source of truth.
   */
  purpose?: string;
  /**
   * Ids from `users.pending_room_id` / `pending_purpose_id` (migration 007).
   *
   * How an admin-created visitor's expectations reach the scanner. The register
   * path fills `destination`/`purpose` from the form; this path fills them from
   * the database instead. Either way `QRScanner` reads only `destination` and
   * `purpose`, so the two entry points converge in one place.
   *
   * Only the id is needed: the scanner resolves the room and the purpose label
   * from the `rooms` and `purposes` lists it already has loaded.
   */
  pendingRoomId?: string;
  pendingPurposeId?: string;
  /**
   * The course this visitor is enrolled in, from `users.course_id`.
   *
   * Persisted on the user row (unlike `destination`/`purpose`, which are
   * session-only) because a course is a stable attribute of the visitor, not
   * something that changes per visit.
   */
  courseId?: string;
  /**
   * Resolved label from `visitor_types` (e.g. "Trainee"), looked up from
   * `users.visitor_type_id`. Null when the visitor is unclassified.
   *
   * Carried on the session so the UserProfile badge can show the visitor's
   * classification without a second round trip. The raw id is never needed
   * client-side; only its label is displayed.
   */
  visitorType?: string | null;
  /**
   * ISO timestamp from `users.valid_until`. Null when the pass never expires.
   *
   * Carried on the session so the `/pass-expired` page can show *when* the
   * pass expired without a second round trip. The boolean `passExpired` on
   * the auth state is the source of truth for branching; this is for display.
   */
  validUntil?: string | null;
  qrCode?: string;
  createdAt: Date;
}

/**
 * Turns the pending columns on a `users` row into the fields `QRScanner` reads.
 *
 * `destination` is the room NUMBER rather than the id, because that is what
 * `getRoomByNumber` and `routeIdForDestination` resolve. `purpose` is the label,
 * because `QRScanner` matches the purpose chosen at the scanner by label.
 *
 * Both are resolved through `useRoomsStore.getState()` rather than passed in, so
 * every sign-in path can call this identically. When no pending room is set, the
 * room is derived from the visitor's course (`courses.room_id`), so someone
 * enrolled but never individually assigned still resolves to a room. Resolving
 * to nothing simply leaves the visitor with no assigned room or purpose - the
 * same as before migration 007, not an error.
 */
function pendingFromProfile(row: any): Partial<User> {
  const pendingRoomId: string | null = row.pending_room_id ?? null;
  const pendingPurposeId: string | null = row.pending_purpose_id ?? null;
  const courseId: string | null = row.course_id ?? null;

  if (!pendingRoomId && !pendingPurposeId && !courseId) return {};

  const { getAllRooms, getActivePurposes, getRoomForCourse } =
    useRoomsStore.getState();

  // An explicit pending room (set by an admin, or chosen at registration) wins.
  // Only when there is none do we fall back to the course's room.
  const room = pendingRoomId
    ? getAllRooms().find((r) => r.id === pendingRoomId)
    : getRoomForCourse(courseId);
  const purpose = pendingPurposeId
    ? getActivePurposes().find((p) => p.id === pendingPurposeId)
    : undefined;

  return {
    ...(room ? { destination: room.roomNumber } : {}),
    ...(purpose ? { purpose: purpose.label } : {}),
  };
}

/**
 * Resolves a `visitor_type_id` from a `users` row to its label.
 *
 * Same pattern as `pendingFromProfile`: a plain id is useless to the UI, so it
 * is turned into the human-readable label the `visitor_types` table holds.
 * `fetchVisitorTypes` is idempotent and cached, so callers in `login`/
 * `register`/`checkAuth` can invoke it before resolving. Returns `null` when
 * the id is absent or the lookup table has not loaded yet, in which case the
 * badge falls back to the neutral "visitor" style.
 */
function visitorTypeLabelFromId(
  id: string | null | undefined
): { visitorType: string | null } {
  if (!id) return { visitorType: null };
  const match = useRoomsStore
    .getState()
    .visitorTypes.find((t) => t.id === id);
  return { visitorType: match?.label ?? null };
}

/**
 * True when a visitor's pass has run out.
 *
 * Mirrors `isPassExpired` in usersStore - compared against the start of today,
 * not the current instant, so a pass set to expire "on the 10th" is still valid
 * for the whole of the 10th. Using the raw timestamp would lock someone out at
 * midnight on the night before the event they were registered for.
 *
 * A null `valid_until` means the pass never expires, which is the default for
 * everyone created before migration 004.
 */
function isPassExpired(validUntil: string | null | undefined): boolean {
  if (!validUntil) return false;
  const expiry = new Date(validUntil);
  if (Number.isNaN(expiry.getTime())) return false;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return expiry.getTime() < startOfToday.getTime();
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * True once `checkAuth` has finished at least once for this page load.
   *
   * Guards must wait for this before redirecting. `isAuthenticated` alone is
   * not enough: on the first render it is whatever was persisted (or the
   * default `false`), so a guard that redirects on it bounces a signed-in
   * person to /login before the real Supabase session has been read.
   */
  authResolved: boolean;

  /**
   * The visitor's pass has run out.
   *
   * Deliberately NOT the same as `isAuthenticated: false`. A pass expiring is a
   * per-visit business rule, not an authentication failure: the person is still a
   * real, valid account and must stay signed in. Treating expiry as a sign-out
   * threw every self-registered visitor back to /login the morning after they
   * registered, which looked exactly like the session had expired.
   *
   * The UI surfaces this so the day-pass rule is explained rather than silently
   * enforced.
   */
  passExpired: boolean;

  // Actions
  login: (
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: string }>;
  register: (data: {
    email: string;
    password: string;
    name: string;
    destination?: string;
    purpose?: string;
    // Visitor profile, self-declared at registration. The same columns the admin
    // form writes (migration 004); an admin can correct any of them later.
    visitorTypeId?: string;
    company?: string;
    phone?: string;
    /**
     * When this pass stops working, as an ISO timestamp.
     *
     * The register form sets this to the end of the registering day, so a
     * walk-in account cannot quietly stay valid for months. `isPassExpired`
     * compares against the START of today, so an end-of-today value is valid for
     * the whole day and expires the next morning. Admin-created users set their
     * own date instead; leaving it undefined means the pass never expires.
     */
    validUntil?: string;
    /**
     * Ids (rooms.id / purposes.id) of the chosen room and purpose, persisted as
     * pending intent by migration 007. Optional and only written when supplied,
     * so registering without a room leaves an existing assignment alone.
     */
    pendingRoomId?: string;
    pendingPurposeId?: string;
    /**
     * The course this visitor is enrolled in (courses.id). Persisted as
     * `users.course_id` by migration 20260101000011. Required by the register
     * form, but optional here so older callers don't break.
     */
    courseId?: string;
  }) => Promise<{
    success: boolean;
    error?: string;
    /**
     * True when the account was created but the address still needs confirming,
     * so there is no session yet. The caller should show this as a success state
     * and send the person to their inbox, not as a failure.
     */
    needsConfirmation?: boolean;
  }>;
  logout: () => Promise<void>;
  updateProfile: (updates: Partial<User>) => void;
  checkAuth: () => Promise<void>;
}

/**
 * Ensures a profile row exists for the signed-in user, creating it if missing.
 *
 * Accounts can end up orphaned: an auth login with no `users` row. That is
 * exactly what happened while the profile trigger was missing, and it leaves the
 * person unable to sign in at all - the login itself succeeds, then the profile
 * fetch comes back empty. Re-registering does not help either, because auth
 * answers "user already registered" for the address that already has a login.
 *
 * So this repairs it in place rather than making them start over. The insert is
 * permitted by the "users insert own row" policy, which only allows a row for
 * the caller's own id with role 'visitor', so this cannot be used to invent an
 * account or grant a role.
 *
 * Returns the profile row, or null if it could not be read or created.
 */
async function ensureProfile(authUser: {
  id: string;
  email?: string;
}): Promise<any | null> {
  const { data: existing, error: readError } = await supabase
    .from('users')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle();

  if (readError) {
    console.error('Could not read user profile:', readError);
    return null;
  }

  if (existing) return existing;

  // Missing profile: create it. Only name/email/id are set, so the role falls
  // back to the schema default of 'visitor'.
  const { data: created, error: createError } = await supabase
    .from('users')
    .insert({
      id: authUser.id,
      email: authUser.email ?? '',
      name: authUser.email?.split('@')[0] ?? 'User',
    })
    .select()
    .single();

  if (createError) {
    console.error('Could not create the missing user profile:', createError);
    return null;
  }

  return created;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      authResolved: false,
      passExpired: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true });

        try {
          // Sign in with Supabase Auth
          const { data: authData, error: authError } =
            await supabase.auth.signInWithPassword({
              email,
              password,
            });

          if (authError) {
            set({ isLoading: false });
            return { success: false, error: authError.message };
          }

          if (!authData.user) {
            set({ isLoading: false });
            return { success: false, error: 'No user data returned' };
          }

          // Read the profile, creating it if this account was orphaned by the missing
          // trigger. Without the repair step the login succeeds and then fails
          // with "Failed to fetch user profile", leaving them stuck.
          const userData = await ensureProfile(authData.user);

          if (!userData) {
            set({ isLoading: false });
            return {
              success: false,
              error:
                'Signed in, but your profile could not be loaded. Please contact an administrator.',
            };
          }

          // An archived account can still hold a valid auth session. Treat it as signed
          // out rather than letting a retired person keep checking in. The server also
          // bans the auth login on archive, so this is a second line of defence.
          if (userData.archived_at) {
            await supabase.auth.signOut();
            set({ user: null, isAuthenticated: false, isLoading: false });
            return {
              success: false,
              error: 'This account has been archived. Contact an administrator.',
            };
          }

          // An expired pass no longer refuses the login. Refusing here sent the person
          // to a dead end: the login page offers no renewal, and the only way
          // back in was to have an admin extend `valid_until`. They now sign in
          // normally and the visitor page explains that their pass has run out.
          // The account is still valid; only the day is over.

          // Resolve any pending room/purpose BEFORE building the user, so the
          // assigned room is present the first time the scanner reads it. The
          // room can also be derived from the visitor's course, so courses are
          // loaded here too - without them a course-derived room would silently
          // resolve to nothing. Every fetch is idempotent and caches, so this is
          // cheap on a repeat sign-in. Only needed when the row actually carries
          // one of the columns.
          if (
            userData.pending_room_id ||
            userData.pending_purpose_id ||
            userData.course_id
          ) {
            await useRoomsStore.getState().fetchRooms();
            await useRoomsStore.getState().fetchCourses();
            await useRoomsStore.getState().fetchPurposes();
          }

          // Load `visitor_types` so the UserProfile badge can show the
          // visitor's classification ("Trainee", "VIP", ...). Skipped when
          // the visitor has no classification, so a login without it does not
          // pay for the round trip.
          if (userData.visitor_type_id) {
            await useRoomsStore.getState().fetchVisitorTypes();
          }

          const user: User = {
            id: userData.id,
            email: userData.email,
            name: userData.name,
            role: userData.role as UserRole,
            ...pendingFromProfile(userData),
            ...(userData.course_id ? { courseId: userData.course_id } : {}),
            ...visitorTypeLabelFromId(userData.visitor_type_id),
            ...(userData.valid_until
              ? { validUntil: userData.valid_until }
              : {}),
            qrCode: `HYT-USER:${userData.id}`,
            createdAt: new Date(userData.created_at),
          };

          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            // Computed here rather than assumed false, so a returning visitor
            // with an expired day-pass still lands signed in with the reason shown.
            passExpired: isPassExpired(userData.valid_until),
          });
          return { success: true };
        } catch (error) {
          set({ isLoading: false });
          return { success: false, error: 'An unexpected error occurred' };
        }
      },

      register: async (data) => {
        set({ isLoading: true });

        try {
          // Sign up with Supabase Auth.
          //
          // No role is sent in the metadata, and none is accepted: the
          // handle_new_user trigger hardcodes 'visitor' and deliberately ignores
          // raw_user_meta_data, so a client-supplied role could never take effect
          // anyway. Sending one implied a privilege the visitor does not have.
          const { data: authData, error: authError } = await supabase.auth.signUp({
            email: data.email,
            password: data.password,
            options: {
              data: {
                name: data.name,
              },
            },
          });

          if (authError) {
            // A repeated signup for an address that already has an auth login. This is
            // not necessarily an error the person caused: earlier failures left
            // logins behind with no profile, and registration will always say
            // "already registered" for those. Signing in now repairs the
            // missing profile automatically, so send them there rather than
            // telling them they're stuck.
            const alreadyRegistered =
              /already registered|already been registered/i.test(authError.message);

            set({ isLoading: false });
            return {
              success: false,
              error: alreadyRegistered
                ? 'This email already has an account. Sign in with your password instead - if you have forgotten it, ask an administrator to reset it.'
                : authError.message,
            };
          }

          if (!authData.user) {
            set({ isLoading: false });
            return { success: false, error: 'No user data returned' };
          }

          // When email confirmation is enabled, Supabase creates the auth user
          // but returns NO session until the address is confirmed. Everything
          // below writes under RLS, and RLS evaluates auth.uid() as NULL without
          // a session - so the profile write would fail with "permission denied
          // for table users" however correct it is.
          //
          // The handle_new_user trigger has already created the profile row, so
          // there is nothing to do until they confirm. Say so plainly instead of
          // letting a confusing permission error surface.
          if (!authData.session) {
            set({ isLoading: false });
            return {
              success: false,
              needsConfirmation: true,
              error:
                'Almost done - check your email for a confirmation link, then sign in.',
            };
          }

          // Wait a moment for the auth user to be fully created
          await new Promise((resolve) => setTimeout(resolve, 500));

          // The database trigger (handle_new_user) already created this profile row,
          // so a plain INSERT would collide on the primary key. Upserting on id
          // is therefore the right call here.
          //
          // `role` is deliberately NOT written, on either path:
          //   - INSERT is checked by the self-insert policy, which only permits
          //     role = 'visitor' for your own id. Letting the client pick its
          //     own role would be a privilege escalation.
          //   - The conflict update is limited to name/email, so re-registering
          //     can never downgrade a role an admin granted.
          // Elevated roles are assigned through /admin/users.
          //
          // The visitor profile columns are written here but only from the
          // values the person actually filled in. Sending them unconditionally
          // would blank anything an admin had since filled in, because the
          // trigger-created row already exists and this is the update path.
          const { data: userData, error: userError } = await supabase
            .from('users')
            .upsert(
              {
                id: authData.user.id, // This links to auth.users(id)
                email: data.email,
                name: data.name,
                ...(data.visitorTypeId
                  ? { visitor_type_id: data.visitorTypeId }
                  : {}),
                ...(data.company ? { company: data.company } : {}),
                ...(data.phone ? { phone: data.phone } : {}),
                // Only written when supplied, so re-registering an account an admin
                // had already given a long pass does not silently shorten it back to
                // today. The register form always supplies one.
                ...(data.validUntil ? { valid_until: data.validUntil } : {}),
                // Persist the chosen room and purpose as pending intent (migration
                // 007), the same columns the admin form writes. The register path
                // also keeps them in the session, but persisting means the choice
                // survives a sign-out and still applies at the next check-in.
                ...(data.pendingRoomId ? { pending_room_id: data.pendingRoomId } : {}),
                ...(data.pendingPurposeId
                  ? { pending_purpose_id: data.pendingPurposeId }
                  : {}),
                ...(data.courseId ? { course_id: data.courseId } : {}),
              },
              { onConflict: 'id' }
            )
            .select()
            .single();

          if (userError) {
            console.error('Profile creation error:', userError);

            // Roll back the auth user so registration doesn't leave an
            // account that can sign in but has no profile.
            //
            // The anon key cannot call auth.admin.*, so this best-effort
            // call usually fails during self-registration. That is why the
            // upsert above matters: with the trigger in place the profile
            // write succeeds, so we rarely reach this path at all.
            await supabase.auth.admin
              .deleteUser(authData.user.id)
              .catch(() => supabase.auth.signOut());

            // No profile cleanup here on purpose. `users.id` references
            // `auth.users(id) ON DELETE CASCADE`, so deleting the auth user above
            // already removes the orphaned profile. The previous explicit
            // DELETE could never have worked anyway: the new schema grants no
            // DELETE policy on `users`, precisely so attendance history cannot be
            // destroyed through the API.

            set({ isLoading: false });
            return {
              success: false,
              error: `Failed to create user profile: ${userError.message}`,
            };
          }

          if (!userData) {
            set({ isLoading: false });
            return { success: false, error: 'No profile data returned' };
          }

          // Load `visitor_types` so the badge on the new session shows the
          // classification the person just chose. Only when they picked one.
          if (userData.visitor_type_id) {
            await useRoomsStore.getState().fetchVisitorTypes();
          }

          const user: User = {
            id: userData.id,
            email: userData.email,
            name: userData.name,
            role: userData.role as UserRole,
            // The assigned room was chosen moments ago and is not in the
            // database, so it is carried in the (persisted) session. The room is
            // applied to this user's first attendance record at check-in.
            ...(data.destination ? { destination: data.destination } : {}),
            ...(data.purpose ? { purpose: data.purpose } : {}),
            ...(userData.course_id ? { courseId: userData.course_id } : {}),
            ...visitorTypeLabelFromId(userData.visitor_type_id),
            ...(userData.valid_until
              ? { validUntil: userData.valid_until }
              : {}),
            qrCode: `HYT-USER:${userData.id}`,
            createdAt: new Date(userData.created_at),
          };

          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            // Computed here rather than assumed false, so a returning visitor
            // with an expired day-pass still lands signed in with the reason shown.
            passExpired: isPassExpired(userData.valid_until),
          });
          return { success: true };
        } catch (error: any) {
          console.error('Registration error:', error);
          set({ isLoading: false });
          return {
            success: false,
            error: error?.message || 'An unexpected error occurred during registration',
          };
        }
      },

      logout: async () => {
        await supabase.auth.signOut();
        set({ user: null, isAuthenticated: false });
      },

      updateProfile: (updates) => {
        const currentUser = get().user;
        if (currentUser) {
          set({ user: { ...currentUser, ...updates } });
        }
      },

      checkAuth: async () => {
        set({ isLoading: true });

        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();

          if (!session) {
            set({
              user: null,
              isAuthenticated: false,
              isLoading: false,
              authResolved: true,
            });
            return;
          }

          // Same repair as on login: a session can outlive a missing profile row.
          const userData = await ensureProfile(session.user);

          if (!userData) {
            // The session is real, but the profile could not be read. This used
            // to sign the person out, which turned a transient read failure into
            // a forced re-login. Keep the identity already persisted (if any)
            // and mark the check resolved; the next load repairs the profile.
            const persisted = get().user;
            set({
              user: persisted,
              isAuthenticated: !!persisted,
              isLoading: false,
              authResolved: true,
            });
            return;
          }

          // An ARCHIVED account is genuinely retired: revoke the Supabase login so the
          // credentials stop working even if they are still remembered.
          if (userData.archived_at) {
            await supabase.auth.signOut();
            set({
              user: null,
              isAuthenticated: false,
              isLoading: false,
              authResolved: true,
            });
            return;
          }

          // An EXPIRED pass is a business rule, not an authentication failure, so
          // the session is deliberately left intact.
          //
          // This used to `signOut()` here, which meant that with the one-day
          // pass added in migration 006, every self-registered visitor was thrown
          // back to /login the morning after registering - indistinguishable from
          // the session having expired. They were still a valid account; their
          // day simply ended. Signing them out also destroyed the only way back
          // in, since the login page offers no renewal.
          //
          // The pass being expired is surfaced on the visitor pages instead, and
          // an admin can extend `valid_until` to let them in again without the
          // person having to re-register.

          // Resolve any pending room/purpose BEFORE building the user, so the
          // assigned room is present the first time the scanner reads it. The
          // room can also be derived from the visitor's course, so courses are
          // loaded here too - without them a course-derived room would silently
          // resolve to nothing. Every fetch is idempotent and caches, so this is
          // cheap on a repeat sign-in. Only needed when the row actually carries
          // one of the columns.
          if (
            userData.pending_room_id ||
            userData.pending_purpose_id ||
            userData.course_id
          ) {
            await useRoomsStore.getState().fetchRooms();
            await useRoomsStore.getState().fetchCourses();
            await useRoomsStore.getState().fetchPurposes();
          }

          // Resolve the visitor's classification so the UserProfile badge
          // shows it on a cold reload. Same lazy-load rule as above.
          if (userData.visitor_type_id) {
            await useRoomsStore.getState().fetchVisitorTypes();
          }

          const user: User = {
            id: userData.id,
            email: userData.email,
            name: userData.name,
            role: userData.role as UserRole,
            ...pendingFromProfile(userData),
            ...(userData.course_id ? { courseId: userData.course_id } : {}),
            ...visitorTypeLabelFromId(userData.visitor_type_id),
            ...(userData.valid_until
              ? { validUntil: userData.valid_until }
              : {}),
            qrCode: `HYT-USER:${userData.id}`,
            createdAt: new Date(userData.created_at),
          };

          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            authResolved: true,
            passExpired: isPassExpired(userData.valid_until),
          });
        } catch (error) {
          // A thrown error (a network drop mid-check) must not wipe a session
          // that is otherwise intact, or the person is logged out by a hiccup.
          // Keep the persisted identity and resolve the check.
          const persisted = get().user;
          set({
            user: persisted,
            isAuthenticated: !!persisted,
            isLoading: false,
            authResolved: true,
          });
        }
      },
    }),
    {
      name: 'hyt-auth-storage',
      // Only the identity is persisted. `isLoading` and `authResolved` are
      // per-page-load flags: persisting `isLoading` meant a reload could restore
      // it as `true` and wedge every guard behind a spinner, and persisting
      // `authResolved` would let a reload skip the session check entirely.
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
