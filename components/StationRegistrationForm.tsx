'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoomsStore } from '@/store/roomsStore';
import { formatPhone, sanitisePhone, isAllowedPhoneKey } from '@/lib/phone';
import { composeFullName } from '@/lib/fullName';

const INPUT =
  'w-full px-4 py-2.5 rounded-lg bg-navy-950/60 border border-navy-700 text-white placeholder-navy-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500 transition-colors';

const LABEL = 'block text-sm font-medium text-navy-200 mb-1.5';

type FormState = {
  firstName: string;
  middleInitial: string;
  lastName: string;
  email: string;
  password: string;
  visitorTypeId: string;
  courseId: string;
  company: string;
  phone: string;
  pendingRoomId: string;
  pendingPurposeId: string;
  /** `yyyy-mm-dd`, what an `<input type="date">` produces. */
  validUntil: string;
};

const EMPTY: FormState = {
  firstName: '',
  middleInitial: '',
  lastName: '',
  email: '',
  // Pre-filled so the desk can hand over credentials without inventing one.
  // Not a secret: the pass is day-scoped by `validUntil`, and the visitor is
  // expected to change it after their first sign-in.
  password: 'Hyt@2026',
  visitorTypeId: '',
  courseId: '',
  company: '',
  phone: '',
  pendingRoomId: '',
  pendingPurposeId: '',
  validUntil: '',
};

/**
 * Front-desk registration.
 *
 * Replaces the QR scan as the way someone becomes a visitor: staff type the
 * details once, the account is created through /api/admin/users, and the person
 * is registered without scanning anything.
 *
 * Lives on the admin-only station rather than /check-in on purpose - minting an
 * account is privileged, and /check-in is reachable by any signed-in visitor.
 */
export default function StationRegistrationForm() {
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

  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ name: string; email: string } | null>(null);

  // Whether staff picked a room by hand. Once they have, the course no longer
  // overwrites it. Reset after a successful registration / Clear so the next
  // walk-in auto-fills again from the retained course.
  const roomTouched = useRef(false);

  const purposes = getActivePurposes();
  const visitorTypes = getActiveVisitorTypes();
  const rooms = getActiveRooms();
  const courses = getActiveCourses();

  useEffect(() => {
    fetchPurposes();
    fetchVisitorTypes();
    fetchRooms();
    fetchCourses();
  }, [fetchPurposes, fetchVisitorTypes, fetchRooms, fetchCourses]);

  // Auto-assign the room from the chosen course, unless staff already picked
  // one. Same-value guard so this does not loop as the lists load; pendingRoomId
  // is a dep so the room re-fills after a registration resets it.
  useEffect(() => {
    if (roomTouched.current) return;
    const mapped = getRoomForCourse(form.courseId);
    const next = mapped && rooms.some((r) => r.id === mapped.id) ? mapped.id : '';
    setForm((f) => (f.pendingRoomId === next ? f : { ...f, pendingRoomId: next }));
  }, [form.courseId, form.pendingRoomId, rooms, getRoomForCourse]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Default the pass to today. A walk-in is here now; someone staying longer is
  // changed on the spot. An empty box would mean "never expires", which is the
  // opposite of what a walk-in needs.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const email = form.email.trim().toLowerCase();
    const firstName = form.firstName.trim();
    const lastName = form.lastName.trim();

    if (!firstName || !lastName || !email) {
      setError('First name, last name and email are all required');
      return;
    }
    // Deliberately loose, like the browser's own type=email rather than a strict
    // RFC check: catching a typo here saves a support call, but rejecting a
    // valid address strands someone at the door.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('That email address does not look right');
      return;
    }
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (!form.courseId) {
      setError('Please select a course');
      return;
    }
    if (!form.pendingPurposeId) {
      setError('Please select a purpose');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          middleInitial: form.middleInitial,
          lastName,
          email,
          password: form.password,
          visitorTypeId: form.visitorTypeId || undefined,
          courseId: form.courseId || undefined,
          company: form.company.trim() || undefined,
          phone: form.phone.trim() || undefined,
          pendingRoomId: form.pendingRoomId || undefined,
          pendingPurposeId: form.pendingPurposeId || undefined,
          validUntil: form.validUntil || today,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || 'Could not create the account');
        return;
      }

      setDone({
        name: composeFullName(firstName, form.middleInitial, lastName),
        email,
      });
      // Keep the pickers, clear only who was typed in: a queue of walk-ins
      // should not mean re-choosing the course for each one. Clearing the
      // touched flag lets the retained course re-fill the room for the next one.
      roomTouched.current = false;
      setForm({ ...EMPTY, courseId: form.courseId, visitorTypeId: form.visitorTypeId });
    } catch {
      setError('Network error. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='glass-panel border-navy-800 rounded-lg p-6'>
      <div className='flex items-start justify-between gap-4 mb-1'>
        <h2 className='text-xl font-bold text-white flex items-center gap-2'>
          <i className='fa-solid fa-user-plus text-yellow-400'></i>
          Visitor Registration
        </h2>
        {done && (
          <button
            type='button'
            onClick={() => setDone(null)}
            className='text-navy-400 hover:text-navy-200 text-xs font-semibold'
          >
            Dismiss
          </button>
        )}
      </div>
      <p className='text-navy-300 text-sm mb-5'>
        Register the visitor here instead of scanning. Their account and pass are
        created immediately.
      </p>

      {done && (
        <div className='mb-5 rounded-lg border border-green-500/30 bg-green-500/10 p-4'>
          <p className='text-green-300 font-semibold text-sm flex items-center gap-2'>
            <i className='fa-solid fa-circle-check'></i>
            {done.name} is registered
          </p>
          <p className='text-navy-200 text-sm mt-1'>
            Sign in as <span className='font-mono'>{done.email}</span> with the
            password below.
          </p>
          <p className='text-navy-300 text-xs mt-2'>
            Password: <span className='font-mono'>{form.password}</span> — write
            this down for them now, it is not shown again.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className='space-y-4'>
        {/* Three name fields, not one: these are the columns the entrance
            check matches on. First and last are required; the middle initial
            is optional and is stored as a single letter. */}
        <div className='grid grid-cols-1 sm:grid-cols-[1fr_4.5rem_1fr] gap-3'>
          <div>
            <label className={LABEL} htmlFor='reg-first-name'>
              First name <span className='text-red-400'>*</span>
            </label>
            <input
              id='reg-first-name'
              className={INPUT}
              value={form.firstName}
              onChange={(e) => set('firstName', e.target.value)}
              placeholder='Juan'
              autoComplete='off'
            />
          </div>
          <div>
            <label className={LABEL} htmlFor='reg-middle-initial'>
              M.I.
            </label>
            <input
              id='reg-middle-initial'
              className={`${INPUT} text-center`}
              value={form.middleInitial}
              onChange={(e) => set('middleInitial', e.target.value)}
              // Two, so typing "C." is not cut off mid-word.
              maxLength={2}
              placeholder='C.'
              autoComplete='off'
            />
          </div>
          <div>
            <label className={LABEL} htmlFor='reg-last-name'>
              Last name <span className='text-red-400'>*</span>
            </label>
            <input
              id='reg-last-name'
              className={INPUT}
              value={form.lastName}
              onChange={(e) => set('lastName', e.target.value)}
              placeholder='Dela Cruz'
              autoComplete='off'
            />
          </div>
        </div>
        <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
          <div>
            <label className={LABEL} htmlFor='reg-email'>
              Email <span className='text-red-400'>*</span>
            </label>
            <input
              id='reg-email'
              type='email'
              className={INPUT}
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder='juan@example.com'
              autoComplete='off'
            />
          </div>
        </div>
        <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
          <div>
            <label className={LABEL} htmlFor='reg-course'>
              Course <span className='text-red-400'>*</span>
            </label>
            <select
              id='reg-course'
              className={INPUT}
              value={form.courseId}
              onChange={(e) => set('courseId', e.target.value)}
            >
              <option value=''>Select a course</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor='reg-type'>
              Visitor type
            </label>
            <select
              id='reg-type'
              className={INPUT}
              value={form.visitorTypeId}
              onChange={(e) => set('visitorTypeId', e.target.value)}
            >
              <option value=''>Not specified</option>
              {visitorTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
          <div>
            <label className={LABEL} htmlFor='reg-phone'>
              Phone
            </label>
            <input
              id='reg-phone'
              className={INPUT}
              value={form.phone}
              onChange={(e) =>
                set('phone', formatPhone(sanitisePhone(e.target.value)))
              }
              onKeyDown={(e) => {
                // The helper takes the key and whether ctrl/meta is held, not
                // the event - matching how app/admin/users calls it.
                if (!isAllowedPhoneKey(e.key, e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                }
              }}
              placeholder='09XX XXX XXXX'
              inputMode='numeric'
            />
          </div>
          <div>
            <label className={LABEL} htmlFor='reg-company'>
              Company
            </label>
            <input
              id='reg-company'
              className={INPUT}
              value={form.company}
              onChange={(e) => set('company', e.target.value)}
              placeholder='Optional'
              autoComplete='off'
            />
          </div>
        </div>
        <div className='grid grid-cols-1 md:grid-cols-3 gap-4'>
          <div>
            <label className={LABEL} htmlFor='reg-room'>
              Assigned room
            </label>
            <select
              id='reg-room'
              className={INPUT}
              value={form.pendingRoomId}
              onChange={(e) => {
                // A deliberate choice: stop deriving the room from the course.
                roomTouched.current = true;
                set('pendingRoomId', e.target.value);
              }}
            >
              <option value=''>Not assigned</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.roomNumber}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor='reg-purpose'>
              Purpose <span className='text-red-400'>*</span>
            </label>
            <select
              id='reg-purpose'
              className={INPUT}
              value={form.pendingPurposeId}
              onChange={(e) => set('pendingPurposeId', e.target.value)}
            >
              <option value=''>Select a purpose</option>
              {purposes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor='reg-valid'>
              Pass valid until
            </label>
            <input
              id='reg-valid'
              type='date'
              className={INPUT}
              value={form.validUntil}
              min={today}
              onChange={(e) => set('validUntil', e.target.value)}
            />
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

        <div className='flex flex-col sm:flex-row gap-3 pt-1'>
          <button
            type='submit'
            disabled={busy}
            className='px-5 py-2.5 rounded-lg bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-semibold text-sm transition-colors duration-150 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed'
          >
            {busy ? (
              <>
                <i className='fa-solid fa-spinner fa-spin'></i>
                Creating account
              </>
            ) : (
              <>
                <i className='fa-solid fa-user-check'></i>
                Register Visitor
              </>
            )}
          </button>
          <button
            type='button'
            onClick={() => {
              roomTouched.current = false;
              setForm(EMPTY);
              setError('');
              setDone(null);
            }}
            disabled={busy}
            className='px-5 py-2.5 rounded-lg bg-navy-800 hover:bg-navy-700 text-navy-200 font-semibold text-sm transition-colors duration-150 disabled:opacity-60'
          >
            Clear
          </button>
        </div>
      </form>
    </div>
  );
}