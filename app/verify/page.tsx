'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useRoomsStore } from '@/store/roomsStore';
import { useAuthStore } from '@/store/authStore';
import {
  requestVerifyLogin,
  VERIFIED_CHECKIN_PATH,
  type VerifyLoginRecord,
} from '@/lib/publicUrl';
import {
  Alert,
  AuthShell,
  Button,
  Field,
  SelectWrap,
  controlClass,
  selectClass,
} from '@/components/ui';

type Stage =
  | 'form'
  | 'declined'
  | 'pending'
  | 'expired'
  | 'not-found'
  | 'ambiguous'
  | 'error';

/**
 * The hidden staff doorway.
 *
 * Typing these two names at the entrance screen jumps straight to /login
 * instead of looking anyone up. They are deliberately not on the roster, so no
 * real visitor can match them.
 *
 * This is a DOOR, NOT A KEY: it only navigates to /login, which still requires
 * real credentials. Keep it that way - never let this branch mint a session or
 * set `user`.
 *
 * Because this file ships to the browser, the words are readable in the JS
 * bundle. That is acceptable only while the branch stays a redirect.
 */
const ADMIN_SHORTCUT = { firstName: 'HYT', lastName: 'Admin' };

/**
 * Entrance verification.
 *
 * Reached by scanning the QR poster at the front desk. Asks for the trainee's
 * first and last name, looks them up against the roster, and routes on the
 * result:
 *
 *   found + approved  -> sign them in and send them to check-in
 *   found + declined  -> explain, point at the front desk
 *   found + pending   -> explain, point at the front desk
 *   found + expired   -> explain, ask for a renewal (never sent to check-in)
 *   not found         -> /register, prefilled with what they typed
 *   ambiguous         -> explain, send to the front desk (two people, one name)
 *
 * HOW THEY ARE SIGNED IN
 * ----------------------
 * No email and no link. `requestVerifyLogin` calls /api/verify, which resolves
 * the name + course against the roster and - only when the record is approved or
 * already recognized - mints a real Supabase session for the matched account
 * (service-role `generateLink` + `verifyOtp`). This page installs it with
 * `setSession`, refreshes the auth store, and lands on /check-in, where the
 * trainee is checked in automatically.
 *
 * A record with no email on file is signed in the same way: the route derives a
 * synthetic, non-deliverable login address from the profile id, so a missing
 * address is no longer a reason to send anyone to the front desk.
 *
 * SECURITY TRADEOFF
 * -----------------
 * The email step used to be what proved identity: the magic link showed the
 * visitor controlled the mailbox on file. It has been removed at the owner's
 * request, so the name + course pair - which is printed on the orientation
 * roster - is now the only thing needed to obtain a session. Anyone who knows a
 * colleague's name and course can sign in as them. The server route is the one
 * place to add rate limiting, an audit trail, or a per-person secret if that
 * becomes unacceptable; see app/api/verify/route.ts.
 *
 * The EMAIL IS NEVER TYPED HERE: it is read back off the matched row, so the
 * person at the door cannot redirect the session at somebody else.
 *
 * ADMIN DOORWAY
 * -------------
 * Typing the two names in ADMIN_SHORTCUT below jumps to /login instead of
 * looking anyone up. It is a redirect, not a credential: /login still requires
 * a real signed-in account.
 */
export default function VerifyPage() {
  const router = useRouter();
  const { fetchCourses, getActiveCourses } = useRoomsStore();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [courseId, setCourseId] = useState('');
  const [stage, setStage] = useState<Stage>('form');
  const [record, setRecord] = useState<VerifyLoginRecord | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // The course picker needs the courses table. Same store the register form uses,
  // so the two screens cannot drift onto different course lists.
  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  const courses = getActiveCourses();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Hidden staff doorway, checked BEFORE the roster lookup and before the
    // course picker is validated, so it needs no course. It only navigates:
    // /login re-checks the credentials itself, so this cannot grant access.
    if (
      firstName.trim().toLowerCase() === ADMIN_SHORTCUT.firstName.toLowerCase() &&
      lastName.trim().toLowerCase() === ADMIN_SHORTCUT.lastName.toLowerCase()
    ) {
      router.push('/login');
      return;
    }

    setBusy(true);

    const outcome = await requestVerifyLogin(firstName, lastName, courseId);

    if (outcome.kind === 'not-found') {
      setStage('not-found');
      setBusy(false);
      return;
    }

    if (outcome.kind === 'ambiguous') {
      // More than one person in this course shares this name, so there is no way
      // to tell which one is standing at the desk. Refuse rather than guess:
      // picking one would sign this trainee into somebody else's account.
      setStage('ambiguous');
      setBusy(false);
      return;
    }

    if (outcome.kind === 'declined') {
      setRecord(outcome.record);
      setStage('declined');
      setBusy(false);
      return;
    }

    if (outcome.kind === 'review') {
      // Found, but not approved yet - the front desk handles it.
      setRecord(outcome.record);
      setStage('pending');
      setBusy(false);
      return;
    }

    if (outcome.kind === 'expired') {
      // The record is good, but the pass date has passed. The route does not
      // mint a session for this outcome, so there is nothing to install and
      // nowhere to redirect - explain it here.
      setRecord(outcome.record);
      setStage('expired');
      setBusy(false);
      return;
    }

    if (outcome.kind === 'unavailable' || outcome.kind === 'error') {
      // A genuine infrastructure problem, not a verdict. Say so, and give them
      // the normal sign-in as a way forward rather than a false "not on file".
      setError(outcome.message);
      setStage('error');
      setBusy(false);
      return;
    }

    // Approved / recognized: the route returned a real session. Install it,
    // refresh the auth store (AuthGate only restores the session once per page
    // load, so it will not re-run after this navigation), then hand off to
    // /check-in with the marker that triggers the automatic check-in.
    setRecord(outcome.record);

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: outcome.accessToken,
      refresh_token: outcome.refreshToken,
    });

    if (sessionError) {
      setError(
        'We found your record, but could not sign you in. Please speak to the front desk.'
      );
      setStage('error');
      setBusy(false);
      return;
    }

    await useAuthStore.getState().checkAuth();
    router.replace(VERIFIED_CHECKIN_PATH);
  };

  // Carry their name into registration so it is not retyped. The two fields map
  // straight onto two of /register's three, so they travel separately rather
  // than being joined and re-split. The middle initial is left blank: the
  // trainee has not given us one, and inventing it from the stored name is
  // exactly the guesswork the split columns exist to avoid.
  //
  // Only the name: the course is deliberately NOT forwarded. /register keys its
  // picker on course id and the course list loads asynchronously, so a label in
  // the query string could not be applied without a re-render race - and the
  // trainee is picking their course fresh anyway, since that is what told us
  // they had no record.
  const registerHref =
    `/register?firstName=${encodeURIComponent(firstName.trim())}` +
    `&lastName=${encodeURIComponent(lastName.trim())}`;

  const reset = () => {
    setStage('form');
    setError('');
  };

  return (
    <AuthShell
      eyebrow='Entrance check-in'
      title='Welcome back'
      subtitle='Confirm your name and course to start today’s attendance.'
      asideLogo='none'
      aside={
        <div className='space-y-5'>
          <p className='text-[11px] font-semibold uppercase tracking-[0.18em] text-yellow-400'>
            Orientation roster
          </p>
          <h2 className='text-3xl font-bold leading-tight text-white'>
            Your pass is waiting at the door.
          </h2>
          <p className='max-w-md text-sm leading-relaxed text-navy-400'>
            We match the name and course on your orientation record. Once you
            are verified, check-in happens automatically and your room scan is
            ready from your phone.
          </p>
          <ol className='space-y-3'>
            {[
              {
                icon: 'fa-id-card',
                title: '1. Confirm your record',
                body: 'First name, last name and the course you attended.',
              },
              {
                icon: 'fa-door-open',
                title: '2. Attendance starts',
                body: 'We check you in at the entrance as soon as you are verified.',
              },
              {
                icon: 'fa-location-dot',
                title: '3. Scan your room',
                body: 'Use the room door QR to record where you are during the day.',
              },
            ].map((step) => (
              <li
                key={step.title}
                className='flex gap-3 rounded-2xl border border-navy-700/70 bg-navy-900/60 p-4'
              >
                <span className='flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-yellow-500/15 text-yellow-400'>
                  <i className={`fa-solid ${step.icon} text-sm`}></i>
                </span>
                <div>
                  <p className='text-sm font-semibold text-white'>
                    {step.title}
                  </p>
                  <p className='mt-0.5 text-xs leading-relaxed text-navy-400'>
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      }
    >
      {stage === 'form' && (
        <>
          <p className='mb-5 text-sm leading-relaxed text-navy-300'>
            Enter the name and course printed on your orientation roster.
          </p>

          <form onSubmit={handleSubmit} className='space-y-4'>
            {/* Two fields, not one. The database matches the first and last
                word of the stored full name, so a trainee does not have to
                reproduce their middle name exactly to be let in. */}
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <Field
                label='First name'
                htmlFor='v-first-name'
                required
              >
                <input
                  id='v-first-name'
                  className={controlClass}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder='Ma. Juana Mae'
                  autoComplete='given-name'
                  required
                />
              </Field>
              <Field label='Last name' htmlFor='v-last-name' required>
                <input
                  id='v-last-name'
                  className={controlClass}
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder='Dela Cruz'
                  autoComplete='family-name'
                  required
                />
              </Field>
            </div>

            <Field label='Course' htmlFor='v-course' required>
              <SelectWrap>
                <select
                  id='v-course'
                  value={courseId}
                  onChange={(e) => setCourseId(e.target.value)}
                  required
                  className={selectClass}
                >
                  <option value='' className='bg-navy-900'>
                    Select your course
                  </option>
                  {courses.map((course) => (
                    <option
                      key={course.id}
                      value={course.id}
                      className='bg-navy-900'
                    >
                      {course.label}
                    </option>
                  ))}
                </select>
              </SelectWrap>
            </Field>

            {error && (
              <Alert tone='danger' role='alert'>
                {error}
              </Alert>
            )}

            <Button
              type='submit'
              loading={busy}
              icon='fa-right-to-bracket'
              className='w-full'
              size='lg'
            >
              {busy ? 'Checking your record…' : 'Check my record'}
            </Button>
          </form>

          <div className='mt-5 border-t border-navy-800 pt-5 text-center'>
            <p className='mb-2 text-xs text-navy-400'>
              First time at HYT Global?
            </p>
            <Link
              href='/register'
              className='inline-flex items-center gap-2 text-sm font-semibold text-yellow-300 transition-colors hover:text-yellow-200'
            >
              <i className='fa-solid fa-user-plus text-xs'></i>
              Register for a pass
            </Link>
          </div>
        </>
      )}

      {stage === 'error' && (
        <div className='py-2 text-center'>
          <div className='mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/20'>
            <i className='fa-solid fa-triangle-exclamation text-2xl text-red-400'></i>
          </div>
          <h2 className='mb-2 text-xl font-bold text-white'>
            Could not sign you in
          </h2>
          {error && (
            <Alert tone='warning' role='alert' className='mb-4 text-left'>
              {error}
            </Alert>
          )}
          <Button onClick={reset} className='w-full' size='lg'>
            Try again
          </Button>
        </div>
      )}

      {(stage === 'declined' || stage === 'pending') && (
        <div className='py-2 text-center'>
          <div
            className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${
              stage === 'declined' ? 'bg-red-500/20' : 'bg-yellow-500/20'
            }`}
          >
            <i
              className={`fa-solid ${
                stage === 'declined' ? 'fa-circle-xmark' : 'fa-clock'
              } ${stage === 'declined' ? 'text-red-400' : 'text-yellow-400'} text-2xl`}
            ></i>
          </div>
          <h2 className='mb-2 text-xl font-bold text-white'>
            {stage === 'declined' ? 'Not approved' : 'Awaiting review'}
          </h2>
          {record && (
            <p className='mb-2 text-sm text-navy-300'>
              We found{' '}
              <span className='font-semibold text-white'>
                {record.full_name}
              </span>
              {record.programme ? ` (${record.programme})` : ''}.
            </p>
          )}
          <p className='mb-6 text-sm leading-relaxed text-navy-300'>
            {stage === 'declined'
              ? 'Your record was found, but the last orientation was not approved. Please speak to the front desk before entering.'
              : 'Your record was found, but your result has not been processed yet. Please speak to the front desk.'}
          </p>
          <Button onClick={reset} variant='secondary' className='w-full'>
            Try a different name
          </Button>
        </div>
      )}

      {stage === 'expired' && (
        <div className='py-2 text-center'>
          <div className='mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/20'>
            <i className='fa-solid fa-clock text-2xl text-yellow-400'></i>
          </div>
          <h2 className='mb-2 text-xl font-bold text-white'>Your pass expired</h2>
          {record && (
            <p className='mb-2 text-sm text-navy-300'>
              We found{' '}
              <span className='font-semibold text-white'>
                {record.full_name}
              </span>
              {record.programme ? ` (${record.programme})` : ''}.
            </p>
          )}
          <p className='mb-6 text-sm leading-relaxed text-navy-300'>
            Your record is still on file, but the pass date has passed, so we
            cannot start a new check-in. Ask the front desk to renew it. Your
            account and visit history are kept.
          </p>
          <Button onClick={reset} variant='secondary' className='w-full'>
            Try a different name
          </Button>
        </div>
      )}

      {stage === 'ambiguous' && (
        <div className='py-2 text-center'>
          <div className='mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/20'>
            <i className='fa-solid fa-users text-2xl text-yellow-400'></i>
          </div>
          <h2 className='mb-2 text-xl font-bold text-white'>
            More than one match
          </h2>
          <p className='mb-6 text-sm leading-relaxed text-navy-300'>
            We found more than one person with that name in this course, so we
            cannot tell which record is yours. Please speak to the front desk
            and they will confirm it for you.
          </p>
          <Button onClick={reset} variant='secondary' className='w-full'>
            Check a different name
          </Button>
        </div>
      )}

      {stage === 'not-found' && (
        <div className='py-2 text-center'>
          <div className='mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-500/20'>
            <i className='fa-solid fa-user-plus text-2xl text-blue-300'></i>
          </div>
          <h2 className='mb-2 text-xl font-bold text-white'>No record found</h2>
          <p className='mb-6 text-sm leading-relaxed text-navy-300'>
            We have no orientation record for that name in this course. You may
            have mistyped your name, or you may not have attended orientation.
            Try again, or register for a pass and the front desk will review it.
          </p>
          <Button onClick={reset} variant='secondary' className='w-full'>
            Check my name again
          </Button>
          <Button
            onClick={() => router.push(registerHref)}
            variant='primary'
            className='mt-3 w-full'
            icon='fa-user-plus'
          >
            Register for a pass
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
