'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useClockInStore } from '@/store/clockInStore';
import { useRecordsStore } from '@/store/recordsStore';
import { useRoomsStore } from '@/store/roomsStore';
import { performVisitorCheckIn } from '@/lib/checkIn';

/** Query flag the verify page appends when it sends a signed-in visitor here. */
const VERIFIED_FLAG = 'verified';

const FAILED_MESSAGE =
  'We verified you, but could not check you in automatically. Scan the entrance QR code to check in.';

/**
 * Drops the marker from the URL so a refresh - or a repeat navigation - does not
 * repeat the attempt. The session is already established by the time this runs.
 */
function clearMarker(replace: (href: string) => void) {
  const url = new URL(window.location.href);
  url.searchParams.delete(VERIFIED_FLAG);
  replace(url.pathname + url.search);
}

/**
 * Automatically checks the visitor in when they arrive from /verify.
 *
 * WHY THIS RUNS ON /check-in, NOT ON /verify
 * ------------------------------------------
 * /verify establishes the session (via /api/verify + setSession), but the app's
 * user object is only populated once AuthGate runs `checkAuth`, and the check-in
 * INSERT is authorised by RLS as `auth.uid() = user_id`. So the write belongs on
 * /check-in, the first place the visitor is both known and authenticated.
 *
 * IDEMPOTENT
 * ----------
 * An existing open attendance record is adopted, never duplicated, and the
 * database additionally enforces one open row per user
 * (`clock_in_one_open_per_user`). Refreshing, or navigating back, is a no-op.
 *
 * FAILS LOUD, NEVER SILENT
 * ------------------------
 * A failed write leaves the visitor genuinely not checked in and surfaces the
 * error, with the normal manual scan still available - never a false
 * "checked in".
 */
export function useAutoCheckInAfterVerify() {
  const router = useRouter();
  const { user, isAuthenticated, authResolved } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    if (params.get(VERIFIED_FLAG) !== '1') return;

    // Wait for the session check to settle: on the first render
    // `isAuthenticated` is only whatever was persisted, not the real session.
    if (!authResolved) return;

    const dropMarker = () =>
      clearMarker((href) => router.replace(href, { scroll: false }));

    // The marker only means something for the visitor it was issued to. An
    // admin, or an arrival with no session, just drops it.
    if (!isAuthenticated || !user || user.role !== 'visitor') {
      handled.current = true;
      dropMarker();
      return;
    }

    handled.current = true;

    const run = async () => {
      try {
        // Ensure the assigned room and purpose can resolve before writing, so
        // the record is complete even on a cold arrival where the reference
        // data has not loaded yet. Courses are needed too: the room falls back
        // to the course mapping when the visitor has no explicit destination.
        // All three fetches are idempotent and cached.
        await useRoomsStore.getState().fetchRooms();
        await useRoomsStore.getState().fetchPurposes();
        await useRoomsStore.getState().fetchCourses();

        // Adopt an existing open visit rather than opening a second one.
        const existing = await useRecordsStore
          .getState()
          .fetchOpenRecord(user.id);
        if (existing) {
          useClockInStore.getState().syncFromServer(existing);
          dropMarker();
          return;
        }

        const result = await performVisitorCheckIn(user);

        if (!result.success) {
          // Do not pretend they are checked in. Log for diagnosis and surface
          // it; the manual scan remains available as the fallback.
          console.error(
            'Automatic check-in after verification failed:',
            result.error
          );
          setError(FAILED_MESSAGE);
          dropMarker();
          return;
        }

        dropMarker();
      } catch (err) {
        console.error('Automatic check-in after verification failed:', err);
        setError(FAILED_MESSAGE);
        dropMarker();
      }
    };

    run();
  }, [authResolved, isAuthenticated, user, router]);

  return { error };
}
