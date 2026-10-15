import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVerification, verifyVisitor } from './publicUrl.ts';

describe('decideVerification (verify -> login / review decision)', () => {
  const base = {
    id: 'u1',
    orientation_status: 'pending' as const,
    full_name: 'A Person',
    programme: 'Barista NC II',
    course_id: 'c1',
    email: 'a@example.com',
    has_email: true,
  };

  test('previously confirmed (approved) -> login link', () => {
    assert.equal(
      decideVerification({ ...base, orientation_status: 'approved' }),
      'send-login-link'
    );
  });

  test('existing recognized database user -> login link, not review', () => {
    assert.equal(decideVerification({ ...base, recognized: true }), 'send-login-link');
  });

  test('new / unrecognized user -> review', () => {
    assert.equal(decideVerification({ ...base, recognized: false }), 'review');
  });

  test('existing but unverified user (pending, never signed in) -> review', () => {
    assert.equal(decideVerification({ ...base }), 'review');
  });

  test('declined is never overridden by recognized', () => {
    assert.equal(
      decideVerification({ ...base, orientation_status: 'declined', recognized: true }),
      'declined'
    );
  });

  test('recognized but no address on file still signs in', () => {
    // Sign-in no longer depends on an address: /api/verify mints the session
    // and derives a synthetic login address from the profile id. A missing
    // email must not send a real cohort member to the front desk.
    assert.equal(
      decideVerification({ ...base, recognized: true, email: null, has_email: false }),
      'send-login-link'
    );
  });
});

describe('verification failures never authenticate', () => {
  type Res = { data: unknown; error: { message?: string } | null };
  const stub = (fn: () => Promise<Res>) => ({ rpc: fn });

  test('failed verification (rpc error) -> error outcome, no record', async () => {
    const out = await verifyVisitor(
      'A',
      'Name',
      'c1',
      stub(() => Promise.resolve({ data: null, error: { message: 'boom' } }))
    );
    assert.equal(out.kind, 'error');
  });

  test('database failure / timeout -> error outcome, no record', async () => {
    const out = await verifyVisitor(
      'A',
      'Name',
      'c1',
      stub(() => Promise.reject(new Error('timeout')))
    );
    assert.equal(out.kind, 'error');
  });
});
