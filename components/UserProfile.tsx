'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { visitorTypeStyle } from '@/lib/visitorTypeStyles';
import ThemeToggle from '@/components/ThemeToggle';

// Shared menu-item styling. Kept in one place so the six admin links, the theme
// toggle and the logout row all get the same yellow hover/active/focus
// treatment instead of drifting apart.
const MENU_ITEM =
  'w-full px-4 py-2.5 rounded-lg text-left text-navy-200 hover:bg-yellow-500/10 hover:text-white active:bg-yellow-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500/60 transition-colors flex items-center gap-3';

// Visitors with no visitor_type fall back to this, mirroring the "Guest" colour
// the register form picks by default. Keeps the chip readable when
// `visitor_types` has not loaded yet.
const DEFAULT_VISITOR_STYLE =
  'bg-purple-500/20 text-purple-300 border-purple-500/30';

export default function UserProfile() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!user) return null;

  // Visitors and admins both land back on the entrance screen. /login is now
  // admin-only and is reached by direct URL (or the hidden name shortcut on
  // /verify), so it is no longer the post-logout destination.
  const handleLogout = () => {
    logout();
    router.push('/verify');
  };

  // Admin keeps the red shield badge. Visitors wear the colour of their
  // `visitor_type_id` label (Trainee/Trainer/VIP/...), falling back to the
  // neutral purple "visitor" chip when unclassified. The label shown next to
  // the avatar mirrors the same choice.
  const isAdmin = user.role === 'admin';
  const badgeLabel = isAdmin ? 'admin' : user.visitorType ?? 'visitor';
  const badgeClasses = isAdmin
    ? 'bg-red-500/20 text-red-300 border-red-500/30'
    : user.visitorType
      ? visitorTypeStyle(user.visitorType)
      : DEFAULT_VISITOR_STYLE;
  const badgeIcon = isAdmin ? 'fa-user-shield' : 'fa-id-card';

  return (
    <div className='relative' ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className='flex items-center gap-3 px-3 py-2 rounded-lg bg-yellow-500/20 hover:bg-yellow-500/30 active:bg-yellow-500/40 border border-yellow-500/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500/60'
      >
        {/* Avatar tile. `bg-navy-900/40` reads as a recess on the trigger in
            both themes instead of a second colour block. */}
        <div className='w-10 h-10 rounded-lg bg-navy-900/40 flex items-center justify-center'>
          <i className={`fa-solid ${badgeIcon} text-yellow-400`}></i>
        </div>
        <div className='hidden md:block text-left'>
          <p className='text-white font-semibold text-sm leading-tight'>{user.name}</p>
          <p className='text-navy-300 text-xs capitalize'>{badgeLabel}</p>
        </div>
        <i
          className={`fa-solid fa-chevron-down text-navy-300 text-xs transition-transform ${isOpen ? 'rotate-180' : ''}`}
        ></i>
      </button>

      {isOpen && (
        <div className='absolute right-0 mt-2 w-64 bg-navy-900 border border-yellow-500/30 rounded-lg shadow-lg shadow-black/10 overflow-hidden animate-fade-in z-50'>
          {/* Profile Header */}
          <div className='p-4 border-b border-yellow-500/20 bg-yellow-500/10'>
            <div className='flex items-center gap-3 mb-3'>
              <div className='w-12 h-12 rounded-lg bg-yellow-500/20 flex items-center justify-center'>
                <i className={`fa-solid ${badgeIcon} text-yellow-400 text-xl`}></i>
              </div>
              <div className='flex-1'>
                <p className='text-white font-semibold'>{user.name}</p>
                <p className='text-navy-300 text-sm'>{user.email}</p>
              </div>
            </div>
            <div
              className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border ${badgeClasses}`}
            >
              <i className={`fa-solid ${badgeIcon}`}></i>
              <span className='capitalize'>{badgeLabel}</span>
            </div>
          </div>

          {/* Menu Items (admins only) */}
          {user.role === 'admin' && (
            <div className='p-2'>
              <button
                onClick={() => {
                  setIsOpen(false);
                  router.push('/admin');
                }}
                className={MENU_ITEM}
              >
                <i className='fa-solid fa-chart-line w-5 text-yellow-400'></i>
                <span>Dashboard</span>
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  router.push('/admin/room-records');
                }}
                className={MENU_ITEM}
              >
                <i className='fa-solid fa-table w-5 text-yellow-400'></i>
                <span>Room Visits Records</span>
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  router.push('/admin/records');
                }}
                className={MENU_ITEM}
              >
                <i className='fa-solid fa-table w-5 text-yellow-400'></i>
                <span>Attendance Records</span>
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  router.push('/admin/rooms');
                }}
                className={MENU_ITEM}
              >
                <i className='fa-solid fa-door-closed w-5 text-yellow-400'></i>
                <span>Manage Room</span>
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  router.push('/admin/users');
                }}
                className={MENU_ITEM}
              >
                <i className='fa-solid fa-users-gear w-5 text-yellow-400'></i>
                <span>Manage Users</span>
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  router.push('/occupancy');
                }}
                className={MENU_ITEM}
              >
                <i className='fa-solid fa-door-open w-5 text-yellow-400'></i>
                <span>Room Occupancy</span>
              </button>
              <button
                onClick={() => {
                  setIsOpen(false);
                  router.push('/station');
                }}
                className={MENU_ITEM}
              >
                <i className='fa-solid fa-qrcode w-5 text-yellow-400'></i>
                <span>QR Station</span>
              </button>
            </div>
          )}

          {/* Preferences (all roles) */}
          <div className='p-2 border-t border-yellow-500/20'>
            <ThemeToggle />
          </div>

          {/* Logout */}
          <div className='p-2 border-t border-yellow-500/20'>
            <button
              onClick={handleLogout}
              className='w-full px-4 py-2.5 rounded-lg text-left text-red-400 hover:bg-red-500/10 active:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 transition-colors flex items-center gap-3'
            >
              <i className='fa-solid fa-right-from-bracket w-5'></i>
              <span>Logout</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
