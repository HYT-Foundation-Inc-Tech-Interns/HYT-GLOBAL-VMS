'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { useRoomsStore } from '@/store/roomsStore';
import { tidyPhone, formatPhone, sanitisePhone, isAllowedPhoneKey } from '@/lib/phone';
import {
  useUsersStore,
  isPassExpired,
  type ManagedUser,
} from '@/store/usersStore';
import { visitorTypeStyle } from '@/lib/visitorTypeStyles';
import UserProfile from '@/components/UserProfile';

const INPUT =
  'w-full px-4 py-2.5 rounded-lg bg-navy-950/60 border border-navy-700 text-white placeholder-navy-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500 transition-colors';

type FormState = {
  name: string;
  email: string;
  password: string;
  visitorTypeId: string;
  company: string;
  phone: string;
  /** Room id (rooms.id), or '' for none. Seeds the first attendance record. */
  pendingRoomId: string;
  /** Purpose id (purposes.id), or '' for none. */
  pendingPurposeId: string;
  /** Course id (courses.id), or '' for none. Required when creating. */
  courseId: string;
  /** `yyyy-mm-dd`, the format an `<input type="date">` produces. */
  validUntil: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  email: '',
  password: '',
  visitorTypeId: '',
  company: '',
  phone: '',
  pendingRoomId: '',
  pendingPurposeId: '',
  courseId: '',
  validUntil: '',
};

/** `Date` -> `yyyy-mm-dd` for a date input, in local time (not UTC). */
function toDateInputValue(date: Date | null): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * "Joined" as a plain date. The previous relative format ("2 days ago") drifts
 * out of date the moment the page sits open, which matters on a registration
 * desk where the list is left up all day.
 */
const formatDate = (date: Date) =>
  date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export default function UsersPage() {
  const router = useRouter();
  const { user: currentUser, isAuthenticated } = useAuthStore();
  const {
    fetchVisitorTypes,
    getActiveVisitorTypes,
    fetchRooms,
    getActiveRooms,
    fetchPurposes,
    getActivePurposes,
    fetchCourses,
    getActiveCourses,
    getRoomForCourse,
  } = useRoomsStore();
  const {
    users,
    archivedUsers,
    isLoading,
    fetchUsers,
    createUser,
    updateUser,
    archiveUser,
    restoreUser,
    getCountByVisitorType,
    getExpiredCount,
  } = useUsersStore();

  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [showArchived, setShowArchived] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Whether the admin picked a room by hand in the create modal. Once they
  // have, the course no longer overwrites it.
  const roomTouched = useRef(false);

  const visitorTypes = getActiveVisitorTypes();
  // Rooms and purposes back the assigned-room and purpose pickers, which mirror
  // the register form. Both are ordered by the store (rooms by floor).
  const rooms = getActiveRooms();
  const purposes = getActivePurposes();
  const courses = getActiveCourses();
  const typeCounts = getCountByVisitorType();
  const expiredCount = getExpiredCount();

  useEffect(() => {
    if (!isAuthenticated || currentUser?.role !== 'admin') {
      router.push('/login');
    } else {
      fetchUsers();
      fetchVisitorTypes();
      fetchRooms();
      fetchPurposes();
      fetchCourses();
    }
  }, [
    isAuthenticated,
    currentUser,
    router,
    fetchUsers,
    fetchVisitorTypes,
    fetchRooms,
    fetchPurposes,
    fetchCourses,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Auto-assign the room from the chosen course, but ONLY when creating. On
  // edit the room is left exactly as stored: auto-filling there would write a
  // pending_room_id for existing users, which is a backfill this feature
  // deliberately avoids (existing users derive their room at runtime instead).
  useEffect(() => {
    if (editing || roomTouched.current) return;
    const mapped = getRoomForCourse(form.courseId);
    const next = mapped && rooms.some((r) => r.id === mapped.id) ? mapped.id : '';
    setForm((f) => (f.pendingRoomId === next ? f : { ...f, pendingRoomId: next }));
  }, [editing, form.courseId, rooms, getRoomForCourse]);

  // Archived rows are searched with the same filter as the active list so the
  // two views cannot drift apart.
  const source = showArchived ? archivedUsers : users;

  const filteredUsers = useMemo(
    () =>
      source.filter((u) => {
        const term = searchTerm.trim().toLowerCase();
        // Room and purpose are searchable by their display text, not their ids,
        // so "Room 304" or "Orientation" finds the person. Resolved through the
        // same lists the table renders from.
        const room = rooms.find((r) => r.id === u.pendingRoomId);
        const purpose = purposes.find((p) => p.id === u.pendingPurposeId);

        const matchesSearch =
          !term ||
          u.name.toLowerCase().includes(term) ||
          // Nullable since migration 20260101000014: roster rows with no address
          // have NULL here. Calling .toLowerCase() unguarded throws and takes the
          // ENTIRE list down, not just this row - one keystroke in the search box
          // would blank the admin page.
          (u.email ?? '').toLowerCase().includes(term) ||
          (u.company ?? '').toLowerCase().includes(term) ||
          // Still searched even though it is no longer editable: legacy rows may
          // carry a host name, and staff looking someone up should still find them.
          (u.hostName ?? '').toLowerCase().includes(term) ||
          (room?.name ?? '').toLowerCase().includes(term) ||
          (room?.roomNumber ?? '').toLowerCase().includes(term) ||
          (purpose?.label ?? '').toLowerCase().includes(term);

        const matchesType =
          typeFilter === 'all' ||
          (typeFilter === '__none' ? u.visitorType === null : u.visitorType === typeFilter);

        return matchesSearch && matchesType;
      }),
    [source, searchTerm, typeFilter, rooms, purposes]
  );

  if (!isAuthenticated || currentUser?.role !== 'admin') {
    return null;
  }

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    // A fresh create: let the course drive the room again.
    roomTouched.current = false;
    setIsModalOpen(true);
  };

  const openEdit = (target: ManagedUser) => {
    setEditing(target);
    setForm({
      name: target.name,
      // Nullable since 20260101000014; the form's own field stays a string
      // because an admin editing this person is expected to supply an address.
      email: target.email ?? '',
      password: '',
      visitorTypeId: target.visitorType
        ? (visitorTypes.find((t) => t.label === target.visitorType)?.id ?? '')
        : '',
      company: target.company ?? '',
      phone: target.phone ?? '',
      pendingRoomId: target.pendingRoomId ?? '',
      pendingPurposeId: target.pendingPurposeId ?? '',
      courseId: target.courseId ?? '',
      validUntil: toDateInputValue(target.validUntil),
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) return setFormError('Name is required.');
    if (!form.email.trim()) return setFormError('Email is required.');
    if (!editing && form.password.length < 6) {
      return setFormError('Password must be at least 6 characters.');
    }
    if (!editing && !form.courseId) {
      return setFormError('Please select a course.');
    }
    if (!form.pendingPurposeId) {
      return setFormError('Please select a purpose.');
    }

    setIsSaving(true);

    // Shared between create and edit so the two paths cannot drift on which fields
// are sent. Empty strings are meaningful: the server turns them into SQL NULL,
// which is how a field gets cleared.
const profileFields = () => ({
  visitorTypeId: form.visitorTypeId,
  company: form.company,
  phone: form.phone,
  pendingRoomId: form.pendingRoomId,
  pendingPurposeId: form.pendingPurposeId,
  courseId: form.courseId,
  validUntil: form.validUntil,
});

if (editing) {
      const { success, error } = await updateUser(editing.id, {
        name: form.name.trim(),
        email: form.email.trim(),
        ...profileFields(),
      });
      setIsSaving(false);
      if (!success) return setFormError(error || 'Could not save changes.');
      closeModal();
      setNotice({ kind: 'success', text: `Updated ${form.name.trim()}.` });
      return;
    }

    const { success, error } = await createUser({
      name: form.name.trim(),
      email: form.email.trim(),
      password: form.password,
      ...profileFields(),
    });
    setIsSaving(false);
    if (!success) return setFormError(error || 'Could not create the user.');
    closeModal();
    setNotice({ kind: 'success', text: `Created ${form.name.trim()}.` });
  };

  const confirmArchive = async () => {
    if (!deleteTarget) return;
    const { success, error } = await archiveUser(deleteTarget.id);
    const name = deleteTarget.name;
    setDeleteTarget(null);
    setNotice(
      success
        ? {
            kind: 'success',
            text: `Archived ${name}. Their login is revoked and their visit history is kept.`,
          }
        : { kind: 'error', text: error || 'Could not archive the user.' }
    );
  };

  const confirmRestore = async (target: ManagedUser) => {
    const { success, error } = await restoreUser(target.id);
    setNotice(
      success
        ? { kind: 'success', text: `Restored ${target.name}.` }
        : { kind: 'error', text: error || 'Could not restore the user.' }
    );
  };

  return (
    <>
      <div className='min-h-screen'>
        <header className='app-header border-b sticky top-0 z-40'>
          <div className='max-w-7xl mx-auto px-4 py-3 flex items-center justify-between'>
            <Link href='/admin' className='flex items-center gap-3'>
              <div className='w-12 h-12 flex items-center justify-center overflow-hidden'>
                <img
                  src='/hyt_logo.png'
                  alt='HYT Logo'
                  className='w-full h-full object-contain'
                />
              </div>
              <div>
                <h1 className='text-white font-bold text-lg leading-none'>
                  User Management
                </h1>
                <p className='text-navy-300 text-xs mt-0.5'>Manage accounts and roles</p>
              </div>
            </Link>
            <UserProfile />
          </div>
        </header>

        <main className='max-w-7xl mx-auto px-4 py-5'>
          <div className='flex flex-wrap items-center justify-between gap-3 mb-6'>
            <Link
              href='/admin'
              className='text-navy-300 hover:text-navy-200 flex items-center gap-2 transition-colors'
            >
              <i className='fa-solid fa-arrow-left'></i>
              <span>Back to Dashboard</span>
            </Link>
            <button
              onClick={openCreate}
              className='px-4 py-2 rounded-lg bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-semibold text-sm transition-colors flex items-center gap-2'
            >
              <i className='fa-solid fa-user-plus'></i>
              Add User
            </button>
          </div>

          {/* Total Users. Given the same prominence as on the dashboard, since it's the
              headline number for this page; the role counts below are the
              breakdown of it. */}
          <div className='mb-3'>
            <div className='glass-panel border-yellow-500/30 rounded-lg p-6'>
              <div className='flex items-center gap-5'>
                <div className='w-16 h-16 rounded-xl bg-yellow-500/20 flex items-center justify-center flex-shrink-0'>
                  <i className='fa-solid fa-users text-yellow-400 text-3xl'></i>
                </div>
                <div className='min-w-0'>
                  <p className='text-yellow-300 text-xs font-semibold uppercase tracking-wider mb-1'>
                    Total Users
                  </p>
                  <p className='text-white text-5xl font-bold leading-none tabular-nums'>
                    {users.length}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Headline counts. Visitor types rather than roles, because that is the
              question worth asking at an event: how many trainees, trainers and
              VIPs are on the list. "Expired" is surfaced because an out-of-date
              pass is the thing most likely to go unnoticed until it matters. */}
          <div className='grid grid-cols-2 md:grid-cols-4 gap-3 mb-6'>
            <div className='glass-panel border-navy-800 p-4 rounded-lg'>
              <p className='text-navy-300 text-xs mb-1'>Active visitors</p>
              <p className='text-white text-2xl font-bold'>{users.length}</p>
            </div>
            {typeCounts.slice(0, 2).map(({ label, count }) => (
              <div key={label} className='glass-panel border-navy-800 p-4 rounded-lg'>
                <p className='text-navy-300 text-xs mb-1'>{label}s</p>
                <p className='text-white text-2xl font-bold'>{count}</p>
              </div>
            ))}
            <div className='glass-panel border-navy-800 p-4 rounded-lg'>
              <p className='text-navy-300 text-xs mb-1'>Expired passes</p>
              <p
                className={`text-2xl font-bold ${
                  expiredCount > 0 ? 'text-red-400' : 'text-white'
                }`}
              >
                {expiredCount}
              </p>
            </div>
          </div>

          {notice && (
            <div
              className={`mb-4 px-4 py-3 rounded-lg border text-sm flex items-center gap-2 ${notice.kind === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}
            >
              <i
                className={`fa-solid ${notice.kind === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}`}
              ></i>
              {notice.text}
            </div>
          )}

          <div className='glass-panel border-navy-800 rounded-lg p-4 mb-6'>
            <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Search
                </label>
                <div className='relative'>
                  <div className='absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none'>
                    <i className='fa-solid fa-magnifying-glass text-navy-500'></i>
                  </div>
                  <input
                    type='text'
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder='Search name, email, room, or purpose...'
                    className='w-full pl-12 pr-4 py-2.5 rounded-lg bg-navy-900/50 border border-navy-700 text-white placeholder-navy-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500 transition-colors'
                  />
                </div>
              </div>
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Visitor type
                </label>
                <div className='flex flex-wrap gap-2'>
                  <button
                    onClick={() => setTypeFilter('all')}
                    className={`px-4 py-2.5 rounded-lg font-semibold text-sm capitalize transition-colors border-2 ${typeFilter === 'all' ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500' : 'bg-navy-900/50 text-navy-300 border-navy-700 hover:border-navy-600'}`}
                  >
                    All ({users.length})
                  </button>
                  {typeCounts.map(({ label, count }) => (
                    <button
                      key={label}
                      onClick={() => setTypeFilter(label)}
                      className={`px-4 py-2.5 rounded-lg font-semibold text-sm capitalize transition-colors border-2 ${typeFilter === label ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500' : 'bg-navy-900/50 text-navy-300 border-navy-700 hover:border-navy-600'}`}
                    >
                      {label} ({count})
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Show
                </label>
                <div className='flex flex-wrap gap-2'>
                  <button
                    onClick={() => setShowArchived(false)}
                    className={`px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border-2 ${!showArchived ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500' : 'bg-navy-900/50 text-navy-300 border-navy-700 hover:border-navy-600'}`}
                  >
                    Active ({users.length})
                  </button>
                  <button
                    onClick={() => setShowArchived(true)}
                    className={`px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors border-2 ${showArchived ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500' : 'bg-navy-900/50 text-navy-300 border-navy-700 hover:border-navy-600'}`}
                  >
                    Archived ({archivedUsers.length})
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className='glass-panel border-navy-800 rounded-lg overflow-hidden'>
            <div className='overflow-x-auto'>
              <table className='w-full'>
                <thead className='bg-navy-900/50 border-b border-navy-800'>
                  <tr>
                    {['Visitor', 'Type', 'Assigned / Purpose', 'Pass', 'Joined', 'Actions'].map(
                      (heading) => (
                        <th
                          key={heading}
                          className='px-4 py-3 text-left text-xs font-semibold text-navy-400 uppercase tracking-wider'
                        >
                          {heading}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody className='divide-y divide-navy-800'>
                  {filteredUsers.map((u) => {
                    const expired = isPassExpired(u);
                    return (
                      <tr
                        key={u.id}
                        className={`transition-colors ${
                          expired
                            ? 'bg-black/60 hover:bg-blue-500/20'
                            : // Brighter blue hover on valid rows so they
                              // stand out against the dimmed expired ones.
                              'hover:bg-blue-500/20'
                        }`}
                      >
                        {/* Expired rows are dimmed as a unit via the row
                            background and dimmed text on the info cells, NOT
                            via `opacity` on the <tr>. CSS opacity stacks, so a
                            child's `opacity:1` cannot undo a parent's
                            `opacity:0.6` — using opacity on the row would dim
                            the action buttons too, with no way to un-dim them.
                            The buttons below keep their own colours and stay
                            full-bright on the dimmed row. */}
                        <td
                          className={`px-4 py-3 ${expired ? 'opacity-30' : ''}`}
                        >
                          <div className='flex items-center gap-3'>
                            <div className='w-9 h-9 rounded-lg bg-yellow-500/20 flex items-center justify-center flex-shrink-0'>
                              <i className='fa-solid fa-user text-yellow-400'></i>
                            </div>
                            <div className='min-w-0'>
                              <p className='text-white font-semibold text-sm'>{u.name}</p>
                              <p className='text-navy-500 text-xs truncate'>
                            {/* 'No email on file' rather than a blank line: a
                                silent gap reads as a rendering bug, and this is
                                the registrar's cue to collect an address. */}
                            {u.email ?? 'No email on file'}
                          </p>
                              {u.phone && (
                                // Tidied on display as well, so rows typed before
                                // this existed read the same as new ones. The stored
                                // value is never rewritten by this.
                                <p className='text-navy-500 text-xs truncate'>
                                  {tidyPhone(u.phone)}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td
                          className={`px-4 py-3 ${expired ? 'opacity-30' : ''}`}
                        >
                          <span
                            className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${visitorTypeStyle(u.visitorType)}`}
                          >
                            {u.visitorType ?? 'Unclassified'}
                          </span>
                        </td>
                        {/* What this person is expected to be here for. Room and purpose are the two
                            things staff now assign, so they are what the list shows
                            in the primary slot; company is secondary context.
                            Resolved from the rooms/purposes lists already loaded on
                            this page. */}
                        <td
                          className={`px-4 py-3 text-sm ${expired ? 'opacity-30' : ''}`}
                        >
                          {(() => {
                            const room = rooms.find((r) => r.id === u.pendingRoomId);
                            const purpose = purposes.find(
                              (p) => p.id === u.pendingPurposeId
                            );

                            if (!room && !purpose) {
                              return <p className='text-navy-500'>-</p>;
                            }

                            return (
                              <>
                                {room && (
                                  <p className='text-white'>
                                    {room.name}
                                    <span className='text-navy-500 text-xs'>
                                      {' '}
                                      {room.roomNumber}
                                    </span>
                                  </p>
                                )}
                                {purpose && (
                                  <p className='text-navy-400 text-xs'>
                                    {purpose.label}
                                  </p>
                                )}
                              </>
                            );
                          })()}
                          {u.company && (
                            <p className='text-navy-500 text-xs truncate'>
                              {u.company}
                            </p>
                          )}
                        </td>
                        <td
                          className={`px-4 py-3 whitespace-nowrap text-sm ${expired ? 'opacity-30' : ''}`}
                        >
                          {u.validUntil ? (
                            <span className={expired ? 'text-red-400' : 'text-navy-300'}>
                              {expired ? 'Expired ' : ''}
                              {formatDate(u.validUntil)}
                            </span>
                          ) : (
                            <span className='text-navy-500'>No expiry</span>
                          )}
                        </td>
                        <td
                          className={`px-4 py-3 whitespace-nowrap text-navy-300 text-sm ${expired ? 'opacity-30' : ''}`}
                        >
                          {formatDate(u.createdAt)}
                        </td>
                        {/* Actions cell is deliberately NOT dimmed. The buttons
                            keep their own colours so they stay readable and
                            clickable on the dimmed row. */}
                        <td className='px-4 py-3'>
                          <div className='flex items-center gap-2'>
                            <button
                              onClick={() => openEdit(u)}
                              className='px-3 py-1.5 rounded-lg bg-navy-800 border border-navy-700 text-navy-200 hover:bg-navy-700 hover:text-white text-xs font-semibold transition-colors'
                            >
                              Edit
                            </button>
                            {showArchived ? (
                              <button
                                onClick={() => confirmRestore(u)}
                                className='px-3 py-1.5 rounded-lg bg-green-600 border border-green-500/30 text-paper hover:bg-green-700 text-xs font-semibold transition-colors'
                              >
                                Restore
                              </button>
                            ) : (
                              <button
                                onClick={() => setDeleteTarget(u)}
                                title='Revoke access and archive this visitor'
                                className='px-3 py-1.5 rounded-lg bg-red-600 border border-red-500/30 text-paper hover:bg-red-700 text-xs font-semibold transition-colors'
                              >
                                Archive
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {!isLoading && filteredUsers.length === 0 && (
                <div className='text-center py-12'>
                  <i className='fa-solid fa-users text-navy-600 text-4xl mb-3'></i>
                  <p className='text-navy-300'>
                    {showArchived ? 'No archived users' : 'No users found'}
                  </p>
                  {!showArchived && users.length === 0 && (
                    <p className='text-navy-500 text-sm mt-1'>
                      Add your first user to get started
                    </p>
                  )}
                </div>
              )}

              {isLoading && users.length === 0 && (
                <div className='text-center py-12'>
                  <i className='fa-solid fa-spinner fa-spin text-yellow-400 text-2xl'></i>
                  <p className='text-navy-300 mt-2'>Loading users...</p>
                </div>
              )}
            </div>
          </div>

          <div className='mt-4 text-center text-navy-400 text-sm'>
            Showing {filteredUsers.length} of {source.length}{' '}
            {showArchived ? 'archived' : 'active'} visitors
            {expiredCount > 0 && !showArchived && ` · ${expiredCount} with an expired pass`}
          </div>
        </main>
      </div>

      {isModalOpen && (
        // `items-start` on small screens so a long form scrolls from the top
        // instead of being vertically centred and clipped at both ends.
        <div className='fixed inset-0 z-50 flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto'>
          <div
            className='fixed inset-0 bg-black/60'
            onClick={closeModal}
            aria-hidden='true'
          ></div>
          {/* max-h + internal scroll. The form grew from 3 fields to 10, which
              no longer fits a viewport, and a modal that runs off the bottom of
              the screen cannot be submitted from. `sm:my-8` gives the scroll
              container breathing room once the modal is height-capped. */}
          <div className='relative w-full sm:max-w-md bg-navy-900 border border-navy-700 sm:rounded-lg my-0 sm:my-8 max-h-[100dvh] sm:max-h-[calc(100dvh-4rem)] flex flex-col'>
            <div className='px-4 py-3 border-b border-navy-700 flex items-center justify-between flex-shrink-0'>
              <h2 className='text-white font-bold'>
                {editing ? 'Edit Visitor' : 'Add Visitor'}
              </h2>
              <button
                onClick={closeModal}
                className='text-navy-400 hover:text-white transition-colors'
                aria-label='Close'
              >
                <i className='fa-solid fa-xmark'></i>
              </button>
            </div>
            {/* The form is a flex column: a scrollable field region and a fixed footer.
                Both need to be children of the form, and the footer must not be
                inside the scroll container, or Cancel/Save scroll out of reach. */}
            <form
              onSubmit={handleSubmit}
              className='flex flex-col min-h-0 flex-1'
            >
              <div className='p-4 space-y-3 overflow-y-auto flex-1 min-h-0 overscroll-contain'>
              {formError && (
                <div className='p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm'>
                  {formError}
                </div>
              )}
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Name
                </label>
                <input
                  type='text'
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className={INPUT}
                />
              </div>
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Email
                </label>
                <input
                  type='email'
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                  className={INPUT}
                />
              </div>
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Visitor type
                </label>
                <div className='relative'>
                  <select
                    value={form.visitorTypeId}
                    onChange={(e) =>
                      setForm({ ...form, visitorTypeId: e.target.value })
                    }
                    className={`${INPUT} appearance-none cursor-pointer`}
                  >
                    <option value='' className='bg-navy-900'>
                      Unclassified
                    </option>
                    {visitorTypes.map((type) => (
                      <option key={type.id} value={type.id} className='bg-navy-900'>
                        {type.label}
                      </option>
                    ))}
                  </select>
                  <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                </div>
                {/* Reassurance that this changes nothing about permissions: the
                    trainer/trainee *roles* were removed for exactly this reason. */}
                <p className='text-navy-500 text-xs mt-1'>
                  Descriptive only. Everyone here is a visitor with the same access -
                  this is here so you can count who came to the orientation.
                </p>
              </div>

              {/* Assigned room. Same picker as the register form, but storing the
                  room id rather than the number: this value is persisted on
                  `users.pending_room_id` (migration 007) and resolved to a room at
                  check-in. The register form keeps the number in the visitor's
                  session instead, so the two differ deliberately. */}
              <div>
                <label
                  htmlFor='pendingRoomId'
                  className='block text-sm font-medium text-navy-200 mb-2'
                >
                  Assigned room
                </label>
                <div className='relative'>
                  <select
                    id='pendingRoomId'
                    value={form.pendingRoomId}
                    onChange={(e) => {
                      // A deliberate choice: stop deriving the room from the course.
                      roomTouched.current = true;
                      setForm({ ...form, pendingRoomId: e.target.value });
                    }}
                    className={`${INPUT} appearance-none cursor-pointer`}
                  >
                    <option value='' className='bg-navy-900'>
                      No assigned room
                    </option>
                    {rooms.map((room) => (
                      <option key={room.id} value={room.id} className='bg-navy-900'>
                        {room.name} ({room.roomNumber})
                      </option>
                    ))}
                  </select>
                  <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                </div>
                <p className='text-navy-500 text-xs mt-1'>
                  Filled in from the course; you can change it. Applied to their
                  first check-in; after that the room is recorded when they scan
                  a door code.
                </p>
              </div>

              {/* Purpose. Same reasoning as the room above: seeded onto the first
                  attendance record, not a permanent property of the person. */}
              <div>
                <label
                  htmlFor='pendingPurposeId'
                  className='block text-sm font-medium text-navy-200 mb-2'
                >
                  Purpose <span className='text-yellow-400'>*</span>
                </label>
                <div className='relative'>
                  <select
                    id='pendingPurposeId'
                    value={form.pendingPurposeId}
                    onChange={(e) =>
                      setForm({ ...form, pendingPurposeId: e.target.value })
                    }
                    className={`${INPUT} appearance-none cursor-pointer`}
                  >
                    <option value='' className='bg-navy-900'>
                      Select a purpose
                    </option>
                    {purposes.map((purpose) => (
                      <option key={purpose.id} value={purpose.id} className='bg-navy-900'>
                        {purpose.label}
                      </option>
                    ))}
                  </select>
                  <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                </div>
                <p className='text-navy-500 text-xs mt-1'>
                  Applied to their first check-in, and they can pick a
                  different reason on later visits.
                </p>
              </div>

              {/* Course. Unlike room/purpose, this is a permanent attribute of
                  the visitor, persisted on users.course_id. Required when
                  creating; an admin can change it later. */}
              <div>
                <label
                  htmlFor='courseId'
                  className='block text-sm font-medium text-navy-200 mb-2'
                >
                  Course <span className='text-yellow-400'>*</span>
                </label>
                <div className='relative'>
                  <select
                    id='courseId'
                    value={form.courseId}
                    onChange={(e) =>
                      setForm({ ...form, courseId: e.target.value })
                    }
                    className={`${INPUT} appearance-none cursor-pointer`}
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
                  <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-400 text-xs pointer-events-none'></i>
                </div>
              </div>
              {/* `host_name` and `notes` are deliberately not editable here any more, so this
                  form matches what the register form collects: a visitor cannot
                  supply either, so letting staff set them here only created a
                  field one of two paths could fill. Both columns still exist and
                  existing values are still shown in the list above. */}
              <div>
                <label
                  htmlFor='company'
                  className='block text-sm font-medium text-navy-200 mb-2'
                >
                  Company / school
                </label>
                <input
                  id='company'
                  type='text'
                  value={form.company}
                  onChange={(e) => setForm({ ...form, company: e.target.value })}
                  placeholder='e.g. ABC College'
                  className={INPUT}
                />
              </div>
              <div>
                <label
                  htmlFor='phone'
                  className='block text-sm font-medium text-navy-200 mb-2'
                >
                  Phone
                </label>
                <input
                  id='phone'
                  type='tel'
                  inputMode='tel'
                  autoComplete='tel'
                  value={form.phone}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      phone: sanitisePhone(e.target.value),
                    }))
                  }
                  // Block the keystroke rather than filtering it afterwards: a
                  // character that appears and then vanishes reads as a broken
                  // field. onChange still sanitises, which is what catches a paste
                  // (keydown does not fire for pasted content).
                  onKeyDown={(e) => {
                    if (!isAllowedPhoneKey(e.key, e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                    }
                  }}
                  // Grouping runs on BLUR, not on every keystroke. Regrouping
                  // mid-type reorders characters and drags the caret backwards
                  // over what was just typed; on blur there is no caret to move,
                  // so the number is tidied while the field is not being edited.
                  onBlur={() =>
                    setForm((prev) => ({ ...prev, phone: formatPhone(prev.phone) }))
                  }
                  placeholder='For the front desk to call ahead'
                  className={INPUT}
                />
              </div>
              <div>
                <label
                  htmlFor='validUntil'
                  className='block text-sm font-medium text-navy-200 mb-2'
                >
                  Pass valid until
                </label>
                <input
                  id='validUntil'
                  type='date'
                  value={form.validUntil}
                  onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                  className={INPUT}
                />
                <p className='text-navy-500 text-xs mt-1'>
                  Leave empty for a pass that never expires. Expired passes are
                  flagged in the list but their history is kept.
                </p>
              </div>
              {/* See the note above: `notes` is not editable here. */}
              {/* The assigned room and purpose live on `users.pending_room_id` /
                  `pending_purpose_id` (migration 007) as PENDING intent, seeding the
                  first attendance record. The authoritative room and purpose are on
                  `clock_in_records`, one row per visit, because a person can attend a
                  Meeting today and an Orientation next week.

                  Before 007 this form had no room or purpose field at all, because
                  there was nowhere to put them: the register form holds the same two
                  values in the visitor's own session, and an admin creating someone
                  else has no such session. `host_name` and `notes` remain genuinely
                  uneditable — staff can still see them in the list, but the register
                  form does not collect them either. */}
              <p className='text-navy-500 text-xs'>
                Assigned rooms are no longer stored on the account. They are
                recorded per visit when the person checks in.
              </p>
              {!editing && (
                <div>
                  <label className='block text-sm font-medium text-navy-200 mb-2'>
                    Password
                  </label>
                  <input
                    type='password'
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                    minLength={6}
                    placeholder='At least 6 characters'
                    className={INPUT}
                  />
                </div>
              )}
              </div>

              {/* Submit controls sit outside the scroll region. Inside it they
                  would scroll out of reach on a short screen, which means the
                  form cannot be submitted without scrolling back to the bottom. */}
              <div className='p-4 border-t border-navy-700 flex gap-2 flex-shrink-0 bg-navy-900'>
                <button
                  type='button'
                  onClick={closeModal}
                  className='flex-1 px-4 py-2.5 rounded-lg bg-navy-800 border border-navy-700 text-navy-200 hover:bg-navy-700 hover:text-white font-semibold text-sm transition-colors'
                >
                  Cancel
                </button>
                <button
                  type='submit'
                  disabled={isSaving}
                  className='flex-1 px-4 py-2.5 rounded-lg bg-yellow-500 hover:bg-yellow-600 text-yellow-950 font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
                >
                  {isSaving ? 'Saving...' : editing ? 'Save Changes' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className='fixed inset-0 z-50 flex items-center justify-center p-4'>
          <div
            className='absolute inset-0 bg-black/60'
            onClick={() => setDeleteTarget(null)}
            aria-hidden='true'
          ></div>
          <div className='relative w-full max-w-sm bg-navy-900 border border-navy-700 rounded-lg p-4'>
            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center flex-shrink-0'>
                <i className='fa-solid fa-triangle-exclamation text-red-400'></i>
              </div>
              <div>
                <h2 className='text-white font-bold'>Archive user?</h2>
                <p className='text-navy-300 text-sm mt-1'>
                  <span className='text-white font-semibold'>{deleteTarget.name}</span>{' '}
                  will no longer be able to sign in, and will be hidden from this
                  list. Their attendance and room-visit history is kept.
                </p>
              </div>
            </div>
            <div className='flex gap-2 mt-4'>
              <button
                onClick={() => setDeleteTarget(null)}
                className='flex-1 px-4 py-2.5 rounded-lg bg-navy-800 border border-navy-700 text-navy-200 hover:bg-navy-700 hover:text-white font-semibold text-sm transition-colors'
              >
                Cancel
              </button>
              <button
                onClick={confirmArchive}
                className='flex-1 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-paper font-semibold text-sm transition-colors'
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
