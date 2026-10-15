'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useRoomsStore } from '@/store/roomsStore';
import { formatPhone, sanitisePhone, isAllowedPhoneKey } from '@/lib/phone';
import { supabase } from '@/lib/supabase';
import {
  fetchOrientationStatus,
  VERIFIED_CHECKIN_PATH,
  type OrientationRecord,
} from '@/lib/publicUrl';
import Link from 'next/link';

/**
 * Joins class names, dropping falsy entries.
 *
 * Local rather than a dependency: `classnames`/`clsx` are not in package.json,
 * and this is the only place in the app that needs it. Everything else composes
 * class strings with template literals.
 */
function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Banner styling per verdict.
 *
 * `null` (not in the cohort) is deliberately absent: a first-time walk-in has no
 * verdict, and showing them "pending" would be inventing a status they do not
 * have. Only the three real states are styled here.
 */
const VERDICT_STYLE: Record<
  NonNullable<OrientationRecord['orientation_status']>,
  { box: string; icon: string; label: string; text: string }
> = {
  approved: {
    box: 'border-green-500/30 bg-green-500/10',
    icon: 'fa-circle-check',
    label: 'Approved',
    text: 'text-green-300',
  },
  declined: {
    box: 'border-red-500/30 bg-red-500/10',
    icon: 'fa-circle-xmark',
    label: 'Not approved',
    text: 'text-red-300',
  },
  pending: {
    box: 'border-yellow-500/30 bg-yellow-500/10',
    icon: 'fa-clock',
    label: 'Awaiting review',
    text: 'text-yellow-300',
  },
};

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuthStore();
  // Purposes and rooms both come from lookup tables, not hardcoded lists, so adding
  // a reason or a room in the database makes it selectable here immediately.
  const {
    fetchPurposes,
    getActivePurposes,
    fetchVisitorTypes,
    getActiveVisitorTypes,
    fetchRooms,
    getActiveRooms,
    fetchCourses,
    getActiveCourses,
    getRoomForCourse,
  } = useRoomsStore();

  // Prefill from /verify. Somebody sent here because we had no record for them has
  // already typed their name and email once; making them retype it is the kind of
  // small friction that turns into abandoning the form at the door.
  //
  // Read once, in a lazy initializer, rather than via useSearchParams: that hook
  // needs a Suspense boundary in the App Router, and re-reading on every render
  // would fight the user's own edits as soon as they start typing.
  //
  // The query string is attacker-supplied, so every value is treated as display
  // text only - the register path already re-validates the address, and nothing
  // downstream treats these fields as verified.
  const [prefill] = useState(() => {
    if (typeof window === 'undefined') {
      return { firstName: '', lastName: '', email: '' };
    }
    const params = new URLSearchParams(window.location.search);
    return {
      firstName: (params.get('firstName') ?? '').slice(0, 120),
      lastName: (params.get('lastName') ?? '').slice(0, 120),
      email: (params.get('email') ?? '').slice(0, 254),
    };
  });

  const [formData, setFormData] = useState({
    firstName: prefill.firstName,
    middleInitial: '',
    lastName: prefill.lastName,
    email: prefill.email,
    password: '',
    confirmPassword: '',
    destination: '',
    purpose: '',
    // Visitor profile. Asked here so the front desk has it before the person
    // reaches the desk, and so an orientation attendee is classified once
    // instead of being tidied up afterwards. All optional.
    //
    // Deliberately NOT asked here: `host_name` and `notes`. A visitor cannot
    // meaningfully supply either - they do not know who they are meeting by
    // name, and there is nothing they could put in a front-desk note. Both
    // remain on the admin form, which is written by staff who do know.
    visitorTypeId: '',
    company: '',
    phone: '',
    // Required: a visitor is enrolled in exactly one course. Persisted as
    // users.course_id by migration 20260101000011.
    courseId: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Orientation verdict for whoever is typing this email, once it resolves to a
  // cohort member. `undefined` = still looking (or not looking), `null` = not in
  // the cohort. Only a non-null record produces a banner.
  const [orientation, setOrientation] = useState<OrientationRecord | null | undefined>(
    undefined
  );
  // Set once the account exists but the email still needs confirming. Drives the
  // "check your inbox" screen instead of an error message.
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(
    null
  );

  const purposes = getActivePurposes();
  const visitorTypes = getActiveVisitorTypes();
  // Already ordered by floor then room number by the store.
  const rooms = getActiveRooms();
  const courses = getActiveCourses();

  useEffect(() => {
    fetchPurposes();
    fetchVisitorTypes();
    fetchRooms();
    fetchCourses();
  }, [fetchPurposes, fetchVisitorTypes, fetchRooms, fetchCourses]);

  // The assigned room is derived from the chosen course and is not editable on
  // this form, so this is the only writer of `destination`. The same-value guard
  // keeps it from looping when the effect re-runs as the reference lists load.
  useEffect(() => {
    const mapped = getRoomForCourse(formData.courseId);
    // Only offer a room the picker actually renders (the active list).
    const next =
      mapped && rooms.some((r) => r.id === mapped.id) ? mapped.roomNumber : '';
    setFormData((f) => (f.destination === next ? f : { ...f, destination: next }));
  }, [formData.courseId, rooms, getRoomForCourse]);

  // Orientation lookup, debounced.
  //
  // Fires once the address looks like an address AND the typing pauses, rather
  // than on every keystroke - the naive version sends a request per character.
  // 500ms is long enough that a full address is typed in one go before the first
  // lookup, short enough to feel instant on a phone.
  //
  // The `cancelled` flag guards the response ordering: without it, a slow lookup
  // for an earlier address can land after a fast one for a later address and
  // overwrite the banner with somebody else's verdict.
  useEffect(() => {
    const email = formData.email.trim();
    if (!email.includes('@')) {
      setOrientation(undefined);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      const record = await fetchOrientationStatus(email, supabase);
      if (!cancelled) setOrientation(record);
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [formData.email]);

  

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validation
    if (!formData.firstName.trim() || !formData.lastName.trim()) {
      setError('First name and last name are required');
      return;
    }

    // Password checks are commented out with the password fields below. There is
    // no password input on this form any more, so both would fail on an empty
    // string and block every registration. Restore them if the fields come back.
    //
    // if (formData.password !== formData.confirmPassword) {
    //   setError('Passwords do not match');
    //   return;
    // }
    //
    // if (formData.password.length < 6) {
    //   setError('Password must be at least 6 characters');
    //   return;
    // }

    if (!formData.courseId) {
      setError('Please select a course');
      return;
    }

    if (!formData.purpose) {
      setError('Please select a purpose');
      return;
    }

    setLoading(true);

    // A self-registered visitor gets a pass that expires at the end of today.
    //
    // Public registration is for walk-ins: someone who has come to the building
    // now. Making the pass day-scoped means a forgotten account cannot quietly
    // stay valid for months. `isPassExpired` compares against the START of today,
    // so an end-of-today timestamp stays valid for the whole day they registered
    // and locks them out tomorrow - which is the intended "one day".
    //
    // Staff creating someone who is staying longer set `valid_until` explicitly
    // on the admin form instead, which overrides this.
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    // The pickers work in numbers and labels, but the pending columns are FKs, so
    // resolve the chosen values back to their row ids. Looked up by the same
    // value the <option> carried, so this cannot disagree with the picker.
    const chosenRoom = rooms.find((r) => r.roomNumber === formData.destination);
    const chosenPurpose = purposes.find((p) => p.label === formData.purpose);

    // No password is collected any more (see the commented-out fields below), but
    // Supabase still needs one to create the auth user. This is a throwaway: it
    // is never shown, never sent anywhere, and never used to sign in - visitors
    // authenticate through /verify with their name and course.
    const generatedPassword =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    const result = await register({
      firstName: formData.firstName,
      middleInitial: formData.middleInitial,
      lastName: formData.lastName,
      email: formData.email,
      password: generatedPassword,
      destination: formData.destination || undefined,
      purpose: formData.purpose || undefined,
      pendingRoomId: chosenRoom?.id,
      pendingPurposeId: chosenPurpose?.id,
      visitorTypeId: formData.visitorTypeId || undefined,
      company: formData.company.trim() || undefined,
      phone: formData.phone.trim() || undefined,
      courseId: formData.courseId,
      validUntil: endOfToday.toISOString(),
    });

    // The account exists but the address is not confirmed yet, so there is no
    // session and nothing more to do here. This is a success state, not a
    // failure: sending them to their inbox is the correct next step.
    if (result.needsConfirmation) {
      setPendingConfirmation(formData.email);
      setLoading(false);
      return;
    }

    if (result.success) {
        // Self-registration only ever produces a visitor: the database trigger
        // hardcodes role='visitor' and ignores anything the client sends. Admins
        // are provisioned by hand through /admin/users.
        //
        // The ?verified=1 marker is the same one /verify appends, so
        // /check-in's auto-check-in hook fires as soon as the visitor lands and
        // records them without a second scan. Same destination as a successful
        // /verify, so both entry points end in the same place.
        router.push(VERIFIED_CHECKIN_PATH);
      } else {
        setError(result.error || 'Registration failed');
        setLoading(false);
      }
    };

  return (
    <>
      {/* Account created, email not yet confirmed. A success screen, not an
          error: there is genuinely nothing to fix, they just need to click the
          link Supabase emailed them. */}
      {pendingConfirmation && (
        <div className='min-h-screen flex items-center justify-center p-4'>
          <div className='w-full max-w-md text-center'>
            <div className='glass-panel border-navy-700 rounded-lg p-8'>
              <div className='w-16 h-16 mx-auto mb-5 rounded-full bg-yellow-500/20 flex items-center justify-center'>
                <i className='fa-solid fa-envelope-open-text text-yellow-400 text-2xl'></i>
              </div>
              <h1 className='text-2xl font-bold text-white mb-3'>
                Check your email
              </h1>
              <p className='text-navy-300 text-sm mb-2'>
                We sent a confirmation link to
              </p>
              <p className='text-white font-semibold mb-6 break-all'>
                {pendingConfirmation}
              </p>
              <p className='text-navy-400 text-sm mb-6'>
                Open it to activate your account, then sign in. The link expires
                after a while, so if it has gone stale just register again.
              </p>
              <Link
                href='/login'
                className='
                  inline-block w-full px-4 py-3 rounded-lg
                  bg-yellow-500 hover:bg-yellow-600 text-yellow-950
                  font-semibold text-sm transition-colors
                '
              >
                Go to Sign In
              </Link>
              <button
                onClick={() => {
                  setPendingConfirmation(null);
                  setError('');
                }}
                className='mt-4 text-navy-400 hover:text-navy-200 text-sm transition-colors'
              >
                Use a different email
              </button>
            </div>
          </div>
        </div>
      )}

      {!pendingConfirmation && (
        // items-start on small screens. Centring a tall form with flex centres
        // the overflow too, so the top and bottom get clipped and become
        // unreachable on a phone - including the Create Account button.
        <div className='min-h-screen flex items-start sm:items-center justify-center p-4 sm:py-8'>
        {/* Register Card */}
        <div className='relative w-full max-w-md'>
          {/* Logo. Smaller on phones so it does not push the form off screen. */}
          <div className='text-center mb-6 sm:mb-8'>
            <div className='inline-block w-16 h-16 sm:w-24 sm:h-24 mb-4'>
              <img
                src='/hyt_logo.png'
                alt='HYT Logo'
                className='w-full h-full object-contain'
              />
            </div>
            <h1 className='text-2xl sm:text-3xl font-bold text-white mb-2'>
              Create Account
            </h1>
            <p className='text-yellow-300'>Join HYT Wayfinder</p>
          </div>

          {/* Register Form */}
          <div className='border border-yellow-400/30 rounded-lg p-5 sm:p-8 bg-navy-900/60'>
            <form onSubmit={handleSubmit} className='space-y-5'>
              {/* Error Message */}
              {error && (
                <div className='p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm'>
                  <div className='flex items-start gap-2'>
                    <i className='fa-solid fa-circle-exclamation mt-0.5'></i>
                    <span>{error}</span>
                  </div>

                  {/* An address that already has a login can never register
                      again, so don't leave them on this form with no way out.
                      Signing in repairs a missing profile automatically. */}
                  {/already has an account|already registered/i.test(error) && (
                    <Link
                      href='/login'
                      className='mt-3 inline-flex items-center gap-2 text-yellow-300 hover:text-yellow-200 font-semibold transition-colors'
                    >
                      <i className='fa-solid fa-right-to-bracket'></i>
                      Go to sign in
                    </Link>
                  )}
                </div>
              )}

              {/* Name Field. Three inputs, not one: these are the columns the
                  entrance check matches on. First and last are required; the
                  middle initial is optional and is stored as a single letter. */}
              <div className='grid grid-cols-1 sm:grid-cols-[1fr_4.5rem_1fr] gap-3'>
                <div>
                  <label
                    htmlFor='firstName'
                    className='block text-sm font-medium text-yellow-200 mb-2'
                  >
                    First Name <span className='text-yellow-400'>*</span>
                  </label>
                  <div className='relative'>
                    <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                      <i className='fa-solid fa-user text-yellow-400'></i>
                    </div>
                    <input
                      type='text'
                      id='firstName'
                      value={formData.firstName}
                      onChange={(e) =>
                        setFormData({ ...formData, firstName: e.target.value })
                      }
                      required
                      autoComplete='given-name'
                      className='
                        w-full pl-12 pr-4 py-3 rounded-lg
                        bg-navy-900/80 border-2 border-yellow-500/30
                        text-white placeholder-navy-500
                        focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                        transition-colors
                        '
                      placeholder='Juan'
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor='middleInitial'
                    className='block text-sm font-medium text-yellow-200 mb-2'
                  >
                    M.I.
                  </label>
                  <input
                    type='text'
                    id='middleInitial'
                    value={formData.middleInitial}
                    onChange={(e) =>
                      setFormData({ ...formData, middleInitial: e.target.value })
                    }
                    // Two, so typing "C." is not cut off mid-word. The stored
                    // value is normalised to a single letter.
                    maxLength={2}
                    className='
                      w-full px-2 py-3 rounded-lg text-center
                      bg-navy-900/80 border-2 border-yellow-500/30
                      text-white placeholder-navy-500
                      focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                      transition-colors
                      '
                    placeholder='C.'
                  />
                </div>

                <div>
                  <label
                    htmlFor='lastName'
                    className='block text-sm font-medium text-yellow-200 mb-2'
                  >
                    Last Name <span className='text-yellow-400'>*</span>
                  </label>
                  <div className='relative'>
                    <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                      <i className='fa-solid fa-user text-yellow-400'></i>
                    </div>
                    <input
                      type='text'
                      id='lastName'
                      value={formData.lastName}
                      onChange={(e) =>
                        setFormData({ ...formData, lastName: e.target.value })
                      }
                      required
                      autoComplete='family-name'
                      className='
                        w-full pl-12 pr-4 py-3 rounded-lg
                        bg-navy-900/80 border-2 border-yellow-500/30
                        text-white placeholder-navy-500
                        focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                        transition-colors
                        '
                      placeholder='Dela Cruz'
                    />
                  </div>
                </div>
              </div>

              {/* Email Field */}
              <div>
                <label
                  htmlFor='email'
                  className='block text-sm font-medium text-yellow-200 mb-2'
                >
                  Email Address
                </label>
                <div className='relative'>
                  <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                    <i className='fa-solid fa-envelope text-yellow-400'></i>
                  </div>
                  <input
                    type='email'
                    id='email'
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    required
                    className='
                      w-full pl-12 pr-4 py-3 rounded-lg
                      bg-navy-900/80 border-2 border-yellow-500/30
                      text-white placeholder-navy-500
                      focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                      transition-colors
                      '
                    placeholder='you@example.com'
                  />
                </div>

                {/* Orientation verdict, shown only once the address matches a
                    member of the last cohort. A null result renders nothing: a
                    first-time walk-in has no verdict, and inventing one - or
                    worse, defaulting to 'declined' - would be actively wrong. */}
                {orientation && (
                  <div
                    role='status'
                    aria-live='polite'
                    className={cn(
                      'mt-3 rounded-lg border px-4 py-3',
                      VERDICT_STYLE[orientation.orientation_status].box
                    )}
                  >
                    <p
                      className={cn(
                        'text-sm font-semibold flex items-center gap-2',
                        VERDICT_STYLE[orientation.orientation_status].text
                      )}
                    >
                      <i
                        className={cn(
                          'fa-solid',
                          VERDICT_STYLE[orientation.orientation_status].icon
                        )}
                      ></i>
                      Orientation: {VERDICT_STYLE[orientation.orientation_status].label}
                    </p>
                    <p className='text-navy-300 text-xs mt-1'>
                      Found you from the last orientation
                      {orientation.programme ? ' (' + orientation.programme + ')' : ''}.{' '}
                      {orientation.orientation_status === 'approved'
                        ? 'You are cleared to enter - continue below to finish creating your account.'
                        : orientation.orientation_status === 'declined'
                          ? 'Please speak to the front desk before entering.'
                          : 'Your result is still being processed. Please speak to the front desk.'}
                    </p>
                  </div>
                )}
              </div>

        	  {/* Purpose picker. Also per visit, not per person: the schema puts
                  purpose_id on clock_in_records so a visitor can attend a Meeting
                  one day and an Orientation the next. This seeds the first visit. */}
              <div>
                <label
                  htmlFor='purpose'
                  className='block text-sm font-medium text-yellow-200 mb-2'
                >
                  Purpose <span className='text-yellow-400'>*</span>
                </label>
                <div className='relative'>
                  <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                    <i className='fa-solid fa-clipboard-question text-yellow-400'></i>
                  </div>
                  <select
                    id='purpose'
                    value={formData.purpose}
                    onChange={(e) =>
                      setFormData({ ...formData, purpose: e.target.value })
                    }
                    required
                    className='
                      w-full pl-12 pr-4 py-3 rounded-lg appearance-none
                      bg-navy-900/80 border-2 border-yellow-500/30
                      text-white placeholder-navy-500
                      focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                      transition-colors cursor-pointer
                    '
                  >
                    <option value='' className='bg-navy-900'>
                      Select a purpose
                    </option>
                    {purposes.map((purpose) => (
                      <option
                        key={purpose.id}
                        value={purpose.label}
                        className='bg-navy-900'
                      >
                        {purpose.label}
                      </option>
                    ))}
                  </select>
                  <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                </div>
              </div>

              {/* Visitor profile. Optional, and asked here so the front desk has it before the
                  person reaches the desk. An admin can correct any of it later. */}
              <div className='rounded-lg border border-navy-700 bg-navy-950/40 p-4 space-y-4'>
                <p className='text-sm font-semibold text-yellow-200'>
                  About your visit
                </p>

                <div>
                  <label
                    htmlFor='visitorTypeId'
                    className='block text-sm font-medium text-yellow-200 mb-2'
                  >
                    Visitor type
                  </label>
                  <div className='relative'>
                    <select
                      id='visitorTypeId'
                      value={formData.visitorTypeId}
                      onChange={(e) =>
                        setFormData({ ...formData, visitorTypeId: e.target.value })
                      }
                      className='
                        w-full pl-12 pr-4 py-3 rounded-lg appearance-none
                        bg-navy-900/80 border-2 border-yellow-500/30
                        text-white placeholder-navy-500
                        focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                        transition-colors cursor-pointer
                      '
                    >
                      <option value='' className='bg-navy-900'>
                        Not sure
                      </option>
                      {visitorTypes.map((type) => (
                        <option key={type.id} value={type.id} className='bg-navy-900'>
                          {type.label}
                        </option>
                      ))}
                    </select>
                    <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                      <i className='fa-solid fa-id-card text-yellow-400'></i>
                    </div>
                    <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                  </div>
                </div>

                {/* `host_name` is not asked here: a visitor cannot name the person they are
                    meeting. Staff set it on /admin/users. */}
                {/* Course picker. Required, and persisted on the user row (unlike
                    destination/purpose which are per-visit). A course is a stable
                    attribute of the visitor. */}
                <div>
                  <label
                    htmlFor='courseId'
                    className='block text-sm font-medium text-yellow-200 mb-2'
                  >
                    Course <span className='text-yellow-400'>*</span>
                  </label>
                  <div className='relative'>
                    <select
                      id='courseId'
                      value={formData.courseId}
                      onChange={(e) =>
                        setFormData({ ...formData, courseId: e.target.value })
                      }
                      required
                      className='
                        w-full pl-12 pr-4 py-3 rounded-lg appearance-none
                        bg-navy-900/80 border-2 border-yellow-500/30
                        text-white placeholder-navy-500
                        focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                        transition-colors cursor-pointer
                      '
                    >
                      <option value='' className='bg-navy-900'>
                        Select a course
                      </option>
                      {courses.map((course) => (
                        <option key={course.id} value={course.id} className='bg-navy-900'>
                          {course.label}
                        </option>
                      ))}
                    </select>
                    <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                      <i className='fa-solid fa-graduation-cap text-yellow-400'></i>
                    </div>
                    <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                  </div>
		
		  <div>
                <label
                  htmlFor='destination'
                  className='block text-sm font-medium text-yellow-200 mb-2'
                >
                  Assigned room
                </label>
                <div className='relative'>
                  <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                    <i className='fa-solid fa-location-dot text-yellow-400'></i>
                  </div>
                  <select
                    id='destination'
                    value={formData.destination}
                    disabled
		    className='
                      w-full pl-12 pr-4 py-3 rounded-lg appearance-none
                      bg-navy-900/80 border-2 border-yellow-500/30
                      text-white placeholder-navy-500
                      transition-colors
                      disabled:cursor-not-allowed disabled:opacity-70
                      '
                  >
                    <option value=''>No assigned room</option>
                    {/* The options still come from the `rooms` table, so a room added
                        in /admin/rooms shows up here immediately. The VALUE is the room
                        number because that is what `getRoomByNumber` resolves at
                        check-in; the LABEL is the room name, which is what a person
                        recognises. Read-only: the room follows the course. */}
                    {rooms.map((room) => (
                      <option key={room.id} value={room.roomNumber} className='bg-navy-900'>
                        {room.name} ({room.roomNumber})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

                </div>

                {/* Two-up on wider screens, stacked on a phone. */}
                <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
                  <div>
                    <label
                      htmlFor='company'
                      className='block text-sm font-medium text-yellow-200 mb-2'
                    >
                      Company / school
                    </label>
                    <div className='relative'>
                      <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                        <i className='fa-solid fa-building text-yellow-400'></i>
                      </div>
                      <input
                        type='text'
                        id='company'
                        value={formData.company}
                        onChange={(e) =>
                          setFormData({ ...formData, company: e.target.value })
                        }
                        placeholder='Optional'
                        className='
                          w-full pl-12 pr-4 py-3 rounded-lg
                          bg-navy-900/80 border-2 border-yellow-500/30
                          text-white placeholder-navy-500
                          focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                          transition-colors
                        '
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor='phone'
                      className='block text-sm font-medium text-yellow-200 mb-2'
                    >
                      Phone
                    </label>
                    <div className='relative'>
                      <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                        <i className='fa-solid fa-phone text-yellow-400'></i>
                      </div>
                      <input
                        type='tel'
                        id='phone'
                        inputMode='tel'
                        autoComplete='tel'
                        value={formData.phone}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            phone: sanitisePhone(e.target.value),
                          }))
                        }
                        // Blocks the keystroke outright; onChange sanitises, which is
                        // what catches a paste since keydown does not fire for it.
                        onKeyDown={(e) => {
                          if (!isAllowedPhoneKey(e.key, e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                          }
                        }}
                        // Grouping runs on BLUR, not on every keystroke. Regrouping
                        // mid-type reorders characters and drags the caret backwards
                        // over what was just typed; on blur there is no caret to move.
                        onBlur={() =>
                          setFormData((prev) => ({
                            ...prev,
                            phone: formatPhone(prev.phone),
                          }))
                        }
                        placeholder='Optional'
                        className='
                          w-full pl-12 pr-4 py-3 rounded-lg
                          bg-navy-900/80 border-2 border-yellow-500/30
                          text-white placeholder-navy-500
                          focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                          transition-colors
                        '
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/*
                Password fields - commented out, not deleted.

                Visitors no longer set a password: they sign in through /verify
                with their first and last name and their course. Supabase still
                needs a password to create the auth user, so handleSubmit
                generates a throwaway (see `generatedPassword`). To restore these
                fields, uncomment this block and the two password checks in
                handleSubmit.

              Password Field

              <div>
                <label
                  htmlFor='password'
                  className='block text-sm font-medium text-yellow-200 mb-2'
                >
                  Password
                </label>
                <div className='relative'>
                  <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                    <i className='fa-solid fa-lock text-yellow-400'></i>
                  </div>
                  <input
                    type='password'
                    id='password'
                    value={formData.password}
                    onChange={(e) =>
                      setFormData({ ...formData, password: e.target.value })
                    }
                    required
                    className='
                      w-full pl-12 pr-4 py-3 rounded-lg
                      bg-navy-900/80 border-2 border-yellow-500/30
                      text-white placeholder-navy-500
                      focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                      transition-colors
                      '
                    placeholder='••••••••'
                  />
                </div>
              </div>

              Confirm Password Field

              <div>
                <label
                  htmlFor='confirmPassword'
                  className='block text-sm font-medium text-yellow-200 mb-2'
                >
                  Confirm Password
                </label>
                <div className='relative'>
                  <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                    <i className='fa-solid fa-lock text-yellow-400'></i>
                  </div>
                  <input
                    type='password'
                    id='confirmPassword'
                    value={formData.confirmPassword}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        confirmPassword: e.target.value,
                      })
                    }
                    required
                    className='
                      w-full pl-12 pr-4 py-3 rounded-lg
                      bg-navy-900/80 border-2 border-yellow-500/30
                      text-white placeholder-navy-500
                      focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                      transition-colors
                      '
                    placeholder='••••••••'
                  />
                </div>
              </div>
              */}

              {/* Submit Button. Sticky on a phone: the form is long and
                  the page is centred, so a plain button can sit far below
                  the fold and out of reach. */}
              <button
                type='submit'
                disabled={loading}
                className='
                  sticky bottom-4 z-10 sm:static sm:z-auto
                  w-full py-3 rounded-lg font-semibold text-yellow-950
                  bg-yellow-500 hover:bg-yellow-600
                  transition-colors duration-150
                  disabled:opacity-50 disabled:cursor-not-allowed
                  flex items-center justify-center gap-2
                  border border-yellow-500/50
                  shadow-lg shadow-black/40 sm:static sm:shadow-none
                  '
              >
                {loading ? (
                  <>
                    <i className='fa-solid fa-spinner fa-spin'></i>
                    <span>Creating Account...</span>
                  </>
                ) : (
                  <>
                    <i className='fa-solid fa-user-plus'></i>
                    <span>Create Account</span>
                  </>
                )}
              </button>
            </form>

            {/* Login Link */}
            <div className='mt-6 text-center text-sm text-navy-300'>
              Already registered?{' '}
              <Link
                href='/verify'
                className='text-yellow-400 hover:text-yellow-300 font-semibold transition-colors'
              >
                Verify
              </Link>
            </div>
          </div>
        </div>
      </div>
      )}
    </>
  );
}
