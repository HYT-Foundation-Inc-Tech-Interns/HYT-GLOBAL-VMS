/**
 * Public-facing URLs, for QR codes that get printed and scanned by a phone.
 *
 * Built from the browser's own origin at runtime rather than hardcoded. A QR
 * printed on a poster is physical: re-printing it to change a hostname is a
 * trip to the printer, and a stale hardcoded domain is worse than no QR at all
 * because it looks correct. Deriving it means the code is right on localhost,
 * on a preview deploy, and on production without anyone editing a constant.
 */

/**
 * Fallback when there is no browser (SSR) and no configured origin.
 *
 * Matches the value already documented in `.env.example`, so this file needs no
 * new environment variable to work.
 */
export const DEFAULT_SITE_ORIGIN = 'http://localhost:3000';

/**
 * The origin to build absolute URLs from.
 *
 * `NEXT_PUBLIC_APP_URL` WINS when set, which is the opposite of the usual
 * "prefer the live origin" instinct and deliberate here.
 *
 * The output of this function goes into a QR code that gets printed on a poster
 * and stuck to a wall. That artefact outlives the browser tab that created it,
 * and often outlives the deployment too. If the live origin won, an admin who
 * opened /station on a Vercel *preview* build would print a poster encoding
 * something like hyt-wayfinder-git-fix-qr.vercel.app - a URL that stops
 * resolving the moment the preview is replaced. The configured value is the one
 * guaranteed to point at the deployment you intend to keep.
 *
 * When it is unset - local dev, or a deployment that forgot to set it - the live
 * origin is used, which is correct for that environment even if not durable.
 */
export function siteOrigin(): string {
  const configured =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_APP_URL
      : undefined;
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return DEFAULT_SITE_ORIGIN;
}

/**
 * Absolute URL of the entrance verification page.
 *
 * `/verify`, not `/register`: scanning a poster should identify the visitor
 * first. A cohort member already on file gets their verdict immediately instead
 * of being sent through a second registration that would collide on their email
 * and create the duplicate account the flow is meant to prevent. Only somebody
 * with no record is forwarded on to `/register`.
 *
 * Not `/station` either - that is admin-only and redirects non-admins away.
 */
export function registrationUrl(): string {
  return `${siteOrigin()}/verify`;
}

/** Kept as an alias: several call sites and tests read better with this name. */
export const verificationUrl = registrationUrl;

// ---------------------------------------------------------------------------
// Orientation verdict lookup
// ---------------------------------------------------------------------------

/** The three states from migration 20260101000012. */
export type OrientationStatus = 'approved' | 'declined' | 'pending';

export interface OrientationRecord {
  orientation_status: OrientationStatus;
  full_name: string;
  programme: string | null;
}

/**
 * Looks up an orientation verdict by email.
 *
 * Returns null when the address is not in the cohort - which is the normal case
 * for a genuine walk-in and is NOT an error. Callers must not treat null as
 * "declined": a stranger registering for the first time is neither approved nor
 * declined, and the UI should say so rather than guess.
 *
 * Also returns null on any failure. This runs against an RLS-protected table via
 * a SECURITY DEFINER function (migration 20260101000013); if that migration has
 * not been applied yet the call rejects, and the registration form must still
 * work. A failed lookup degrades to "no verdict", never to a blocked sign-up.
 */
export async function fetchOrientationStatus(
  email: string,
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }
): Promise<OrientationRecord | null> {
  const trimmed = email.trim();
  // Cheap client-side guard. An address with no '@' is a typo, and calling the
  // function for it is a wasted round trip on every keystroke.
  if (!trimmed || !trimmed.includes('@')) return null;

  try {
    const { data, error } = await supabase.rpc('orientation_status_for', {
      p_email: trimmed,
    });
    if (error) return null;
    // PostgREST returns [] for a function matching no rows.
    const rows = Array.isArray(data) ? data : [];
    const row = rows[0] as OrientationRecord | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entrance verification
// ---------------------------------------------------------------------------

/**
 * Where the verify page sends an approved visitor once it has signed them in,
 * carrying a marker the check-in page reads to perform the automatic check-in
 * exactly once.
 *
 * WHY A MARKER AND NOT A SEPARATE ROUTE
 * -------------------------------------
 * /verify establishes the session (see `requestVerifyLogin`), but the check-in
 * INSERT is authorised by RLS as `auth.uid() = user_id` and the app's user
 * object is only populated once AuthGate runs `checkAuth` on the destination
 * page. So the automatic check-in happens on /check-in, not on /verify.
 *
 * The flag rides along in the query string so no extra route has to exist just
 * to carry a boolean. It is read and then stripped by
 * `useAutoCheckInAfterVerify`.
 *
 * This points at /check-in, not /successfully-registered. The confirmation page
 * still exists and is still where a fresh self-registration lands (see
 * app/register), but an approved verification now goes straight to the check-in
 * page, where the visitor is checked in automatically and can carry on to scan
 * room codes.
 */
export const VERIFIED_CHECKIN_PATH = '/check-in?verified=1';

export interface VerifyRecord {
  /**
   * `users.id` of the matched row, returned by migration 20260101000017.
   *
   * The server route needs it to provision a login and mint a session. It is
   * deliberately NOT forwarded to the browser - `shownRecord` in
   * app/api/verify/route.ts strips the response down to name, programme and
   * verdict.
   */
  id: string;
  orientation_status: OrientationStatus;
  full_name: string;
  programme: string | null;
  course_id: string | null;
  /**
   * Nullable since migration 20260101000014: a roster row with no address on
   * file has no email. The route still signs this person in - it derives a
   * synthetic login address from the profile id - so a missing address is no
   * longer a reason to turn anyone away.
   */
  email: string | null;
  /** False when there is no address on file. Informational only. */
  has_email: boolean;
  /**
   * Migration 20260101000015: approved, or already a signed-in account. Absent
   * on an un-migrated database, which is read as false (fail safe -> review).
   */
  recognized?: boolean;
}

/** What the verify page should do with a resolved record. */
export type VerifyDecision = 'declined' | 'review' | 'send-login-link';

/**
 * The single decision point between login / review / refusal.
 *
 * Order matters: declined (revoked) is checked first and can never be
 * overridden by `recognized`. Only a strictly-true `recognized` or an explicit
 * 'approved' verdict leads to login; anything missing or ambiguous falls to
 * review.
 *
 * An address on file is NOT required. Sign-in is minted server-side (see
 * /api/verify) and no email is ever sent, so a profile with no address is given
 * a synthetic login address derived from its id rather than being turned away.
 */
export function decideVerification(record: VerifyRecord): VerifyDecision {
  if (record.orientation_status === 'declined') return 'declined';
  const qualifies =
    record.orientation_status === 'approved' || record.recognized === true;
  if (!qualifies) return 'review';
  return 'send-login-link';
}

/**
 * Outcome of a verification attempt, deliberately richer than a boolean.
 *
 * `not-found` and `error` are kept apart on purpose. Conflating them would mean
 * telling somebody "we have no record of you" when the real problem was a dropped
 * connection, which sends a legitimate cohort member off to re-register and
 * creates exactly the duplicate account this flow is meant to avoid.
 */
export type VerifyOutcome =
  | { kind: 'found'; record: VerifyRecord }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; count: number }
  /**
   * `cause` carries the underlying failure (the RPC error or the thrown value)
   * for server-side logging. It is deliberately NOT surfaced to the visitor -
   * the `message` is the safe, human-facing text.
   */
  | { kind: 'error'; message: string; cause?: unknown };

/**
 * Resolves who somebody claims to be.
 *
 * IDENTIFICATION ONLY - this does not authenticate. See the header of migration
 * 20260101000013 for why name and course cannot stand in for a credential.
 *
 * Keyed on first + last name and course rather than email, because the visitor
 * picks a course from a list instead of typing an address. The database matches
 * the first and last WORD of the stored full name, so a visitor may omit their
 * middle name (see migration 20260101000017). The returned record still carries
 * the email, and that - never anything the caller supplied - is where the sign-in
 * goes. So a visitor cannot redirect their own sign-in by typing a different
 * address here.
 *
 * `ambiguous` is a distinct outcome on purpose. Courses hold many people and two
 * of them can share both a first and a last name, so more than one row is a real
 * possibility. Picking the first would show somebody a stranger's verdict AND
 * sign in as that stranger.
 */
export async function verifyVisitor(
  firstName: string,
  lastName: string,
  courseId: string,
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> }
): Promise<VerifyOutcome> {
  const trimmedFirst = firstName.trim();
  const trimmedLast = lastName.trim();

  if (!trimmedFirst || !trimmedLast) {
    return { kind: 'error', message: 'Enter your first and last name.' };
  }
  if (!courseId) {
    return { kind: 'error', message: 'Select your course.' };
  }

  try {
    const { data, error } = await supabase.rpc('verify_visitor', {
      p_first_name: trimmedFirst,
      p_last_name: trimmedLast,
      p_course_id: courseId,
    });
    if (error) {
      return {
        kind: 'error',
        message: 'Could not check your record. Try again in a moment.',
        cause: error,
      };
    }
    const rows = Array.isArray(data) ? (data as VerifyRecord[]) : [];
    if (rows.length === 0) return { kind: 'not-found' };
    if (rows.length > 1) return { kind: 'ambiguous', count: rows.length };
    return { kind: 'found', record: rows[0] };
  } catch (err) {
    return {
      kind: 'error',
      message: 'Could not reach the server. Check your connection and try again.',
      cause: err,
    };
  }
}

// ---------------------------------------------------------------------------
// Entrance verification -> immediate sign-in
// ---------------------------------------------------------------------------

/**
 * The slice of a matched record the visitor is allowed to see back.
 *
 * Deliberately not the whole `VerifyRecord`: the email on file is used by the
 * server to resolve the login and has no reason to travel to the browser.
 */
export interface VerifyLoginRecord {
  full_name: string;
  programme: string | null;
  orientation_status: OrientationStatus;
}

/**
 * What `POST /api/verify` answers with.
 *
 * `ok` carries a real Supabase session the page installs with `setSession` -
 * there is no email and no link. Every other branch is a verdict or a failure,
 * and none of them sign the visitor in.
 *
 * `unavailable` is kept apart from `error` on purpose: it means the deployment
 * has no service-role key configured (the route could not even attempt a
 * login), which is an operator problem, not a bad name.
 */
export type VerifyLoginResponse =
  | {
      kind: 'ok';
      accessToken: string;
      refreshToken: string;
      record: VerifyLoginRecord;
    }
  | { kind: 'declined'; record: VerifyLoginRecord }
  | { kind: 'review'; record: VerifyLoginRecord }
  | { kind: 'not-found' }
  | { kind: 'ambiguous' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

/**
 * Verifies a first + last name and a course, and when the record is approved,
 * signs the visitor in.
 *
 * Calls the server route rather than Supabase directly, because minting a
 * session needs the service-role key, which must never reach the browser. The
 * route re-runs the lookup itself: the verdict is decided server-side and never
 * trusted from here, so a tampered page cannot talk its way into a session.
 *
 * Always resolves - a network or parse failure becomes an `error` response, the
 * same way `verifyVisitor` degrades, so the page has one shape to handle.
 */
export async function requestVerifyLogin(
  firstName: string,
  lastName: string,
  courseId: string
): Promise<VerifyLoginResponse> {
  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        courseId,
      }),
    });
    const data = (await response.json()) as VerifyLoginResponse;
    if (!data || typeof data !== 'object' || !('kind' in data)) {
      return { kind: 'error', message: 'Unexpected response from the server.' };
    }
    return data;
  } catch {
    return {
      kind: 'error',
      message: 'Could not reach the server. Check your connection and try again.',
    };
  }
}