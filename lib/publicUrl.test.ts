import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SITE_ORIGIN,
  fetchOrientationStatus,
  registrationUrl,
  siteOrigin,
  verificationUrl,
  verifyVisitor,
} from './publicUrl.ts';

// The QR is printed and scanned by a phone, so the URL it encodes is effectively
// frozen in the physical world. These tests pin the two properties that matter:
// it is absolute (a relative path scans as nothing useful), and it never carries
// a double slash that would only surface after printing.

describe('siteOrigin', () => {
  test('falls back to localhost when nothing else is known', () => {
    // No window in node, and NEXT_PUBLIC_APP_URL is unset under `node --test`
    // unless the operator exported it.
    assert.equal(siteOrigin(), DEFAULT_SITE_ORIGIN);
  });

  test('a configured origin is used and trailing slashes trimmed', () => {
    const before = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://hyt.example.com///';
    try {
      assert.equal(siteOrigin(), 'https://hyt.example.com');
      assert.equal(registrationUrl(), 'https://hyt.example.com/verify');
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = before;
    }
  });

  test('the CONFIGURED origin beats the live one', () => {
    // This is the entire point of the precedence order, and the failure it
    // prevents is only visible on a deployment platform: printing the poster
    // from a Vercel preview build would otherwise bake a throwaway preview
    // hostname into a physical artefact that outlives the preview.
    const before = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://hyt-wayfinder.vercel.app';
    try {
      assert.equal(siteOrigin(), 'https://hyt-wayfinder.vercel.app');
      assert.ok(registrationUrl().includes('hyt-wayfinder.vercel.app'));
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = before;
    }
  });

  test('an empty configured value is ignored, not encoded', () => {
    // '' is falsy and must fall through rather than yielding a relative
    // '/register', which a phone scanning the QR cannot act on.
    const before = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = '';
    try {
      assert.equal(siteOrigin(), DEFAULT_SITE_ORIGIN);
      assert.ok(registrationUrl().startsWith('http'));
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = before;
    }
  });
});

describe('fetchOrientationStatus', () => {
  // Minimal stand-in for the Supabase client. Typed loosely on purpose: the real
  // one has a far bigger surface, and these tests are about how the helper
  // interprets what comes back - not about Supabase.
  const stub = (impl: (fn: string, args: Record<string, unknown>) => unknown) =>
    ({ rpc: impl }) as never;

  test('returns the record for a known cohort member', async () => {
    const row = {
      orientation_status: 'approved',
      full_name: 'Gemmalyn Ocbina Aranda',
      programme: 'Barista NC II',
    };
    const result = await fetchOrientationStatus(
      'gemmaaranda05@gmail.com',
      stub(() => Promise.resolve({ data: [row], error: null }))
    );
    assert.deepEqual(result, row);
  });

  test('returns null for someone not in the cohort', async () => {
    // The critical distinction: a genuine walk-in is NOT declined. Treating an
    // empty result as "declined" would turn every first-time visitor away.
    const result = await fetchOrientationStatus(
      'stranger@example.com',
      stub(() => Promise.resolve({ data: [], error: null }))
    );
    assert.equal(result, null);
  });

  test('returns null when the RPC errors, and does not throw', async () => {
    // Happens if migration 20260101000013 has not been applied. Registration
    // must still work; it just cannot show a verdict.
    const result = await fetchOrientationStatus(
      'gemmaaranda05@gmail.com',
      stub(() =>
        Promise.resolve({ data: null, error: { message: 'function does not exist' } })
      )
    );
    assert.equal(result, null);
  });

  test('returns null when the RPC rejects outright', async () => {
    const result = await fetchOrientationStatus(
      'gemmaaranda05@gmail.com',
      stub(() => Promise.reject(new Error('network down')))
    );
    assert.equal(result, null);
  });

  test('skips the call for input that cannot be an address', async () => {
    let called = false;
    const client = stub(() => {
      called = true;
      return Promise.resolve({ data: [], error: null });
    });
    assert.equal(await fetchOrientationStatus('', client), null);
    assert.equal(await fetchOrientationStatus('   ', client), null);
    assert.equal(await fetchOrientationStatus('not-an-email', client), null);
    // No round trip per keystroke while someone is still typing.
    assert.equal(called, false);
  });

  test('trims the address before sending it', async () => {
    let seen: unknown;
    await fetchOrientationStatus(
      '  gemmaaranda05@gmail.com  ',
      stub((_fn, args) => {
        seen = args.p_email;
        return Promise.resolve({ data: [], error: null });
      })
    );
    assert.equal(seen, 'gemmaaranda05@gmail.com');
  });

  test('preserves a declined verdict rather than collapsing it', async () => {
    const result = await fetchOrientationStatus(
      'declined@example.com',
      stub(() =>
        Promise.resolve({
          data: [
            {
              orientation_status: 'declined',
              full_name: 'Someone Declined',
              programme: null,
            },
          ],
          error: null,
        })
      )
    );
    assert.equal(result?.orientation_status, 'declined');
  });

  test('tolerates a non-array payload', async () => {
    const result = await fetchOrientationStatus(
      'x@example.com',
      stub(() => Promise.resolve({ data: null, error: null }))
    );
    assert.equal(result, null);
  });
});

describe('verifyVisitor', () => {
  const record = {
    id: '22222222-2222-2222-2222-222222222222',
    orientation_status: 'approved' as const,
    full_name: 'Gemmalyn Ocbina Aranda',
    programme: 'Barista NC II',
    course_id: '11111111-1111-1111-1111-111111111111',
    email: 'gemmaaranda05@gmail.com',
    has_email: true,
  };
  const stub = (impl: (fn: string, args: Record<string, unknown>) => unknown) =>
    ({ rpc: impl }) as never;

  const COURSE = '11111111-1111-1111-1111-111111111111';

  test('found: returns the record for a matching name and course', async () => {
    const out = await verifyVisitor(
      'Gemmalyn',
      'Aranda',
      COURSE,
      stub(() => Promise.resolve({ data: [record], error: null }))
    );
    assert.equal(out.kind, 'found');
    assert.deepEqual(out.kind === 'found' ? out.record : null, record);
  });

  test('the email comes from the matched row, never from the caller', async () => {
    // The whole point of dropping the email input: the sign-in link must go to
    // the address on file. If the UI could ever pass an address through to
    // signInWithOtp, whoever held the phone could redirect a stranger's link.
    const out = await verifyVisitor(
      'Gemmalyn',
      'Aranda',
      COURSE,
      stub(() => Promise.resolve({ data: [record], error: null }))
    );
    assert.equal(out.kind === 'found' ? out.record.email : null, record.email);
  });

  test('surfaces a roster row that has no address, rather than pretending', async () => {
    // Migration 20260101000014 made users.email nullable. The record still comes
    // back as 'found' - they ARE on the roster and approved - but email is null
    // and has_email is false, which is the page's cue to send them to the desk
    // instead of promising a magic link that cannot be delivered.
    const noEmail = {
      ...record,
      email: null,
      has_email: false,
    };
    const out = await verifyVisitor(
      'Daniella',
      'Casiano',
      COURSE,
      stub(() => Promise.resolve({ data: [noEmail], error: null }))
    );
    assert.equal(out.kind, 'found');
    assert.equal(out.kind === 'found' ? out.record.has_email : true, false);
    assert.equal(out.kind === 'found' ? out.record.email : 'x', null);
    // The verdict still has to survive, or the front desk loses the reason the
    // person is being turned away.
    assert.equal(
      out.kind === 'found' ? out.record.orientation_status : null,
      'approved'
    );
  });

  test('a null email is not mistaken for not-found', async () => {
    // The distinction the whole nullable-email change rests on: a missing
    // address must never collapse into "we have no record of you", which would
    // send a real cohort member off to register a duplicate account.
    const out = await verifyVisitor(
      'Daniella',
      'Casiano',
      COURSE,
      stub(() =>
        Promise.resolve({
          data: [{ ...record, email: null, has_email: false }],
          error: null,
        })
      )
    );
    assert.notEqual(out.kind, 'not-found');
    assert.equal(out.kind, 'found');
  });

  test('not-found: unknown name in that course, and this is NOT an error', async () => {
    // Critical distinction. Reporting this as an error would tell a legitimate
    // member "we could not check you" because of a dropped connection, sending
    // them to re-register and creating the duplicate account we are avoiding.
    const out = await verifyVisitor(
      'A',
      'Stranger',
      COURSE,
      stub(() => Promise.resolve({ data: [], error: null }))
    );
    assert.equal(out.kind, 'not-found');
  });

  test('ambiguous: two people share a name in one course', async () => {
    // A course holds many people, so this is reachable, not theoretical. It must
    // NOT resolve to either record - picking one shows somebody a stranger's
    // verdict and mails that stranger's sign-in link.
    const twin = { ...record, email: 'other.person@gmail.com' };
    const out = await verifyVisitor(
      'Gemmalyn',
      'Aranda',
      COURSE,
      stub(() => Promise.resolve({ data: [record, twin], error: null }))
    );
    assert.equal(out.kind, 'ambiguous');
    assert.equal(out.kind === 'ambiguous' ? out.count : 0, 2);
    // Crucially, neither record is exposed for the page to act on.
    assert.ok(!('record' in out));
  });

  test('error: RPC failure is reported separately from not-found', async () => {
    const out = await verifyVisitor(
      'Gemmalyn',
      'Aranda',
      COURSE,
      stub(() => Promise.resolve({ data: null, error: { message: 'boom' } }))
    );
    assert.equal(out.kind, 'error');
    assert.ok(out.kind === 'error' && out.message.length > 0);
  });

  test('error: a thrown transport failure is caught, not propagated', async () => {
    const out = await verifyVisitor(
      'Gemmalyn',
      'Aranda',
      COURSE,
      stub(() => Promise.reject(new Error('offline')))
    );
    assert.equal(out.kind, 'error');
  });

  test('validates both fields before calling the database', async () => {
    let called = false;
    const client = stub(() => {
      called = true;
      return Promise.resolve({ data: [], error: null });
    });
    assert.equal((await verifyVisitor('', 'Aranda', COURSE, client)).kind, 'error');
    assert.equal((await verifyVisitor('   ', 'Aranda', COURSE, client)).kind, 'error');
    assert.equal((await verifyVisitor('Gemmalyn', '', COURSE, client)).kind, 'error');
    assert.equal((await verifyVisitor('Gemmalyn', 'Aranda', '', client)).kind, 'error');
    assert.equal(called, false);
  });

  test('sends the trimmed names and the course id it was given', async () => {
    let args: Record<string, unknown> = {};
    await verifyVisitor(
      '  Gemmalyn  ',
      '  Aranda  ',
      COURSE,
      stub((_fn, a) => {
        args = a;
        return Promise.resolve({ data: [], error: null });
      })
    );
    // Trimming is done here; case folding is the database's job via lower().
    assert.equal(args.p_first_name, 'Gemmalyn');
    assert.equal(args.p_last_name, 'Aranda');
    assert.equal(args.p_course_id, COURSE);
    // The address must not be an argument at all.
    assert.ok(!('p_email' in args));
  });

  test('passes a declined verdict through unchanged', async () => {
    // The page branches on this, so it must survive the round trip intact.
    const declined = { ...record, orientation_status: 'declined' as const };
    const out = await verifyVisitor(
      'Gemmalyn',
      'Aranda',
      COURSE,
      stub(() => Promise.resolve({ data: [declined], error: null }))
    );
    assert.equal(out.kind === 'found' ? out.record.orientation_status : null, 'declined');
  });

  test('preserves pending, which must not be treated as approved', async () => {
    const pending = { ...record, orientation_status: 'pending' as const };
    const out = await verifyVisitor(
      'Gemmalyn',
      'Aranda',
      COURSE,
      stub(() => Promise.resolve({ data: [pending], error: null }))
    );
    assert.equal(out.kind === 'found' ? out.record.orientation_status : null, 'pending');
  });
});
  describe('registrationUrl', () => {
  test('is absolute and points at /verify', () => {
    const url = registrationUrl();
    assert.ok(url.startsWith('http://') || url.startsWith('https://'));
    // The poster must land on verification, not straight on registration: a
    // cohort member sent to /register would collide on their own email.
    assert.ok(url.endsWith('/verify'));
  });

  test('verificationUrl is the same target as registrationUrl', () => {
    // The name changed but several call sites still read the old one. If these
    // ever diverge, the poster and the tests would be pointing at different
    // pages, which is exactly the kind of drift nobody notices until a visitor
    // scans a dead code.
    assert.equal(verificationUrl(), registrationUrl());
  });

  test('contains no doubled slash in the path', () => {
    // 'https://host//verify' would 404 on some hosts, and the mistake is
    // invisible in a QR until someone scans it on a real phone.
    const path = registrationUrl().replace(/^https?:\/\/[^/]+/, '');
    assert.equal(path, '/verify');
  });

  test('does not point at the admin-only station', () => {
    // /station is role-guarded and redirects non-admins to /admin, so a poster
    // aiming there would dead-end every walk-in.
    assert.ok(!registrationUrl().includes('/station'));
  });
});