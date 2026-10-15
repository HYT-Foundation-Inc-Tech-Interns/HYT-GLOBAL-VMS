import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  decideVerification,
  verifyVisitor,
  type VerifyLoginRecord,
  type VerifyLoginResponse,
} from '@/lib/publicUrl';

// ============================================================================
// Entrance verification -> immediate sign-in.
//
// The QR poster at the front desk points at /verify. A visitor types their first
// and last name and picks their course; this route resolves that against the
// roster (matching the first and last word of the stored full name, so a middle
// name may be omitted) and, when the record is approved, hands back a real
// Supabase session so the app can log them straight in - NO email, NO link to
// click.
//
// WHY THIS IS A SERVER ROUTE
// --------------------------
// The check-in INSERT is authorised by RLS as `auth.uid() = user_id`, so a real
// session for the matched user must exist. A browser cannot mint one from name +
// course: that needs the service-role key, which must never reach the client.
//
// HOW THE SESSION IS MINTED
// -------------------------
// `admin.generateLink({ type: 'magiclink', email })` GENERATES a token - it does
// not send anything - and `auth.verifyOtp({ token_hash })` redeems it for a
// session. So the email machinery is used purely as a way to obtain a valid
// token; no message leaves the building.
//
// THE SERVER DECIDES, NEVER THE CLIENT
// ------------------------------------
// The lookup and the approve/decline/review decision are re-run here on every
// call. The client is only told the outcome; it can never assert "I am approved"
// and be believed.
//
// SECURITY TRADEOFF (deliberate, see the decision that requested this)
// -------------------------------------------------------------------
// Name + course are printed on the orientation roster, so anyone who knows a
// name and course can obtain that person's session, attendance record and room
// access. This route is the single choke point for that risk, and the place to
// add rate limiting, an audit trail, or a per-person secret later. It does not
// send email, so it cannot be used to spam an address.
// ============================================================================

const SERVICE_KEY_NOT_SET =
  'SUPABASE_SERVICE_ROLE_KEY is not configured, so /verify cannot sign visitors in.';

// Shown to the visitor, never the raw error. The cause is logged instead.
const SIGN_IN_FAILED =
  'We found your record, but could not sign you in. Please speak to the front desk.';

/**
 * Service-role client, the same pattern as /api/admin/users.
 *
 * Returns null when the key is absent so the caller can answer 501 rather than
 * throw. Server-only: the key must never be read anywhere the browser can see.
 */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Anon client, used ONLY for the `verify_visitor` lookup.
 *
 * The lookup is granted to `anon` / `authenticated` and deliberately NOT to
 * `service_role` (see migration 20260101000013, which revokes PUBLIC and grants
 * those two roles). Calling it with the service client therefore fails with
 * "permission denied for function verify_visitor". The service key is still what
 * mints the session below.
 */
function getAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return null;

  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Only what the visitor may see back; the email stays on the server. */
function shownRecord(record: {
  full_name: string;
  programme: string | null;
  orientation_status: VerifyLoginRecord['orientation_status'];
}): VerifyLoginRecord {
  return {
    full_name: record.full_name,
    programme: record.programme,
    orientation_status: record.orientation_status,
  };
}

/**
 * A deterministic, non-deliverable login address for a profile with no email.
 *
 * Nothing is ever sent to it - the token is redeemed server-side - so it only
 * has to be unique and stable, which the profile id guarantees. This is what
 * lets a roster member with no address on file still sign in.
 */
function syntheticEmailFor(id: string): string {
  return `noemail-${id}@visitor.hyt.local`;
}

/**
 * Creates the auth login for a profile that has none, under the SAME id.
 *
 * The imported orientation roster lives in `public.users` with no matching
 * `auth.users` row, so there is nothing to mint a session for. Creating the
 * login with `id = public.users.id` keeps the session's `auth.uid()` equal to
 * the profile id, which is what the check-in RLS policy requires
 * (`auth.uid() = user_id`) and what makes the check-in page resolve the person.
 *
 * Relies on the fixed `handle_new_user` trigger treating the already-present
 * profile row as a no-op (migration 20260101000016); without it the create
 * fails and the caller reports the failure rather than a false success.
 *
 * Returns true only when a login now exists (created, or already there).
 */
async function provisionLogin(
  service: NonNullable<ReturnType<typeof getServiceClient>>,
  profile: { id: string; email: string; name: string }
): Promise<boolean> {
  const { error } = await service.auth.admin.createUser({
    id: profile.id,
    email: profile.email,
    email_confirm: true,
    user_metadata: { name: profile.name },
  });

  if (error) {
    // "already registered" is a benign race (two taps); anything else is real.
    if (/already/i.test(error.message)) return true;
    console.error(
      `verify: could not provision a login for ${profile.email}:`,
      error
    );
    return false;
  }

  return true;
}

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { kind: 'error', message: 'Invalid request body.' } satisfies VerifyLoginResponse,
      { status: 400 }
    );
  }

  const firstName = typeof body?.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body?.lastName === 'string' ? body.lastName.trim() : '';
  const courseId = typeof body?.courseId === 'string' ? body.courseId : '';

  if (!firstName || !lastName || !courseId) {
    return NextResponse.json(
      {
        kind: 'error',
        message: 'Enter your first and last name, and select your course.',
      } satisfies VerifyLoginResponse,
      { status: 400 }
    );
  }

  const service = getServiceClient();
  if (!service) {
    console.error('verify: ' + SERVICE_KEY_NOT_SET);
    return NextResponse.json(
      {
        kind: 'unavailable',
        message: 'Visitor sign-in is not available right now. Please speak to the front desk.',
      } satisfies VerifyLoginResponse,
      { status: 501 }
    );
  }

  // The lookup runs as `anon` because `verify_visitor` is not granted to
  // `service_role` (see getAnonClient). The service key is still what mints the
  // session below.
  const anon = getAnonClient();
  if (!anon) {
    console.error('verify: Supabase anon key is not configured.');
    return NextResponse.json(
      {
        kind: 'unavailable',
        message: 'Visitor sign-in is not available right now. Please speak to the front desk.',
      } satisfies VerifyLoginResponse,
      { status: 501 }
    );
  }

  // The same lookup and decision the UI uses, run again here as the authority.
  const outcome = await verifyVisitor(firstName, lastName, courseId, anon);

  if (outcome.kind === 'not-found') {
    return NextResponse.json({ kind: 'not-found' } satisfies VerifyLoginResponse);
  }
  if (outcome.kind === 'ambiguous') {
    return NextResponse.json({ kind: 'ambiguous' } satisfies VerifyLoginResponse);
  }
  if (outcome.kind === 'error') {
    // Log the underlying cause (RPC error / thrown value) so a real failure is
    // diagnosable; the visitor still sees only the generic message.
    console.error('verify: lookup failed:', outcome.cause ?? outcome.message);
    return NextResponse.json(
      { kind: 'error', message: outcome.message } satisfies VerifyLoginResponse,
      { status: 502 }
    );
  }

  const record = outcome.record;
  const shown = shownRecord(record);
  const decision = decideVerification(record);

  // Declined and pending (review) stop here: neither signs the visitor in, and
  // neither is an error.
  if (decision === 'declined') {
    return NextResponse.json({ kind: 'declined', record: shown } satisfies VerifyLoginResponse);
  }
  if (decision === 'review') {
    return NextResponse.json({ kind: 'review', record: shown } satisfies VerifyLoginResponse);
  }

  // Approved / recognized. The lookup already returned the profile's id and the
  // address on file, so there is no second query to resolve them - the matched
  // row IS the profile.
  //
  // A profile with no address still gets a login: a synthetic, non-deliverable
  // address derived from its id. The token is redeemed server-side, so nothing
  // is ever sent to it.
  const email = record.email || syntheticEmailFor(record.id);

  // Ensure a login exists for THIS profile id BEFORE generating a token.
  //
  // This order matters. `generateLink` AUTO-CREATES a user when the address has
  // none - with a RANDOM id - which would sign the visitor in as the wrong
  // account (and, for a synthetic address, leave a stray profile behind). So the
  // user must already exist, created by us under the profile's id.
  const existing = await service.auth.admin.getUserById(record.id);
  if (!existing.data?.user) {
    const provisioned = await provisionLogin(service, {
      id: record.id,
      email,
      name: record.full_name,
    });
    if (!provisioned) {
      return NextResponse.json(
        { kind: 'error', message: SIGN_IN_FAILED } satisfies VerifyLoginResponse,
        { status: 500 }
      );
    }
  }

  // Generate a token (sends nothing), then redeem it for a session. The address
  // comes from the matched row (or its id), never from the caller, so the
  // session can only ever belong to the person found.
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });

  if (linkError || !link?.properties?.hashed_token) {
    // Log the address so the operator can repair the account; the visitor is
    // sent to the front desk rather than told they are not on the roster.
    console.error(
      `verify: could not generate a session token for ${email} (${record.full_name}):`,
      linkError
    );
    return NextResponse.json(
      { kind: 'error', message: SIGN_IN_FAILED } satisfies VerifyLoginResponse,
      { status: 500 }
    );
  }

  const { data: verified, error: verifyError } = await service.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });

  if (verifyError || !verified?.session) {
    console.error('verify: could not establish a session:', verifyError);
    return NextResponse.json(
      { kind: 'error', message: SIGN_IN_FAILED } satisfies VerifyLoginResponse,
      { status: 500 }
    );
  }

  // Minimal audit trail: who was admitted, and when. Server logs only - a full
  // audit table is a recommended follow-up, not part of this change.
  console.info(
    `verify: session issued for ${email} (${record.full_name}) at ${new Date().toISOString()}`
  );

  return NextResponse.json({
    kind: 'ok',
    accessToken: verified.session.access_token,
    refreshToken: verified.session.refresh_token,
    record: shown,
  } satisfies VerifyLoginResponse);
}
