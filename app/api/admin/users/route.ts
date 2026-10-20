import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { composeFullName, normaliseMiddleInitial } from '@/lib/fullName';

// Create/update/archive a user account.
//
// Creating a real login requires an auth.users row, which the anon key cannot
// make. Updating *another* user's profile also needs the service role key: RLS
// grants "users update own row" only, so an admin editing someone else through
// the anon key would be silently rejected by the database.
//
// Until SUPABASE_SERVICE_ROLE_KEY is configured, create/archive return 501 and
// the UI disables those actions.

// Note: role is no longer settable through this route. `admin` is a singleton
// that is not creatable or editable here (see the partial unique index in
// 20260101000004_visitor_profiles.sql), and the trainer/trainee labels are
// retired - see 20260101000003_retire_trainee_roles.sql.

const SERVICE_KEY_NOT_SET =
  'User creation/archiving needs SUPABASE_SERVICE_ROLE_KEY. Add it to .env.local to enable.';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) return null;

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Confirms the caller is an authenticated admin, using the caller's own
// access token so RLS applies and the service key never leaks upward.
async function requireAdmin(
  request: Request
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Not authenticated' };
  }

  const token = authHeader.slice(7);
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!anonUrl || !anonKey) {
    return { ok: false, status: 500, error: 'Supabase is not configured' };
  }

  // Verify the token and read the caller's role.
  // The caller's access token must be attached to every request, otherwise
  // RLS evaluates auth.uid() as NULL and the profile lookup returns nothing.
  const callerClient = createClient(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData.user) {
    return { ok: false, status: 401, error: 'Invalid or expired session' };
  }

  const { data: profile, error: profileError } = await callerClient
    .from('users')
    .select('role')
    .eq('id', userData.user.id)
    .single();

  // Distinguish "profile unreadable" from "genuinely not an admin", so a
  // missing profile or blocked read doesn't look like a permissions problem.
  if (profileError || !profile) {
    return {
      ok: false,
      status: 403,
      error:
        'Could not read your user profile. The database setup may not have ' +
        'been applied yet (see supabase/setup.sql).',
    };
  }

  if (profile.role !== 'admin') {
    return {
      ok: false,
      status: 403,
      error: `Admin access required. Your role is "${profile.role}".`,
    };
  }

  return { ok: true, userId: userData.user.id };
}

export async function POST(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin.ok) {
    return NextResponse.json({ error: admin.error }, { status: admin.status });
  }

  const service = getServiceClient();
  if (!service) {
    return NextResponse.json({ error: SERVICE_KEY_NOT_SET }, { status: 501 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    email,
    firstName,
    middleInitial,
    lastName,
    password,
    visitorTypeId,
    courseId,
    company,
    hostName,
    phone,
    validUntil,
    notes,
    pendingRoomId,
    pendingPurposeId,
  } = body ?? {};

  if (
    typeof email !== 'string' ||
    !email.trim() ||
    typeof firstName !== 'string' ||
    !firstName.trim() ||
    typeof lastName !== 'string' ||
    !lastName.trim() ||
    !password
  ) {
    return NextResponse.json(
      { error: 'email, firstName, lastName and password are all required' },
      { status: 400 }
    );
  }

  // Composed here, never taken from the client, so the display name and the
  // three columns written below can never disagree.
  const name = composeFullName(firstName, middleInitial, lastName);

  if (typeof password !== 'string' || password.length < 6) {
    return NextResponse.json(
      { error: 'Password must be at least 6 characters' },
      { status: 400 }
    );
  }

  // Every account created here is a visitor, always. The admin is a singleton
  // that is not creatable or editable through this route (enforced by the
  // `users_single_admin_idx` partial unique index), so accepting a `role` from
  // the client would only ever be a way to fail confusingly.
  const role = 'visitor';

  // 1. Create the login. email_confirm skips the verification email step,
  //    which suits an admin provisioning accounts by hand.
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name, role },
  });

  if (createError || !created?.user) {
    return NextResponse.json(
      { error: createError?.message || 'Could not create the login' },
      { status: 400 }
    );
  }

  // 2. Make sure the profile row matches what was requested.
  //
  // This project has a database trigger that inserts a public.users row as
  // soon as the auth user exists, so a plain INSERT here collides on the
  // primary key ("duplicate key value violates unique constraint
  // users_pkey"). Upserting on id makes this correct whether or not the
  // trigger is present, and still applies the chosen name and role.
  const { error: profileError } = await service.from('users').upsert(
    {
      id: created.user.id,
      email: email.trim().toLowerCase(),
      name,
      // The parts the entrance check matches on.
      first_name: firstName.trim(),
      middle_initial: normaliseMiddleInitial(middleInitial),
      last_name: lastName.trim(),
      role,
      visitor_type_id: visitorTypeId || null,
      // A visitor is enrolled in exactly one course, so this is persisted
      // rather than left to a later edit. It was previously accepted by the
      // admin form and then dropped here, which left every new account with a
      // null course_id and an empty picker on the edit modal.
      course_id: courseId || null,
      company: company?.trim() || null,
      host_name: hostName?.trim() || null,
      phone: phone?.trim() || null,
      notes: notes?.trim() || null,
      valid_until: validUntil ? new Date(validUntil).toISOString() : null,
      // Seeds the visitor's first attendance record at check-in. The real room
      // and purpose are written per visit on clock_in_records; these are only
      // the expectation until then. Empty means "not assigned", not "no room".
      pending_room_id: pendingRoomId || null,
      pending_purpose_id: pendingPurposeId || null,
    },
    { onConflict: 'id' }
  );

  if (profileError) {
    // Don't leave a half-created account behind.
    await service.auth.admin.deleteUser(created.user.id).catch(() => {});
    return NextResponse.json(
      { error: `Could not save the profile: ${profileError.message}` },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id: created.user.id }, { status: 201 });
}

/**
 * Edit another user's profile.
 *
 * Routed through the service key on purpose. RLS only permits updating your own
 * row (`USING (auth.uid() = id)`), so an admin editing someone else over the anon
 * key is rejected by the database no matter what the UI believes.
 *
 * Email is written to BOTH auth.users and public.users, in that order, and the
 * profile write is rolled back if the auth write fails. See the comment at the
 * auth call below for why the order matters.
 */
export async function PATCH(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin.ok) {
    return NextResponse.json({ error: admin.error }, { status: admin.status });
  }

  const service = getServiceClient();
  if (!service) {
    return NextResponse.json({ error: SERVICE_KEY_NOT_SET }, { status: 501 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    id,
    firstName,
    middleInitial,
    lastName,
    email,
    visitorTypeId,
    company,
    hostName,
    phone,
    validUntil,
    notes,
    pendingRoomId,
    pendingPurposeId,
  } = body ?? {};

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'A user id is required' }, { status: 400 });
  }

  if (
    typeof firstName !== 'string' ||
    !firstName.trim() ||
    typeof lastName !== 'string' ||
    !lastName.trim()
  ) {
    return NextResponse.json(
      { error: 'First name and last name are required' },
      { status: 400 }
    );
  }

  if (typeof email !== 'string' || !email.trim()) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  const nextEmail = email.trim().toLowerCase();

  // Build the profile patch from only the keys the caller actually sent, so a
  // partial update (the role field is no longer editable here) cannot blank a
  // column by omission.
  const patch: Record<string, unknown> = {
    // Composed from the parts, so the display name cannot drift from them.
    name: composeFullName(firstName, middleInitial, lastName),
    first_name: firstName.trim(),
    middle_initial: normaliseMiddleInitial(middleInitial),
    last_name: lastName.trim(),
    email: nextEmail,
  };

  if (visitorTypeId !== undefined) {
    patch.visitor_type_id = visitorTypeId || null;
  }
  if (company !== undefined) patch.company = company?.trim() || null;
  if (hostName !== undefined) patch.host_name = hostName?.trim() || null;
  if (phone !== undefined) patch.phone = phone?.trim() || null;
  if (notes !== undefined) patch.notes = notes?.trim() || null;
  if (validUntil !== undefined) {
    // Empty string means "no expiry". Anything else must be a real date, or it
    // would be written as an invalid timestamp and fail at the column.
    patch.valid_until = validUntil ? new Date(validUntil).toISOString() : null;
  }
  if (pendingRoomId !== undefined) {
    patch.pending_room_id = pendingRoomId || null;
  }
  if (pendingPurposeId !== undefined) {
    patch.pending_purpose_id = pendingPurposeId || null;
  }

  // 1. Update the auth login FIRST.
  //
  //    `public.users.email` is a copy of `auth.users.email`, and the old code
  //    only ever wrote the copy. That silently broke the account: the person
  //    kept signing in with the old address (which is the one Auth knows) while
  //    the admin saw the new one on the profile, and a re-registration attempt
  //    with the new address was rejected as "already registered".
  //
  //    Auth is updated first because it is the stricter gate - it rejects
  //    duplicate addresses - so failing here means nothing has been written yet
  //    and there is nothing to undo.
  //
  //    The previous address is read up front purely so a failed profile write
  //    can be rolled back to it. Without that, "roll back" would write the new
  //    address again and change nothing.
  const { data: existing, error: readError } = await service
    .from('users')
    .select('email')
    .eq('id', id)
    .maybeSingle();

  if (readError || !existing) {
    return NextResponse.json(
      { error: 'Could not read that user. They may have been removed.' },
      { status: 404 }
    );
  }

  // Nullable since migration 20260101000014: a cohort member with no address on
  // file has NULL here. It is only read to roll back a failed profile write, and
  // this branch has already succeeded in setting a real address on the auth
  // row - so a NULL previous value means there is nothing to put back, not that
  // the rollback is impossible.
  const previousEmail = (existing.email as string | null) ?? null;

  const { error: authError } = await service.auth.admin.updateUserById(id, {
    email: nextEmail,
    // Confirmed, because an admin editing an address is not an invitation and
    // should not trigger a verification email the person may never see.
    email_confirm: true,
  });

  if (authError) {
    return NextResponse.json(
      {
        error:
          authError.message.includes('already') ||
          authError.message.includes('registered')
            ? 'That email address is already used by another account.'
            : authError.message,
      },
      { status: 400 }
    );
  }

  // 2. Then the profile. If this fails the auth address has already moved, so
  //    put it back rather than leaving the two disagreeing.
  const { error } = await service.from('users').update(patch).eq('id', id);

  if (error) {
    // There was no address to restore (nullable since 20260101000014), so the
    // rollback is a no-op rather than a failure. Reporting it as one would send
    // the admin chasing a split state that does not exist.
    if (previousEmail === null) {
      return NextResponse.json(
        {
          error: `Could not save the profile: ${error.message}. This account had no email address before, so there was no sign-in address to roll back.`,
        },
        { status: 400 }
      );
    }

    // Best effort. If the rollback also fails the admin needs to know the
    // account is in a split state, so the original error is not swallowed.
    const { error: rollbackError } = await service.auth.admin.updateUserById(id, {
      email: previousEmail,
      email_confirm: true,
    });

    return NextResponse.json(
      {
        error: rollbackError
          ? `Could not save the profile (${error.message}), and the login email could not be rolled back either (${rollbackError.message}). Please set this user's email directly in Supabase Auth.`
          : `Could not save the profile: ${error.message}. The login email was left unchanged.`,
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true });
}

/**
 * Archive a user rather than deleting them.
 *
 * Attendance history must survive someone leaving, so the schema has no DELETE
 * path at all: `users` is referenced by `clock_in_records` and `room_visits`
 * with ON DELETE RESTRICT, and no DELETE policy is granted. Setting
 * `archived_at` retires the account while keeping every visit row intact.
 *
 * This is a reversible "archive", not a permanent ban. Pass `?restore=1` to
 * bring the account back, which also lifts the Supabase Auth ban.
 */
export async function DELETE(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin.ok) {
    return NextResponse.json({ error: admin.error }, { status: admin.status });
  }

  const service = getServiceClient();
  if (!service) {
    return NextResponse.json({ error: SERVICE_KEY_NOT_SET }, { status: 501 });
  }

  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  const restore = params.get('restore') === '1';

  if (!id) {
    return NextResponse.json({ error: 'A user id is required' }, { status: 400 });
  }

  // Guard against an admin locking themselves out.
  if (id === admin.userId) {
    return NextResponse.json(
      { error: 'You cannot archive your own account' },
      { status: 400 }
    );
  }

  // 1. Revoke (or reinstate) the login in Supabase Auth.
  //
  //    This is the step that was missing. Archiving only the profile row left
  //    the person with a working password: the app treated them as signed out,
  //    but anyone who had the credentials could still authenticate against
  //    Supabase directly and read the `users` rows RLS allows them. For a
  //    visitor system that is the wrong default - a contractor you archived
  //    should not still be able to get in.
  //
  //    `ban_duration: '876000h'` is the documented way to express "forever"
  //    (roughly 100 years). Restoring sends `null`, which lifts the ban.
  //
  //    Deliberately NOT `auth.admin.deleteUser`: `users.id` cascades from
  //    `auth.users`, so removing the login would delete the profile and take
  //    the attendance history with it.
  const { error: banError } = await service.auth.admin.updateUserById(id, {
    ban_duration: restore ? 'none' : '876000h',
  });

  if (banError) {
    return NextResponse.json(
      { error: `Could not ${restore ? 'restore' : 'revoke'} the login: ${banError.message}` },
      { status: 400 }
    );
  }

  // 2. Flip the profile flag. Archived rows stay readable so attendance history
  //    and past visits keep resolving the person's name.
  const { error } = await service
    .from('users')
    .update({ archived_at: restore ? null : new Date().toISOString() })
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, restored: restore });
}
