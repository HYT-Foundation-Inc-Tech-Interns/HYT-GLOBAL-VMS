'use client';

import type { User } from '@/store/authStore';
import { useClockInStore } from '@/store/clockInStore';
import { useRecordsStore } from '@/store/recordsStore';
import { useRoomsStore } from '@/store/roomsStore';
import { getRoute, routeIdForDestination } from '@/lib/wayfinding';

export interface CheckInResult {
  success: boolean;
  error?: string;
  recordId?: string;
}

/**
 * The one visitor check-in action.
 *
 * Opening a visit is a single INSERT into `clock_in_records` (with `time_out`
 * left null) plus mirroring the result into the clock-in store so the scanner
 * and the route button see it. Both the manual scan (QRScanner) and the
 * automatic post-verification check-in go through here, so the two paths cannot
 * drift: same room, same purpose, same record shape.
 *
 * `room_id` and `purpose_id` are the visitor's assigned room and declared
 * purpose, resolved from the already-loaded reference stores. The room falls
 * back to the one mapped to the visitor's course when no explicit destination
 * is set, so an enrolled-but-unassigned visitor is still placed correctly. A
 * purpose that only exists in the built-in fallback list carries a non-UUID id,
 * so it is written as null rather than sent to a UUID column (which would fail
 * the whole insert and lose the check-in).
 *
 * The database enforces one open row per user (`clock_in_one_open_per_user`),
 * so a duplicate call cannot open a second visit. Callers should still check for
 * an existing open record first to keep the common path a cheap no-op.
 */
export async function performVisitorCheckIn(user: User): Promise<CheckInResult> {
  const { addRecord } = useRecordsStore.getState();
  const { clockIn, setActiveRoute } = useClockInStore.getState();
  const { getRoomByNumber, getActivePurposes, getRoomForCourse } =
    useRoomsStore.getState();

  // Precedence: an explicit destination (a manual choice, or users.pending_room_id
  // reduced to a room number) wins; otherwise fall back to the room mapped from
  // the visitor's course, so someone enrolled in a course but never assigned a
  // room still lands where their course meets.
  const assigned =
    getRoomByNumber(user.destination) ?? getRoomForCourse(user.courseId);

  // Draw the route to the visitor's assigned destination from the start, the
  // same as a manual check-in, so the "View 3D Route" button is reachable.
  setActiveRoute(
    getRoute(routeIdForDestination(assigned?.roomNumber ?? user.destination)).id
  );

  const purpose = getActivePurposes().find((p) => p.label === user.purpose);
  const purposeIdToWrite =
    purpose && !purpose.id.startsWith('fallback-') ? purpose.id : null;

  const result = await addRecord({
    userId: user.id,
    roomId: assigned?.id ?? null,
    purposeId: purposeIdToWrite,
    timeIn: new Date(),
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  clockIn(result.recordId);
  return { success: true, recordId: result.recordId };
}
