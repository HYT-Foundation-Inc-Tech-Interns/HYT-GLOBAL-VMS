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

type Stage =
  | 'form'
  | 'declined'
  | 'pending'
  | 'not-found'
  | 'ambiguous'
  | 'error';

const INPUT =
  'w-full px-4 py-3 rounded-lg bg-navy-900/80 border-2 border-yellow-500/30 text-white placeholder-navy-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500 transition-colors';

/**
 * Entrance verification.
 *
 * Reached by scanning the QR poster at the front desk. Asks for the visitor's
 * first and last name, looks them up against the roster, and routes on the
 * result:
 *
 *   found + approved  -> sign them in and send them to check-in
 *   found + declined  -> explain, point at the front desk
 *   found + pending   -> explain, point at the front desk
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
 * visitor is checked in automatically.
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
      // picking one would sign this visitor into somebody else's account.
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
  // visitor has not given us one, and inventing it from the stored name is
  // exactly the guesswork the split columns exist to avoid.
  //
  // Only the name: the course is deliberately NOT forwarded. /register keys its
  // picker on course id and the course list loads asynchronously, so a label in
  // the query string could not be applied without a re-render race - and the
  // visitor is picking their course fresh anyway, since that is what told us
  // they had no record.
  const registerHref =
    `/register?firstName=${encodeURIComponent(firstName.trim())}` +
    `&lastName=${encodeURIComponent(lastName.trim())}`;

  return (
    <div className='min-h-screen flex items-start sm:items-center justify-center p-4 sm:py-8'>
      <div className='w-full max-w-md'>
        <div className='glass-panel border-navy-700 rounded-lg p-6 sm:p-8'>
          {/* Same mark as the other auth screens, so this reads as part of the
              product rather than a separate app bolted on. */}
          <div className='text-center mb-6'>
            <div className='w-14 h-14 mx-auto mb-3 flex items-center justify-center'>
              <img
                src='/hyt_logo.png'
                alt='HYT Global'
                className='w-full h-full object-contain'
              />
            </div>
            <h1 className='text-2xl font-bold text-white mb-1'>Visitor Validation</h1>
            <p className='text-yellow-300 text-sm'>HYT Global Institute</p>
          </div>
          {stage === 'form' && (
            <>
              <p className='text-navy-300 text-sm mb-5'>
                Enter your first and last name to verify your previous visit.
              </p>

              <form onSubmit={handleSubmit} className='space-y-4'>
                {/* Two fields, not one. The database matches the first and last
                    word of the stored full name, so a visitor does not have to
                    reproduce their middle name exactly to be let in. */}
                <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                  <div>
                    <label
                      htmlFor='v-first-name'
                      className='block text-sm font-medium text-navy-200 mb-1.5'
                    >
                      First name <span className='text-red-400'>*</span>
                    </label>
                    <input
                      id='v-first-name'
                      className={INPUT}
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder='Ma. Juana Mae'
                      autoComplete='given-name'
                      required
                    />
                  </div>
                  <div>
                    <label
                      htmlFor='v-last-name'
                      className='block text-sm font-medium text-navy-200 mb-1.5'
                    >
                      Last name <span className='text-red-400'>*</span>
                    </label>
                    <input
                      id='v-last-name'
                      className={INPUT}
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder='Dela Cruz'
                      autoComplete='family-name'
                      required
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor='v-course'
                    className='block text-sm font-medium text-navy-200 mb-1.5'
                  >
                    Course <span className='text-red-400'>*</span>
                  </label>
                  <div className='relative'>
                    <select
                      id='v-course'
                      value={courseId}
                      onChange={(e) => setCourseId(e.target.value)}
                      required
                      className={`${INPUT} appearance-none cursor-pointer pl-11`}
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
                    <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                      <i className='fa-solid fa-graduation-cap text-yellow-400'></i>
                    </div>
                    <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                  </div>
                </div>

                {error && (
                  <p
                    role='alert'
                    className='text-red-300 text-sm bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2'
                  >
                    {error}
                  </p>
                )}

                <button
                  type='submit'
                  disabled={busy}
                  className='w-full px-4 py-3 rounded-lg bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed'
                >
                  {busy ? 'Verifying…' : 'Check my record'}
                </button>
              </form>

              <div className='mt-5 pt-5 border-t border-navy-800 text-center'>
                <p className='text-navy-400 text-xs mb-2'>Never attended orientation?</p>
                <Link
                  href='/register'
                  className='text-yellow-300 hover:text-yellow-200 text-sm font-semibold'
                >
                  Register as a new visitor
                </Link>
              </div>
            </>
          )}

          {stage === 'error' && (
            <div className='text-center py-4'>
              <div className='w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center'>
                <i className='fa-solid fa-triangle-exclamation text-red-400 text-2xl'></i>
              </div>
              <h2 className='text-xl font-bold text-white mb-2'>
                Could not sign you in
              </h2>
              {error && (
                <p
                  role='alert'
                  className='text-yellow-300 text-sm bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 mb-4'
                >
                  {error}
                </p>
              )}
              <button
                onClick={() => {
                  setStage('form');
                  setError('');
                }}
                className='w-full px-4 py-3 rounded-lg bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-semibold text-sm'
              >
                Try again
              </button>
              <Link
                href='/login'
                className='inline-block mt-3 text-navy-400 hover:text-navy-200 text-sm'
              >
                Use the normal sign-in instead
              </Link>
            </div>
          )}

          {(stage === 'declined' || stage === 'pending') && (
            <div className='text-center py-4'>
              <div
                className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
                  stage === 'declined' ? 'bg-red-500/20' : 'bg-yellow-500/20'
                }`}
              >
                <i
                  className={`fa-solid ${
                    stage === 'declined' ? 'fa-circle-xmark' : 'fa-clock'
                  } ${
                    stage === 'declined' ? 'text-red-400' : 'text-yellow-400'
                  } text-2xl`}
                ></i>
              </div>
              <h2 className='text-xl font-bold text-white mb-2'>
                {stage === 'declined' ? 'Not approved' : 'Awaiting review'}
              </h2>
              {record && (
                <p className='text-navy-300 text-sm mb-2'>
                  We found{' '}
                  <span className='text-white font-semibold'>{record.full_name}</span>
                  {record.programme ? ` (${record.programme})` : ''}.
                </p>
              )}
              <p className='text-navy-300 text-sm mb-6'>
                {stage === 'declined'
                  ? 'Your record was found, but the last orientation was not approved. Please speak to the front desk before entering.'
                  : 'Your record was found, but your result has not been processed yet. Please speak to the front desk.'}
              </p>
              <button
                onClick={() => {
                  setStage('form');
                  setError('');
                }}
                className='text-navy-400 hover:text-navy-200 text-sm'
              >
                Try a different name
              </button>
            </div>
          )}

          {stage === 'ambiguous' && (
            <div className='text-center py-4'>
              <div className='w-16 h-16 mx-auto mb-4 rounded-full bg-yellow-500/20 flex items-center justify-center'>
                <i className='fa-solid fa-users text-yellow-400 text-2xl'></i>
              </div>
              <h2 className='text-xl font-bold text-white mb-2'>
                More than one match
              </h2>
              <p className='text-navy-300 text-sm mb-6'>
                We found more than one person with that name in this course, so we
                cannot tell which record is yours. Please speak to the front desk and
                they will confirm it for you.
              </p>
              <button
                onClick={() => {
                  setStage('form');
                  setError('');
                }}
                className='text-navy-400 hover:text-navy-200 text-sm'
              >
                Check a different name
              </button>
            </div>
          )}

          {stage === 'not-found' && (
            <div className='text-center py-4'>
              <div className='w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/20 flex items-center justify-center'>
                <i className='fa-solid fa-user-plus text-blue-300 text-2xl'></i>
              </div>
              <h2 className='text-xl font-bold text-white mb-2'>No record found</h2>
              <p className='text-navy-300 text-sm mb-6'>
                We have no orientation record for that name in this course. You may
                have mistyped your name, or you may not have attended orientation.
                Try again, or register as a new visitor and the front desk will
                review it.
              </p>
              <button
                onClick={() => {
                  setStage('form');
                  setError('');
                }}
                className='w-full px-4 py-3 rounded-lg bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-semibold text-sm'
              >
                Authenticate Again
              </button>
              <button
                onClick={() => router.push(registerHref)}
                className='w-full px-4 py-3 mt-3 rounded-lg bg-navy-800 hover:bg-navy-700 text-yellow-200 font-semibold text-sm border border-navy-600'
              >
                Register as new visitor
              </button>
            </div>
          )}
        </div>

        <p className='text-center text-navy-500 text-xs mt-4'>
          HYT Global Institute · Visitor Management System
        </p>
      </div>
    </div>
  );
}
