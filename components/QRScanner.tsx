'use client';

import { useClockInStore } from '@/store/clockInStore';
import { useRecordsStore } from '@/store/recordsStore';
import { useRoomPresenceStore } from '@/store/roomPresenceStore';
import { useRoomsStore } from '@/store/roomsStore';
import { useAuthStore } from '@/store/authStore';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { parseQrValue } from '@/lib/wayfinding';
import { performVisitorCheckIn } from '@/lib/checkIn';
import QRCode from 'react-qr-code';

export default function QRScanner() {
  const {
    status,
    clockIn,
    clockOut,
    activeRecordId,
    startRouteView,
  } = useClockInStore();
  const { clockOutRecord } = useRecordsStore();
  const { enterRoom, leaveRoom, getCurrentRoom, fetchTodayPresence } =
    useRoomPresenceStore();
  const { fetchRooms, fetchPurposes, fetchCourses, getRoomByQr, getRoomByNumber } =
    useRoomsStore();
  const { user } = useAuthStore();

  const [scannerActive, setScannerActive] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [showQR, setShowQR] = useState(false);
  // Room of the last successful door scan, so the viewfinder can confirm where
  // the person was recorded rather than leaving them guessing.
  const [lastRoom, setLastRoom] = useState<string | null>(null);
  // R2: set when someone tries to check out while recorded inside a room. Holds
  // the room so the dialog can name it, and gates the check-out behind a choice.
  const [pendingClockOut, setPendingClockOut] = useState<{
    roomLabel: string;
    recordId: string;
  } | null>(null);
  // Set when someone scans the door of the room they are already recorded in.
  // Nothing is written; the dialog just explains why nothing changed.
  const [alreadyInRoom, setAlreadyInRoom] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
const handledRef = useRef(false);
  // The viewfinder element, so the scan box can be sized to what's actually
  // rendered. A hardcoded px value drifts out of sync with the frame on every
  // screen that isn't the one it was tuned for.
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Read by the qrbox callback below. A ref rather than state, because
  // startCamera's closure is created once - reading state there would pin it to
  // whatever the frame measured on first render.
  const frameSizeRef = useRef(0);

  // Track the rendered frame so the scanner's search box matches it. Also covers
  // rotation and the frame resizing between the scanner and the 3D route view.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const measure = () => {
      frameSizeRef.current = Math.min(el.clientWidth, el.clientHeight);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Stop only if the scanner is actually running. html5-qrcode throws
  // "Cannot stop, scanner is not running or paused" otherwise, which logs a
  // console error every time the view unmounts or the camera is already off.
  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;

    if (!scanner) return;

    try {
      if (scanner.isScanning) {
        await scanner.stop();
      }
      scanner.clear();
    } catch {
      // Teardown is best-effort; never block the UI on it.
    }
  }, []);

  /**
   * Closes the attendance visit and, if the person was recorded inside a room,
   * that room row too (R3). Both are closed together so the two tables can never
   * disagree about where someone is. Callers must have already handled R2.
   */
  const performClockOut = useCallback(
    async (recordId: string) => {
      const result = await clockOutRecord(recordId);

      if (!result.success) {
        // Keep the session marked as checked in so the next scan retries
        // rather than losing the record.
        setScanError(result.error || 'Could not check out. Please try again.');
        return false;
      }

      // Attendance is closed; presence must not be left dangling open.
      if (user) {
        await leaveRoom(user.id);
      }

      clockOut();
      setPendingClockOut(null);
      return true;
    },
    [clockOutRecord, clockOut, leaveRoom, user]
  );

  // Confirm handler for the R2 dialog. Cancelling closes nothing at all.
  const confirmClockOut = useCallback(async () => {
    if (!pendingClockOut) return;
    await performClockOut(pendingClockOut.recordId);
  }, [pendingClockOut, performClockOut]);

  const cancelClockOut = useCallback(() => {
    setPendingClockOut(null);
    setScanError('');
  }, []);

  // Rooms must be loaded before a door code can be resolved to a room id, and
  // purposes before check-in can record one. Courses too: a visitor with no
  // explicit room falls back to the room mapped to their course.
  useEffect(() => {
    fetchRooms();
    fetchPurposes();
    fetchCourses();
    // Load presence so `getCurrentRoom` knows where this person already is.
    // Both the "you're already here" check and the check-out confirmation
    // depend on it, and without it the store was empty so both were skipped.
    fetchTodayPresence();
  }, [fetchRooms, fetchPurposes, fetchCourses, fetchTodayPresence]);

  const handleScanSuccess = useCallback(
    async (decodedText: string) => {
      if (handledRef.current) return;
      handledRef.current = true;

      const parsed = parseQrValue(decodedText);

      if (!parsed) {
        setScanError('Not an HYT QR code. Scan the ground floor check-in code or a room door code.');
        handledRef.current = false;
        return;
      }

      // Stop the camera
      await stopScanner();

      setScannerActive(false);
      setScanning(true);

      // A room door code only records that this person is in that room. It must
      // never touch attendance, so branch before any check-in state is read.
      if (parsed.kind === 'room') {
        if (!user) {
          setScanError('Sign in before scanning a room code.');
          handledRef.current = false;
          setTimeout(() => setScanning(false), 1500);
          return;
        }

        // R1: a room scan without an active check-in is refused. Without this,
        // someone can walk into Room 304, never touch the entrance code, and
        // create a presence row that contradicts their attendance record.
        if (status === 'not-clocked-in') {
          setScanError(
            'Check in at the entrance first. We only record rooms for people who are checked in.'
          );
          handledRef.current = false;
          setTimeout(() => setScanning(false), 3000);
          return;
        }

        // Rooms are resolved from the `rooms` table, so the presence row carries
        // the room's id rather than the text that was scanned.
        const room = getRoomByQr(decodedText) ?? getRoomByNumber(parsed.roomNumber);

        if (!room) {
          setScanError(
            'That room code is not recognised. Ask an admin to check the rooms list.'
          );
          handledRef.current = false;
          setTimeout(() => setScanning(false), 2500);
          return;
        }

        const result = await enterRoom({
          userId: user.id,
          roomId: room.id,
          // Links this room entry to the attendance visit it happened under, so
          // the trail stays per-visit rather than blurring across days.
          clockInId: activeRecordId ?? null,
        });

        if (!result.success) {
          if (result.alreadyInRoom) {
            // Not an error - they are exactly where they already were. Say so
            // with a dialog instead of the red error overlay.
            setAlreadyInRoom(room.name || room.roomNumber);
          } else {
            setScanError(
              result.error || 'Could not record your room. Please try again.'
            );
          }
        } else {
          setLastRoom(room.roomNumber);
        }

        handledRef.current = false;
        setTimeout(() => setScanning(false), 1500);
        return;
      }

      // Ground floor code: this is the attendance action.
      // Scanning again while checked in checks back out.
      if (status !== 'not-clocked-in') {
        if (!activeRecordId) {
          // Should not happen, but without a record id there is no row to
          // close. Say so instead of silently showing "checked out".
          setScanError('Could not check out: no active check-in was found.');
          handledRef.current = false;
          setTimeout(() => setScanning(false), 1200);
          return;
        }

        // R2: checking out while recorded inside a room is the one genuinely
        // ambiguous action in this flow, so ask rather than guess. The door
        // scan is self-reported, so "they left the room but are still in the
        // building" is indistinguishable from "they left the building".
        const current = user ? getCurrentRoom(user.id) : null;
        if (current) {
          setPendingClockOut({
            roomLabel: current.roomLabel,
            recordId: activeRecordId,
          });
          // Keep the session checked in until they choose. Cancelling means
          // they remain checked in and inside the room (R3).
          handledRef.current = false;
          setScanning(false);
          return;
        }

        await performClockOut(activeRecordId);
        handledRef.current = false;
        setTimeout(() => setScanning(false), 1200);
        return;
      }

      // First scan: check in + create the DB record. `performVisitorCheckIn` is
      // the same action the automatic post-verification check-in uses, so the
      // two paths cannot drift. It resolves the assigned room and purpose,
      // writes the attendance row, and mirrors the result into the clock-in
      // store (keeping the record id so the next scan closes this same row).
      if (user) {
        const result = await performVisitorCheckIn(user);
        if (!result.success) {
          // Do not report a check-in that did not reach the database.
          setScanError(result.error || 'Could not check in. Please try again.');
          handledRef.current = false;
          setTimeout(() => setScanning(false), 2500);
          return;
        }
      } else {
        // Unreachable on the guarded visitor pages, but keep the old local-only
        // fallback rather than inventing a record with no user.
        clockIn();
      }
      setTimeout(() => setScanning(false), 1200);
    },
    [
      user,
      status,
      activeRecordId,
      clockIn,
      stopScanner,
      enterRoom,
      getCurrentRoom,
      getRoomByQr,
      getRoomByNumber,
      performClockOut,
    ]
  );

  // Always points at the latest handleScanSuccess. The camera callback is
  // registered once, when the scanner starts, so calling `handleScanSuccess`
  // directly pinned it to the render that started the camera: `status`,
  // `activeRecordId`, `user` and the purpose list were all frozen at their
  // mount-time values. That is what let a scan act on a check-in that had since
  // changed, and why room rows were written with no attendance link. Reading
  // through a ref means the callback always sees current state.
  const handleScanRef = useRef(handleScanSuccess);
  handleScanRef.current = handleScanSuccess;

  const startCamera = useCallback(async () => {
    setScanError('');
    handledRef.current = false;

    try {
      const html5Qrcode = new Html5Qrcode('qr-reader-mobile');
      scannerRef.current = html5Qrcode;

      await html5Qrcode.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // Search box tracks the rendered frame so the highlighted region always
          // matches the brackets on screen. Falls back to a sane 250px on the
          // first run, before layout has been measured.
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const side =
              frameSizeRef.current ||
              Math.min(viewfinderWidth, viewfinderHeight) ||
              250;
            const box = Math.floor(side * 0.8);
            return { width: box, height: box };
          },
          // Keep the video square: without this html5-qrcode letterboxes the
          // feed to the container's aspect and the frame stops lining up.
          aspectRatio: 1,
        },
        (decodedText) => handleScanRef.current(decodedText),
        () => {
          // per-frame failure; ignore
        }
      );

      setScannerActive(true);
    } catch (err: any) {
      setScanError(
        err?.message?.includes('Permission')
          ? 'Camera permission denied. Please allow camera access and try again.'
          : 'Could not start camera. ' +
              (err?.message ||
                'Please ensure a camera is connected and you are on HTTPS/localhost.')
      );
      setScannerActive(false);
    }
  }, []);

  const stopCamera = useCallback(async () => {
    await stopScanner();
    setScannerActive(false);
  }, [stopScanner]);

  // Toggle the viewfinder between the live camera and the personal QR code
  const handleToggleQR = useCallback(async () => {
    if (showQR) {
      setShowQR(false);
      startCamera();
    } else {
      await stopCamera();
      setShowQR(true);
    }
  }, [showQR, startCamera, stopCamera]);

  useEffect(() => {
    // Always release the camera on unmount, but only stop it if it's live.
    return () => {
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (!scanner) return;
      try {
        if (scanner.isScanning) {
          scanner.stop().catch(() => {});
        }
        scanner.clear();
      } catch {
        // best-effort
      }
    };
  }, []);
  // Auto-open the camera on load
  useEffect(() => {
    startCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className='
        w-full h-full flex flex-col items-center relative
        p-4 pt-5 pb-3
        // Safe-area padding keeps the frame clear of notches and the home
        // indicator on phones that have both.
        pb-[max(0.75rem,env(safe-area-inset-bottom))]
        overflow-y-auto
      '>
      {/* Camera Viewfinder. `aspect-square` keeps it square, and the size is derived
          from the available width/height rather than hardcoded, so it fills a
          small phone without overflowing a large one. dvh matters because mobile
          browsers report vh against a viewport that includes the collapsing
          address bar, which pushed the frame off screen on short screens. */}
          <div
            ref={frameRef}
            className='
              relative w-full aspect-square shrink-0
              max-w-[min(100%,calc(100dvh-20rem))]
            '
          >
        {/* Viewfinder Frame */}
        <div className='absolute inset-0 rounded-lg border-2 border-yellow-400/50 overflow-hidden bg-navy-900'>
          {/* Real Camera Feed */}
          <div id='qr-reader-mobile' className='w-full h-full' />

          {/* Placeholder when camera is off */}
          {!scannerActive && !scanning && (
            <div className='absolute inset-0 bg-navy-900 flex items-center justify-center'>
              <div className='text-center'>
                <i className='fa-solid fa-camera text-navy-600 text-5xl mb-3'></i>
                <p className='text-navy-500 text-xs'>Camera is off</p>
              </div>
            </div>
          )}

          {/* Scanning Laser (overlay) */}
          {scannerActive && !scanning && (
            <div
              className='absolute left-0 right-0 h-0.5 pointer-events-none'
              style={{ animation: 'scan 2s ease-in-out infinite', top: '50%' }}
            ></div>
          )}

          {/* Success Animation */}
          {scanning && (
            <div className='absolute inset-0 bg-green-500/20 flex items-center justify-center animate-pulse'>
              <div className='w-20 h-20 rounded-full bg-green-500 flex items-center justify-center animate-scale-in'>
                <i className='fa-solid fa-check text-paper text-3xl'></i>
              </div>
            </div>
          )}

          {/* Error overlay */}
          {scanError && !scannerActive && !scanning && (
            <div className='absolute inset-0 bg-navy-950/90 flex flex-col items-center justify-center p-4'>
              <i className='fa-solid fa-circle-exclamation text-red-500 text-4xl mb-3'></i>
              <p className='text-red-400 text-xs text-center'>{scanError}</p>

              {/* R1 offers the fix rather than just the problem: someone who
                  scanned a room door has clearly arrived, so point them at the
                  check-in flow instead of making them guess what to do next. */}
              {status === 'not-clocked-in' && (
                <button
                  onClick={startCamera}
                  className='
                    mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full
                    bg-yellow-500 hover:bg-yellow-600 text-yellow-950 text-xs font-medium
                    transition-colors duration-150
                  '
                >
                  <i className='fa-solid fa-door-open'></i>
                  Check in at the entrance
                </button>
              )}
            </div>
          )}

          {/* Corner brackets. Sized as a percentage of the frame so they stay
                proportionate on every screen, rather than a fixed 32px that
                looked oversized on a small phone. */}
          {[
            'top-0 left-0 border-t-4 border-l-4',
            'top-0 right-0 border-t-4 border-r-4',
            'bottom-0 left-0 border-b-4 border-l-4',
            'bottom-0 right-0 border-b-4 border-r-4',
          ].map((position, idx) => (
            <div
              key={idx}
              className={`absolute ${position} border-yellow-400 w-[15%] h-[15%] min-w-6 min-h-6 pointer-events-none rounded-sm ${scanning ? 'border-green-400' : ''}`}
            ></div>
          ))}
        </div>

        {/* Targeting Reticle. Tracks the scan box (80% of the frame) rather than
            sitting at a fixed 192px inside a frame that may now be much wider or
            narrower. */}
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          <div className='relative w-[80%] aspect-square'>
            <div className='absolute inset-0 border border-yellow-400/30 rounded-lg'></div>
            <div className='absolute top-1/2 left-0 right-0 h-px bg-yellow-400/30'></div>
            <div className='absolute left-1/2 top-0 bottom-0 w-px bg-yellow-400/30'></div>
          </div>
        </div>

        {/* Personal QR code shown in place of the camera */}
        {showQR && (
          <div className='absolute inset-0 z-20 bg-paper flex flex-col items-center justify-center p-4'>
            {user?.qrCode ? (
              <QRCode
                value={user.qrCode}
                size={180}
                style={{ height: 'auto', maxWidth: '100%', width: '100%' }}
                viewBox='0 0 180 180'
              />
            ) : (
              <p className='text-navy-500 text-sm text-center'>
                No QR code available for your account.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Camera / My QR switch */}
      <div className='mt-4 flex items-center justify-center gap-3'>
        <span
          className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
            !showQR ? 'text-yellow-300' : 'text-navy-500'
          }`}
        >
          <i className='fa-solid fa-camera'></i>
          Camera
        </span>
        <button
          type='button'
          role='switch'
          aria-checked={showQR}
          aria-label='Toggle between camera and personal QR code'
          onClick={handleToggleQR}
          // The visual pill stays 48x24, but the hit area is padded out to
          // 48x44 - the minimum comfortable touch target on a phone.
          className={`relative w-12 h-6 my-2.5 rounded-full transition-colors duration-150 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] ${
            showQR ? 'bg-yellow-500' : 'bg-navy-700'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-paper shadow transition-transform duration-150 ${
              showQR ? 'translate-x-6' : 'translate-x-0'
            }`}
          />
        </button>
        <span
          className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
            showQR ? 'text-yellow-300' : 'text-navy-500'
          }`}
        >
          <i className='fa-solid fa-qrcode'></i>
          My QR
        </span>
      </div>

      {/* Instructions */}
      <div className='mt-5 text-center'>
        {showQR ? (
          <div className='inline-flex items-center gap-2 px-4 py-2 rounded-full bg-yellow-500/10 border border-yellow-500/30 mb-4'>
            <i className='fa-solid fa-qrcode text-yellow-400 text-sm'></i>
            <span className='text-yellow-300 text-sm font-medium'>
              Show this QR at check-in
            </span>
          </div>
        ) : !scannerActive && !scanning ? (
          <button
            onClick={startCamera}
            className='inline-flex items-center gap-2 px-4 py-2 rounded-full bg-yellow-500 hover:bg-yellow-600 text-yellow-950 text-sm font-medium transition-colors duration-150 mb-4'
          >
            <i className='fa-solid fa-camera text-sm'></i>
            {status === 'not-clocked-in'
              ? 'Start camera to scan'
              : 'Open camera to scan'}
          </button>
        ) : (
          <div className='inline-flex items-center gap-2 px-4 py-2 rounded-full bg-yellow-500/10 border border-yellow-500/30 mb-4'>
            <i className='fa-solid fa-camera text-yellow-400 text-sm'></i>
            <span className='text-yellow-300 text-sm font-medium'>
              {status === 'not-clocked-in'
                ? 'Point at the entrance code to check in'
                : 'Point at any room door or the entrance'}
            </span>
          </div>
        )}

        <p className='text-navy-300 text-xs max-w-xs mx-auto mb-3'>
          {showQR
            ? 'Present your personal QR code to the check-in scanner to check in.'
            : status === 'not-clocked-in'
              ? 'Scan the entrance code to check in and receive your route.'
              : 'You are checked in. Scan a room door to record where you are, or the entrance code to check out.'}
        </p>

        {/* A legend for the three different codes in the building. Each does a
            genuinely different thing and none of them is obvious from the
            poster alone, so the distinction is spelled out here rather than
            left to be inferred from a failed scan. */}
        <div className='max-w-xs mx-auto mb-4 rounded-lg border border-navy-700 bg-navy-900/50 divide-y divide-navy-800'>
          <div className='flex items-start gap-2 px-3 py-2 text-left'>
            <i className='fa-solid fa-door-open text-yellow-400 text-xs mt-0.5'></i>
            <p className='text-navy-300 text-[11px] leading-snug'>
              <span className='text-white font-semibold'>Entrance poster</span> —
              check in on arrival, check out on the way out.
            </p>
          </div>
          <div className='flex items-start gap-2 px-3 py-2 text-left'>
            <i className='fa-solid fa-location-dot text-yellow-400 text-xs mt-0.5'></i>
            <p className='text-navy-300 text-[11px] leading-snug'>
              <span className='text-white font-semibold'>Room door poster</span> —
              records which room you are in. Never checks you in or out.
              {/* Called out while checked in, because that is the action a visitor
                  actually has available in the building and the scanner gave no
                  hint of it otherwise. */}
              {status !== 'not-clocked-in' && (
                <span className='block mt-1 text-yellow-300'>
                  <i className='fa-solid fa-circle-check text-[10px] mr-1'></i>
                  You can scan these now.
                </span>
              )}
            </p>
          </div>
          <div className='flex items-start gap-2 px-3 py-2 text-left'>
            <i className='fa-solid fa-id-card text-yellow-400 text-xs mt-0.5'></i>
            <p className='text-navy-300 text-[11px] leading-snug'>
              <span className='text-white font-semibold'>Your personal code</span> —
              shown on this screen for the reception desk to scan.
            </p>
          </div>
        </div>

        {/* Current state, as one plain line. This replaces a mode toggle: the
            scanner already knows which kind of code was scanned, so there is
            nothing to choose, only something to report. */}
        {status !== 'not-clocked-in' && (
          <p className='text-navy-300 text-xs mb-3'>
            Checked in ·{' '}
            {(() => {
              const current = user ? getCurrentRoom(user.id) : null;
              return current ? `In ${current.roomLabel}` : 'In the lobby';
            })()}
          </p>
        )}

        {/* Confirms the last door scan actually registered. */}
        {lastRoom && !scanError && !scannerActive && (
          <div className='inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/30 mb-4'>
            <i className='fa-solid fa-location-dot text-green-400 text-sm'></i>
            <span className='text-green-300 text-sm font-medium'>
              Recorded in {lastRoom}
            </span>
          </div>
        )}

        {/* Where they're recorded as being right now. */}
        {user && getCurrentRoom(user.id) && (
          <p className='text-navy-400 text-xs mb-4'>
            Currently in {getCurrentRoom(user.id)?.roomLabel} ·{' '}
            {getCurrentRoom(user.id)?.enteredAt.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        )}
      </div>

      {/* R2: the check-out confirmation. Shown only when the person is recorded
          inside a room, because that is the one case where the intent behind a
          second entrance scan is genuinely ambiguous. */}
      {pendingClockOut && (
        <div className='fixed inset-0 z-50 bg-navy-950/80 flex items-center justify-center p-4'>
          <div className='glass-panel border-navy-700 rounded-lg p-6 max-w-sm w-full'>
            <h3 className='text-white font-bold text-lg mb-2'>
              Leave the building?
            </h3>
            <p className='text-navy-300 text-sm mb-6'>
              You are recorded in {pendingClockOut.roomLabel}. Checking out
              closes your attendance and that room entry.
            </p>
            <div className='flex gap-3'>
              <button
                onClick={cancelClockOut}
                className='
                  flex-1 px-4 py-3 rounded-lg font-semibold text-sm
                  bg-navy-700 hover:bg-navy-600 text-navy-100
                  transition-colors duration-150
                '
              >
                Cancel
              </button>
              <button
                onClick={confirmClockOut}
                className='
                  flex-1 px-4 py-3 rounded-lg font-semibold text-sm
                  bg-yellow-500 hover:bg-yellow-600 text-yellow-950
                  transition-colors duration-150
                '
              >
                Check out anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Already-in-room notice. A dialog rather than the red error overlay,
          because nothing went wrong - the scan was simply redundant. */}
      {alreadyInRoom && (
        <div className='fixed inset-0 z-50 bg-navy-950/80 flex items-center justify-center p-4'>
          <div className='glass-panel border-navy-700 rounded-lg p-6 max-w-sm w-full text-center'>
            <div className='w-14 h-14 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto mb-3'>
              <i className='fa-solid fa-location-dot text-yellow-400 text-2xl'></i>
            </div>
            <h3 className='text-white font-bold text-lg mb-2'>
              You&apos;re already inside this room
            </h3>
            <p className='text-navy-300 text-sm mb-6'>
              You&apos;re already recorded in {alreadyInRoom}. No need to scan
              again.
            </p>
            <button
              onClick={() => setAlreadyInRoom(null)}
              className='
                w-full px-4 py-3 rounded-lg font-semibold text-sm
                bg-yellow-500 hover:bg-yellow-600 text-yellow-950
                transition-colors duration-150
              '
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* View Route (when checked in) */}
      {status !== 'not-clocked-in' && (
        <button
          onClick={startRouteView}
          className='
            relative px-4 py-3 rounded-lg font-bold text-base text-white
            bg-navy-700 hover:bg-navy-600
            transition-colors duration-150
            '
        >
          <span className='relative z-10 flex items-center gap-2'>
            <i className='fa-solid fa-route'></i>
            View 3D Route
          </span>
        </button>
      )}
    </div>
  );
}
