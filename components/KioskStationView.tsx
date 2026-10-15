'use client';

import { useClockInStore } from '@/store/clockInStore';
import { useAuthStore } from '@/store/authStore';
import { useRecordsStore } from '@/store/recordsStore';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import QRCode from 'react-qr-code';
import {
  ATTENDANCE_QR_VALUE,
} from '@/lib/wayfinding';
import {
  useRoomPresenceStore,
  visitDuration,
} from '@/store/roomPresenceStore';
import { useRoomsStore } from '@/store/roomsStore';
import { useLiveData } from '@/hooks/useLiveData';
import LiveBadge from '@/components/LiveBadge';
import StationRegistrationForm from '@/components/StationRegistrationForm';
import RegistrationQr from '@/components/RegistrationQr';

// Everything the print window needs, without dragging in the waypoint data.
type PrintableCode = {
  id: string;
  label: string;
  room: string;
  /** Optional second line, e.g. the building a room is in. */
  building?: string;
  qrValue: string;
};

// Destination labels go into a generated print document, so escape them
// rather than trusting the registry text.
function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default function KioskStationView() {
  const { student } = useClockInStore();
  const { user } = useAuthStore();
  const { getActiveCount, getCompletedTodayCount } = useRecordsStore();
  // Live per-room headcount for the posters below, so whoever is posting them
  // can see at a glance which rooms already have people in them.
  const { getOccupancyByRoom, presence } = useRoomPresenceStore();
  // One poster per room in the `rooms` table, so adding a room in the admin UI
  // is enough to get it printed here. Inactive rooms are excluded but their
  // history is untouched.
  const { getActiveRooms, fetchRooms, getRoomById } = useRoomsStore();
  const rooms = getActiveRooms();

  // Which room's records the drill-down is showing, or null when closed. The
  // headcount badge is the way in. Held as a room id so it cannot drift from
  // the rooms table.
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);

  // Drives the clock below. Without this the time is frozen at whatever it was
  // when the component rendered, and never advances.
  const [now, setNow] = useState(() => new Date());

  // Load rooms for the poster grid.
  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  // Live counts: the "Checked In Now" / "Checked Out Today" cards and the
  // per-room headcounts used to be a snapshot from page load.
  const { lastRefreshed } = useLiveData({
    records: 'today',
    presence: 'today',
  });

  // Tick once a minute, aligned to the minute boundary so the displayed minute
  // flips when it actually changes rather than up to a minute late.
  useEffect(() => {
    const tick = () => setNow(new Date());
    const msToNextMinute = 60000 - (Date.now() % 60000);
    const timeout = setTimeout(tick, msToNextMinute);
    const interval = setInterval(tick, 60000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, []);

  // Escape closes the drill-down, matching the usual expectation for a dialog.
  useEffect(() => {
    if (!openRoomId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenRoomId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openRoomId]);

  // Stop the page behind the overlay from scrolling while it's open.
  useEffect(() => {
    if (!openRoomId) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [openRoomId]);

  const activeCount = getActiveCount();
  const onBreakCount = getCompletedTodayCount();

  // Only one pass over the occupancy map, rather than rebuilding it per poster.
  // Keyed by room id, matching how presence rows are stored.
  const roomCounts = (() => {
    const byRoom = new Map(
      getOccupancyByRoom().map((r) => [r.roomId, r.people.length])
    );
    return (roomId: string) => byRoom.get(roomId) ?? 0;
  })();

  // Visits for the open room, newest first. Split so people still inside sit at
  // the top, which is what the person checking the room actually cares about.
  const openRoomVisits = (() => {
    if (!openRoomId) return null;
    const room = getRoomById(openRoomId);
    if (!room) return null;

    const visits = presence
      .filter((p) => p.roomId === openRoomId)
      .sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime());

    return {
      room,
      inside: visits.filter((v) => !v.exitedAt),
      history: visits.filter((v) => v.exitedAt),
    };
  })();

  // Pulls the live SVG out of the panel so the print window can clone it as
  // vector markup - a rasterised screenshot would blur when printed.
  const handlePrintQR = (route: PrintableCode) => {
    const panel = document.querySelector(`[data-qr-panel="${route.id}"]`);
    const svg = panel?.querySelector('svg');
    if (!svg) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(
      '<!doctype html><html><head><title>' +
        escapeHtml(route.label) +
        '</title>' +
        '<meta charset="utf-8" />' +
        '<style>' +
        'body { font-family: Arial, Helvetica, sans-serif; color: #111; ' +
        'display: flex; flex-direction: column; align-items: center; ' +
        'justify-content: center; height: 100vh; margin: 0; }' +
        'h1 { font-size: 26px; margin: 0 0 6px; text-align: center; }' +
        'p { font-size: 15px; color: #444; margin: 0 0 22px; }' +
        '.code { background: #fff; padding: 28px; border: 2px solid #111; }' +
        '.code svg { width: 320px; height: 320px; display: block; }' +
        '</style></head><body>' +
        '<h1>' +
        escapeHtml(route.label) +
        '</h1>' +
        '<p>' +
        escapeHtml(route.building ? route.room + ' · ' + route.building : route.room) +
        '</p>' +
        '<div class="code">' +
        svg.outerHTML +
        '</div>' +
        '</body></html>'
    );
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  return (
    <div className='w-full min-h-full p-8'>
      <div className='max-w-7xl mx-auto'>
        {/* Back to the dashboard, mirroring the back link on the other admin
            sub-pages (/admin/rooms, /admin/records, /admin/users). The station
            is reached from the dashboard tile, so that is where it returns to. */}
        <Link
          href='/admin'
          className='inline-flex items-center gap-2 text-navy-300 hover:text-navy-200 transition-colors mb-4'
        >
          <i className='fa-solid fa-arrow-left'></i>
          <span>Back to Dashboard</span>
        </Link>

        {/* Page title. No status badge here: it used to read "Station Active", but
            nothing ever set it inactive, so it was decoration rather than
            information. The live counts below carry the real status. */}
        <div className='mb-8 flex items-start justify-between gap-4'>
          <div>
            <h1 className='text-3xl font-bold text-white mb-2'>QR Station</h1>
            <p className='text-navy-300'>
              Register visitors at the desk, then print the attendance code for
              the ground floor and a door code for each room.
            </p>
          </div>
          <LiveBadge lastRefreshed={lastRefreshed} />
        </div>

          {/* Live stats. Each card states what it counts, since "Check Out" next to a
            coffee-cup icon was ambiguous about whether it meant the action or
	    the number of people who had already done it. */}
	  <div className='grid grid-cols-1 md:grid-cols-3 gap-3 mb-3'>
            <div className='glass-panel border-navy-800 p-6 rounded-lg'>
              <div className='flex items-center gap-4'>
                <div className='w-14 h-14 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0'>
                  <i className='fa-solid fa-user-check text-green-400 text-2xl'></i>
                </div>
                <div className='min-w-0'>
                  <p className='text-navy-300 text-sm mb-1'>Checked In Now</p>
                  <p className='text-white text-3xl font-bold leading-none'>
                    {activeCount}
                  </p>
                </div>
              </div>
            </div>

            <div className='glass-panel border-navy-800 p-6 rounded-lg'>
              <div className='flex items-center gap-4'>
                <div className='w-14 h-14 rounded-lg bg-yellow-500/20 flex items-center justify-center flex-shrink-0'>
                  <i className='fa-solid fa-sign-out-alt text-yellow-400 text-2xl'></i>
                </div>
                <div className='min-w-0'>
                  <p className='text-navy-300 text-sm mb-1'>Checked Out Today</p>
                  <p className='text-white text-3xl font-bold leading-none'>
                    {onBreakCount}
                  </p>
                </div>
              </div>
            </div>

            <div className='glass-panel border-navy-800 p-6 rounded-lg'>
              <div className='flex items-center gap-4'>
                <div className='w-14 h-14 rounded-lg bg-navy-600/20 flex items-center justify-center flex-shrink-0'>
                  <i className='fa-solid fa-clock text-navy-200 text-2xl'></i>
                </div>
                <div className='min-w-0'>
                  <p className='text-navy-300 text-sm mb-1'>Current Time</p>
                  <p className='text-white text-3xl font-bold leading-none tabular-nums'>
                    {now.toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: true,
                    })}
                  </p>
                </div>
              </div>
            </div>
          </div>

        {/* Side by side on wide screens, stacked on a phone. The QR belongs
            beside the form it sends people to, so the desk can print it without
            hunting for a second panel. */}
        <div className='grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8'>
          <div className='flex flex-col justify-center rounded-lg border border-blue-500/30 bg-blue-500/10 p-5'>
            <h2 className='text-white font-bold text-lg mb-2'>
              Entrance poster
            </h2>
            <p className='text-navy-200 text-sm'>
              The code below opens the{' '}
              <span className='text-blue-300 font-semibold'>
                self-registration page
              </span>{' '}
              in the visitor&apos;s phone browser. It is deliberately a{' '}
              <span className='text-white font-semibold'>separate code</span>{' '}
              from the attendance QR below: that one is read by this app to
              clock people in, and replacing it with a link would break
              check-in for everyone already holding a pass.
            </p>
          </div>
          <RegistrationQr />
        </div>

        {/* Attendance heading. There is exactly one attendance code and it is
            the ground floor one, so it gets its own prominent panel rather than
            sitting in the same grid as the room codes. */}
        <div className='text-center mb-6'>
          <div className='inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/30 mb-4'>
            <i className='fa-solid fa-clipboard-check text-green-400'></i>
            <span className='text-green-300 font-semibold text-sm uppercase tracking-wider'>
              Ground Floor · Attendance
            </span>
          </div>
          <h2 className='text-2xl font-bold text-white mb-2'>
            Scan to Check In or Out
          </h2>
          <p className='text-navy-300'>
            This is the only code that records attendance. Post it at the ground
            floor entrance.
          </p>
        </div>

        {/* The single attendance code. Printed large because this is the one
            people scan most, and separated from the room codes below so nobody
            mistakes a door code for the check-in point. */}
        <div className='max-w-md mx-auto mb-10'>
          <div className='glass-panel border-green-500/30 rounded-lg p-6 flex flex-col items-center'>
            <div className='flex justify-center w-full mb-4'>
              <div
                data-qr-panel='attendance'
                className='bg-paper p-6 rounded-lg w-full max-w-[240px] shadow-lg'
              >
                <QRCode
                  value={ATTENDANCE_QR_VALUE}
                  size={208}
                  style={{ height: 'auto', maxWidth: '100%', width: '100%' }}
                  viewBox={`0 0 208 208`}
                />
              </div>
            </div>
            <p className='text-white font-bold text-sm text-center'>
              Ground Floor Attendance
            </p>
            <p className='text-navy-400 text-xs text-center mt-1'>
              Main entrance
            </p>
            <button
              onClick={() => handlePrintQR({
                id: 'attendance',
                label: 'Ground Floor Attendance',
                room: 'Main Entrance',
                qrValue: ATTENDANCE_QR_VALUE,
              })}
              className='
                mt-4 w-full px-4 py-2.5 rounded-lg font-semibold text-sm
                bg-green-600 hover:bg-green-700 text-paper
                transition-colors duration-150
                flex items-center justify-center gap-2
              '
            >
              <i className='fa-solid fa-print'></i>
              Print Attendance QR
            </button>
          </div>
        </div>

        {/* Room codes. Clearly labelled as tracking-only so they are never
            mistaken for a way to record attendance. */}
        <div className='text-center mb-6'>
          <div className='inline-flex items-center gap-2 px-4 py-2 rounded-full bg-navy-700/50 border border-navy-700 mb-4'>
            <i className='fa-solid fa-door-open text-navy-300'></i>
            <span className='text-navy-200 font-semibold text-sm uppercase tracking-wider'>
              Rooms QR Codes
            </span>
          </div>
          <h2 className='text-2xl font-bold text-white mb-2'>Scan to Record your visit</h2>
          <p className='text-navy-300'>
            Post one on each room door. Scanning records who is inside that room
            — it does not check anyone in or out.
          </p>
        </div>

        {/* One panel per room, so each code is a self-contained unit that can be
            printed and posted on its own door. */}
        <div className='grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-4'>
          {rooms.length === 0 && (
          <p className='text-navy-400 text-sm text-center py-8'>
            No rooms yet. Add rooms under Admin &rarr; Rooms to print their codes.
          </p>
        )}

        {rooms.map((room) => (
            <div
              key={room.id}
              className='glass-panel border-navy-800 rounded-lg p-6 flex flex-col items-center'
            >
              {/* Fixed max width so the `width: 100%` on the QR resolves to a
                  real box, which is what lets the centering work. */}
              <div className='flex justify-center w-full mb-4'>
                {/* The SVG is looked up from the DOM when printing rather than
                    via a ref, because react-qr-code's ref type is a union that
                    is awkward to satisfy. */}
                <div
                  data-qr-panel={room.id}
                  className='bg-paper p-6 rounded-lg w-full max-w-[240px] shadow-lg'
                >
                  <QRCode
                    value={room.qrValue}
                    size={208}
                    style={{ height: 'auto', maxWidth: '100%', width: '100%' }}
                    viewBox={`0 0 208 208`}
                  />
                </div>
              </div>
              <p className='text-white font-bold text-sm text-center'>
                {room.name}
              </p>
              <p className='text-navy-400 text-xs text-center mt-1'>
                {room.roomNumber} · {room.building}
              </p>

              {/* Live headcount for this room. Clicking opens that room's records, so a
                  count of 0 is still worth clicking - it shows who was in the
                  room earlier today and when they left. Shown on screen only,
                  never in the print window: a number on a printed poster would
                  be stale the moment it went up. */}
              <button
                type='button'
                onClick={() => setOpenRoomId(room.id)}
                aria-label={`View records for ${room.name}`}
                className={`
                  mt-3 w-full px-3 py-2 rounded-lg border text-center
                  transition-colors duration-150 cursor-pointer
                  focus:outline-none focus:ring-2 focus:ring-yellow-500/60
                  ${
                    roomCounts(room.id) > 0
                      ? 'bg-green-500/10 border-green-500/30 hover:bg-green-500/20'
                      : 'bg-navy-900/50 border-navy-700 hover:border-navy-600 hover:bg-navy-800/50'
                  }
                `}
              >
                <span
                  className={`text-xs font-semibold ${
                    roomCounts(room.id) > 0
                      ? 'text-green-300'
                      : 'text-navy-400'
                  }`}
                >
                  <i className='fa-solid fa-users mr-1'></i>
                  {roomCounts(room.id)}{' '}
                  {roomCounts(room.id) === 1 ? 'person' : 'people'} inside
                  <i className='fa-solid fa-chevron-right ml-2 text-[10px] opacity-60'></i>
                </span>
              </button>

              <button
                onClick={() =>
                  handlePrintQR({
                    id: room.id,
                    label: room.name,
                    room: room.roomNumber,
                    building: room.building,
                    qrValue: room.qrValue,
                  })
                }
                className='
                  mt-4 w-full px-4 py-2.5 rounded-lg font-semibold text-sm
                  bg-yellow-500 hover:bg-yellow-600 text-yellow-950
                  transition-colors duration-150
                  flex items-center justify-center gap-2
                '
              >
                <i className='fa-solid fa-print'></i>
                Print QR Code
              </button>
            </div>
          ))}
        </div>

        {/* Room records drill-down, opened from a poster's headcount badge.
            An overlay rather than an inline expand, because the posters are a
            grid and expanding one would reflow every card around it. */}
        {openRoomVisits && (
          <div
            className='fixed inset-0 z-50 flex items-center justify-center p-4'
            role='dialog'
            aria-modal='true'
            aria-label={`${openRoomVisits.room.name} records`}
          >
            {/* Clicking the backdrop closes it. */}
            <div
              className='absolute inset-0 bg-navy-950/80 backdrop-blur-sm'
              onClick={() => setOpenRoomId(null)}
            />

            <div className='relative w-full max-w-2xl max-h-[80vh] flex flex-col glass-panel border-navy-700 rounded-lg overflow-hidden'>
              {/* Header */}
              <div className='flex items-start justify-between gap-4 px-6 py-4 border-b border-navy-800 bg-navy-900/50 flex-shrink-0'>
                <div>
                  <h3 className='text-white font-bold text-lg flex items-center gap-2'>
                    <i className='fa-solid fa-door-closed text-navy-400'></i>
                    {openRoomVisits.room.name}
                  </h3>
                  <p className='text-navy-400 text-xs mt-0.5'>
                    {openRoomVisits.room.roomNumber} ·{' '}
                    {openRoomVisits.room.building}
                  </p>
                </div>
                <button
                  type='button'
                  onClick={() => setOpenRoomId(null)}
                  aria-label='Close'
                  className='text-navy-400 hover:text-white transition-colors text-lg leading-none p-1'
                >
                  <i className='fa-solid fa-xmark'></i>
                </button>
              </div>

              {/* Body */}
              <div className='px-6 py-4 overflow-y-auto flex-1'>
                <div className='flex items-center gap-4 mb-4 text-sm'>
                  <span className='text-navy-300'>
                    <span className='text-white font-bold'>
                      {openRoomVisits.inside.length}
                    </span>{' '}
                    inside now
                  </span>
                  <span className='text-navy-300'>
                    <span className='text-white font-bold'>
                      {openRoomVisits.history.length}
                    </span>{' '}
                    already left today
                  </span>
                </div>

                {openRoomVisits.inside.length === 0 &&
                openRoomVisits.history.length === 0 ? (
                  <div className='text-center py-8'>
                    <i className='fa-solid fa-inbox text-navy-600 text-4xl mb-3'></i>
                    <p className='text-navy-300'>No visits recorded today</p>
                    <p className='text-navy-500 text-xs mt-1'>
                      Nobody has scanned this room&apos;s door code yet.
                    </p>
                  </div>
                ) : (
                  <div className='space-y-5'>{/* Still inside, listed first - that's the actionable group for
                      whoever is checking the room. */}
                    {openRoomVisits.inside.length > 0 && (
                      <div>
                        <h4 className='text-xs font-semibold text-green-400 uppercase tracking-wider mb-2'>
                          Inside now
                        </h4>
                        <ul className='space-y-1.5'>
                          {openRoomVisits.inside.map((visit) => (
                            <li
                              key={visit.id}
                              className='flex items-center justify-between gap-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2'
                            >
                              <span className='flex items-center gap-2 text-white text-sm truncate'>
                                <i className='fa-solid fa-user text-green-400 text-xs'></i>
                                <span className='truncate'>
                                  {visit.userName || 'Unknown user'}
                                </span>
                              </span>
                              <span className='text-green-300 text-xs whitespace-nowrap'>
                                since{' '}
                                {visit.enteredAt.toLocaleTimeString('en-US', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {openRoomVisits.history.length > 0 && (
                      <div>
                        <h4 className='text-xs font-semibold text-navy-400 uppercase tracking-wider mb-2'>
                          Left today
                        </h4>
                        <ul className='space-y-1.5'>
                          {openRoomVisits.history.map((visit) => (
                            <li
                              key={visit.id}
                              className='flex items-center justify-between gap-3 rounded-lg border border-navy-700 bg-navy-900/40 px-3 py-2'
                            >
                              <span className='flex items-center gap-2 text-navy-200 text-sm truncate'>
                                <i className='fa-solid fa-user text-navy-500 text-xs'></i>
                                <span className='truncate'>
                                  {visit.userName || 'Unknown user'}
                                </span>
                              </span>
                              <span className='text-navy-400 text-xs whitespace-nowrap'>
                                {visit.enteredAt.toLocaleTimeString('en-US', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}{' '}
                                –{' '}
                                {visit.exitedAt?.toLocaleTimeString('en-US', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}{' '}
                                ·{' '}
                                {visitDuration(visit.enteredAt, visit.exitedAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}</div>
                )}
              </div>

              {/* Footer - the full history lives on its own admin page. */}
              <div className='px-6 py-3 border-t border-navy-800 bg-navy-900/50 flex-shrink-0'>
                <Link
                  href='/admin/room-records'
                  className='text-yellow-400 hover:text-yellow-300 text-sm font-semibold flex items-center gap-2 transition-colors'
                >
                  View full room visit history
                  <i className='fa-solid fa-arrow-right'></i>
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* How it works - its own panel */}
        <div className='glass-panel border-navy-800 p-6 rounded-lg'>
          <h3 className='text-white font-bold text-lg mb-4'>How it works</h3>
          <div className='space-y-3'>
            <div className='flex items-start gap-3 text-sm'>
              <div className='w-6 h-6 rounded-full bg-yellow-500/20 flex items-center justify-center flex-shrink-0 mt-0.5'>
                <span className='text-yellow-400 font-bold text-xs'>1</span>
              </div>
              <p className='text-navy-200'>
                Register the visitor above. Their account and pass are created on
                the spot — no QR code is needed to sign up.
              </p>
            </div>
            <div className='flex items-start gap-3 text-sm'>
              <div className='w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0 mt-0.5'>
                <span className='text-green-400 font-bold text-xs'>2</span>
              </div>
              <p className='text-navy-200'>
                On arrival, they scan the{' '}
                <span className='text-green-300 font-semibold'>
                  ground floor attendance code
                </span>{' '}
                to check in and receive their 3D route.
              </p>
            </div>
            <div className='flex items-start gap-3 text-sm'>
              <div className='w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0 mt-0.5'>
                <span className='text-green-400 font-bold text-xs'>3</span>
              </div>
              <p className='text-navy-200'>
                They scan the{' '}
                <span className='text-navy-100 font-semibold'>
                  code on their room door
                </span>{' '}
                to record where they are. Attendance is unaffected.
              </p>
            </div>
            <div className='flex items-start gap-3 text-sm'>
              <div className='w-6 h-6 rounded-full bg-navy-700 flex items-center justify-center flex-shrink-0 mt-0.5'>
                <span className='text-navy-200 font-bold text-xs'>4</span>
              </div>
              <p className='text-navy-200'>
                When they leave, they scan the{' '}
                <span className='text-green-300 font-semibold'>
                  ground floor code again
                </span>{' '}
                to check out.
              </p>
            </div>
          </div>
        </div>

        {/* Footer Info */}
        <div className='mt-8 text-center text-navy-500 text-sm'>
          <p>HYT Global Institute · Visitor Management System v2.0</p>
          <p className='mt-1'>For assistance, contact Security Desk: Ext. 1100</p>
        </div>
      </div>
    </div>
  );
}
