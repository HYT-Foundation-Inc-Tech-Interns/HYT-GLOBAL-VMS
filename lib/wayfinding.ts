/**
 * Wayfinding route registry.
 *
 * There are two kinds of QR code in this system, and they are deliberately
 * different things:
 *
 * 1. ATTENDANCE - exactly one code, printed at the ground floor station.
 *    Scanning it is the only way to clock in or out. It carries no room, so
 *    which route to draw comes from the person's assigned destination instead.
 *
 * 2. ROOM PRESENCE - one code per room, posted on that room's door. Scanning
 *    one only records that the person is inside that room right now. It never
 *    touches attendance, so a visitor cannot clock themselves out by scanning
 *    the wrong poster.
 *
 * Attendance codes are `HYT-KIOSK-<station>` and room codes are
 * `HYT-ROOM-<room>:<ROOM_ID>`. The prefixes are what `parseQrValue` keys off,
 * so the two can never be mistaken for one another.
 */

export interface RouteWaypoint {
  position: [number, number, number];
  label: string;
  stage: number;
  cameraOffset: [number, number, number];
}

export interface DestinationRoute {
  id: string;
  label: string;
  building: string;
  room: string;
  /** Encoded into the printed room-presence QR code for this room. */
  qrValue: string;
  waypoints: RouteWaypoint[];
}

/** Prefix for the ground floor attendance code. */
const ATTENDANCE_PREFIX = 'HYT-KIOSK-';

/**
 * Prefix for the per-room presence codes posted on room doors.
 *
 * The seeded `rooms.qr_value` values are authoritative, because that is what
 * actually gets printed on the doors: `HYT-ROOM-01:ROOM-304` - colon, not hyphen.
 * The trailing separator is therefore matched loosely (see `ROOM_PREFIX_RE`) so
 * codes printed under either convention still resolve.
 */
const ROOM_PREFIX = 'HYT-ROOM-01';

/**
 * Matches the room prefix followed by either a colon or a hyphen.
 *
 * Case-insensitive: a QR retyped by hand, or re-encoded by a different tool,
 * may not preserve case, and rejecting it as "not an HYT QR code" would be a
 * pointless failure. `normalise` already upper-cases for comparison; this just
 * lets the prefix itself be recognised regardless of case.
 */
const ROOM_PREFIX_RE = /^HYT-ROOM-01[:-]/i;

/**
 * The LEGACY room code format: `HYT-KIOSK-01-CHECKIN-STATION:ROOM-304`.
 *
 * Room codes used to be minted under the attendance prefix, with the room number
 * after it. Posters in that format are still on doors, and the value begins
 * `HYT-KIOSK-`, so a parser that only checked the prefix read a room poster as
 * ATTENDANCE - silently toggling the visitor's check-in/check-out instead of
 * recording the room.
 *
 * The suffix (`ROOM-304`, `ROOFDECK`) is what makes it unambiguously a room, so
 * it is captured and resolved to that room here, BEFORE the attendance branch.
 * A bare `HYT-KIOSK-CHECKIN-STATION` has no room suffix and does NOT match,
 * which is what keeps ordinary check-in/check-out working.
 */
const LEGACY_ROOM_CODE_RE = /^HYT-KIOSK-.*[:-](ROOM|ROOFDECK)[- ]?([0-9]+)?/i;

/** Single building. Kept as a constant so routes and the DB default agree. */
const BUILDING = 'HYT-Business Center';

/**
 * Builds the door code for a room number, e.g. `ROOM-304` ->
 * `HYT-ROOM-01:ROOM-304`. Shared with the admin rooms page so a room created
 * there gets exactly the code the scanner will recognise.
 *
 * Declared before DESTINATION_ROUTES, which uses it while building the registry.
 */
export const ROOM_PREFIX_FACTORY = (encodedRoomNumber: string): string =>
  `${ROOM_PREFIX}:${encodedRoomNumber}`;

/**
 * The single ground floor attendance code. Scanning this is the only thing that
 * clocks someone in or out.
 */
export const ATTENDANCE_QR_VALUE = `${ATTENDANCE_PREFIX}CHECKIN-STATION`;

/**
 * Building geometry, shared by the 3D scene and the route waypoints.
 *
 * The two MUST agree: `Building.tsx` draws these walls and `DESTINATION_ROUTES`
 * places its waypoints on this same grid, so a visitor following the route walks
 * through the walls rather than the corridors if they drift apart.
 *
 * Plan, per floor:
 *
 *            FRONT - four rooms
 *   +--------------------------------------+
 *   |  [ 301 ] [ 302 ] [ 303 ] [ 304 ]     |  z = -15..-3
 *   +--------------------------------------+
 *   |            H A L L W A Y             |  z = -3..3
 *   |              [stairs]                |  stairs at the centre, x = 0
 *   +--------------------------------------+
 *   |              [ 305 ]                 |  z = 3..15, one room at the back
 *   +--------------------------------------+
 *            x = -20..20
 *
 * The hallway runs left-to-right so that "front" and "back" are the two halves
 * either side of it. Stairs sit in the middle of it, which is both what the
 * institute described and where a real stairwell would be.
 *
 * There is no elevator. The building has stairs only.
 */
export const BUILDING_LAYOUT = {
  width: 40,
  depth: 30,
  wallHeight: 4,
  /** Floor-to-floor spacing. Must match `Building.tsx`'s `floorHeight`. */
  floorHeight: 4,
  /** Slab thickness, so routes stand ON the floor rather than inside it. */
  slabThickness: 0.3,
  /** The hallway runs this far either side of z = 0. */
  hallwayHalfDepth: 3,
  /** Centres of the four front rooms, left to right. */
  frontSlotsX: [-15, -5, 5, 15],
  /** Depth of the front and back room bands. */
  frontRoomZ: -9,
  backRoomZ: 9,
  /** The single back room is centred. */
  backSlotX: 0,
  /** Stairs sit at the centre of the hallway. */
  stairX: 0,
  stairZ: 0,
} as const;

/** The slab surface a visitor stands on for a given floor (1-based). */
export function floorLevelY(floor: number): number {
  // The roof is a slab above the top storey rather than another storey, so it
  // does not follow the (floor - 1) progression.
  if (floor >= 5) return 20.75;
  return (floor - 1) * BUILDING_LAYOUT.floorHeight + 0.35;
}

/**
 /** '2' -> '2nd'. Only 1st-4th exist today, but the rule is written out in full. */
function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : n % 10 === 1
        ? 'st'
        : n % 10 === 2
          ? 'nd'
          : n % 10 === 3
            ? 'rd'
            : 'th';
  return `${n}${suffix}`;
}

/**
 * Every room in the building, in building order.
 *
 * This mirrors the rooms seed in `supabase/setup.sql`: room numbers and floors
 * are authoritative,
 * display names are placeholders until the institute confirms them. The list is
 * duplicated here rather than read from the database because the 3D route scene
 * needs waypoints synchronously at module scope - it cannot await a fetch before
 * deciding what geometry to draw. Room *identity* still comes from the `rooms`
 * table at runtime (see `roomsStore`); this is only the geometry plus the
 * room_number each code encodes.
 */
export const DESTINATION_ROUTES: DestinationRoute[] = [
  { room: 'Room 201', label: 'Tech Room 201', floor: 2, index: 0 },
  { room: 'Room 202', label: 'Tech Room 202', floor: 2, index: 1 },

  { room: 'Room 301', label: 'Room 301', floor: 3, index: 0 },
  { room: 'Room 302', label: 'Room 302', floor: 3, index: 1 },
  { room: 'Room 303', label: 'Room 303', floor: 3, index: 2 },
  { room: 'Room 304', label: 'Room 304', floor: 3, index: 3 },

  { room: 'Room 401', label: 'Room 401', floor: 4, index: 0 },
  { room: 'Room 402', label: 'Room 402', floor: 4, index: 1 },
  { room: 'Room 403', label: 'Room 403', floor: 4, index: 2 },
  { room: 'Room 404', label: 'Room 404', floor: 4, index: 3 },

  { room: 'Roofdeck', label: 'Roofdeck', floor: 5, index: 0 },
].map(({ room, label, floor, index }) => {
  const L = BUILDING_LAYOUT;
  const y = floorLevelY(floor);

  // Rooms fill the four front slots first, then the single back slot. A floor
  // with fewer rooms than slots simply leaves the rest empty, which is the real
  // situation on floor 2 (two rooms) and on the roof (one).
  const isBackSlot = index >= L.frontSlotsX.length;
  const slotIndex = isBackSlot ? 0 : index;
  const x = isBackSlot ? L.backSlotX : L.frontSlotsX[slotIndex];
  const z = isBackSlot ? L.backRoomZ : L.frontRoomZ;

  const where = isBackSlot ? 'back of the floor' : 'front of the floor';

  return {
    id: room.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
    building: BUILDING,
    room,
    // Encodes the room number, so a printed code stays valid even if the
    // display name is later changed.
    qrValue: ROOM_PREFIX_FACTORY(
      room.toUpperCase().replace(/[^A-Z0-9]+/g, '-')
    ),
    waypoints: [
      { position: [0, 0.35, 0], label: 'Main Lobby', stage: 1, cameraOffset: [-3, 3, -3] },
      { position: [-8, 0.35, 0], label: 'Ground Floor Hallway', stage: 1, cameraOffset: [-2, 2, -2] },
      // Stairs, always. The building has no lift, so naming one here would send
      // someone looking for doors that do not exist.
      { position: [L.stairX, 0.35, L.stairZ], label: 'Main Staircase', stage: 2, cameraOffset: [-2, 2, -2] },
      { position: [L.stairX, y, L.stairZ], label: `${floor === 5 ? 'Roof' : ordinal(floor) + ' Floor'} Hallway`, stage: 2, cameraOffset: [-2, 2, -2] },
      { position: [x, y, z], label: `${label} (${where})`, stage: 3, cameraOffset: [-2, 2, -1] },
    ],
  } satisfies DestinationRoute;
});

export const DEFAULT_ROUTE_ID = DESTINATION_ROUTES[0].id;

export function getRoute(id: string | null | undefined): DestinationRoute {
  return DESTINATION_ROUTES.find((r) => r.id === id) ?? DESTINATION_ROUTES[0];
}

export function getRouteByRoom(room: string): DestinationRoute | undefined {
  return DESTINATION_ROUTES.find((r) => r.room === room);
}

/**
 * What a scanned QR code turned out to be.
 *
 * `attendance` is the ground floor code and the only thing that clocks someone
 * in or out. `room` is a door code and only records presence. `null` means the
 * code isn't one of ours.
 */
export type ParsedQr =
  | { kind: 'attendance' }
  | { kind: 'room'; roomNumber: string; routeId: string }
  | null;

/** Strips the punctuation so 'room 304' matches 'ROOM-304'. */
function normalise(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The part of a room code after the prefix, e.g. `ROOM-304`. */
function roomCodeValue(qrValue: string): string {
  return qrValue.slice(ROOM_PREFIX.length).replace(/^[:\-]/, '');
}

/**
 * Turns the encoded part of a room code into a display room number.
 *
 * `ROOM-405` -> `Room 405`, `ROOFDECK` -> `Roofdeck`. Returns null for
 * something that doesn't look like a room identifier, so the parser can
 * reject it rather than guessing.
 */
function encodedToRoomNumber(encoded: string): string | null {
  const upper = encoded.toUpperCase();
  if (upper === 'ROOFDECK') return 'Roofdeck';
  const digits = upper.match(/(\d+)/);
  return digits ? `Room ${digits[1]}` : null;
}

/**
 * Works out which of the two kinds of QR code was scanned.
 *
 * Room codes encode the room number (`HYT-ROOM-01:ROOM-304`), which is the
 * authoritative identifier - the display name is a placeholder that may change.
 *
 * Returns null for anything unrecognised rather than guessing, because the
 * difference between the two is what decides whether attendance is touched.
 */
export function parseQrValue(value: string): ParsedQr {
  const trimmed = value.trim();

  // Checked BEFORE the attendance branch. These values start with the attendance
  // prefix, so without this they would toggle check-in/out instead of recording
  // the room. The room suffix is what makes them unambiguously room posters.
  const legacy = trimmed.match(LEGACY_ROOM_CODE_RE);
  if (legacy) {
    const [, suffix, digits] = legacy;
    const roomNumber =
      suffix.toUpperCase() === 'ROOFDECK'
        ? 'Roofdeck'
        : digits
          ? `Room ${digits}`
          : null;
    // A room suffix we cannot turn into a room number is not ours to guess.
    if (!roomNumber) return null;

    const match = DESTINATION_ROUTES.find(
      (r) => normalise(r.room) === normalise(roomNumber)
    );
    // routeId is only a hint; the scanner resolves the room from the `rooms`
    // table by number, which is what covers rooms not in DESTINATION_ROUTES.
    return { kind: 'room', roomNumber, routeId: match?.id ?? DEFAULT_ROUTE_ID };
  }

  if (ROOM_PREFIX_RE.test(trimmed)) {
    const encoded = trimmed.slice(ROOM_PREFIX.length).replace(/^[:\-]/, '').trim();
    if (!encoded) return null;

    // Match on the encoded room number, so a code survives a display-name change.
    const match = DESTINATION_ROUTES.find(
      (r) => normalise(roomCodeValue(r.qrValue)) === normalise(encoded)
    );
    // A room code not in DESTINATION_ROUTES is still a valid room code: the
    // `rooms` table is the source of truth, and the admin can add rooms there
    // without also editing this geometry registry. Resolve the room number
    // from the code so the scanner can look it up by QR value or room number,
    // and fall back to the default route for the 3D scene.
    if (match) {
      return { kind: 'room', roomNumber: match.room, routeId: match.id };
    }
    const roomNumber = encodedToRoomNumber(encoded);
    return roomNumber
      ? { kind: 'room', roomNumber, routeId: DEFAULT_ROUTE_ID }
      : null;
  }

  // Case-insensitive, matching ROOM_PREFIX_RE. A lowercased kiosk code would
  // otherwise fall through to "not an HYT QR code" and confuse someone who had
  // done nothing wrong.
  if (trimmed.toUpperCase().startsWith(ATTENDANCE_PREFIX)) {
    return { kind: 'attendance' };
  }

  return null;
}

/**
 * The route to draw for someone who just clocked in.
 *
 * The ground floor code carries no room, so this resolves from the person's
 * assigned room instead, falling back to the default route when they have not
 * been assigned one. Matches on the room number first, then the display label,
 * so an admin who stored either form resolves correctly.
 */
export function routeIdForDestination(destination?: string | null): string {
  if (!destination) return DEFAULT_ROUTE_ID;
  const key = normalise(destination);
  const match =
    DESTINATION_ROUTES.find((r) => normalise(r.room) === key) ??
    DESTINATION_ROUTES.find((r) => normalise(r.label) === key) ??
    DESTINATION_ROUTES.find((r) => normalise(r.id) === key);
  return match?.id ?? DEFAULT_ROUTE_ID;
}