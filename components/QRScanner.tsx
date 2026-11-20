'use client';

import { useClockInStore } from '@/store/clockInStore';
import { useRecordsStore } from '@/store/recordsStore';
import { useRoomPresenceStore } from '@/store/roomPresenceStore';
import { useRoomsStore } from '@/store/roomsStore';
import { useAuthStore } from '@/store/authStore';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Html5Qrcode } from 'html5-qrcode';
import { parseQrValue } from '@/lib/wayfinding';
import { performVisitorCheckIn } from '@/lib/checkIn';
import QRCode from 'react-qr-code';
import Button from './ui/Button';

export default function QRScanner() {
  const { status, clockIn, clockOut, activeRecordId } = useClockInStore();
  const { clockOutRecord } = useRecordsStore();
  const { enterRoom, leaveRoom, getCurrentRoom, fetchTodayPresence } =
    useRoomPresenceStore();
  const { fetchRooms, fetchPurposes, fetchCourses, getRoomByQr, getRoomByNumber } =
    useRoomsStore();
  const { user, passExpired, logout } = useAuthStore();
  const router = useRouter();

  const [scannerActive, setScannerActive] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [showQR, setShowQR] = useState(false);
  // Expired passes are read-only: the camera is never started and every scan
  // path is refused before it can write anything. The dialog sends the visitor
  // back through verification so the front desk can renew them.
  const [showExpiredNotice, setShowExpiredNotice] = useState(false);
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
  // rotation and the frame resizing on different screen sizes.
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
   *
   * Leaving is the end of the visit: once the records are closed the visitor is
   * signed out and sent back to the entrance screen, ready for the next visit.
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

      // Sign out only after every write has succeeded, so a failed check-out
      // leaves the visitor signed in and able to retry the scan.
      await logout();
      router.replace('/verify');
      return true;
    },
    [clockOutRecord, clockOut, leaveRoom, user, logout, router]
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

      // An expired pass cannot start, change or end a visit. Check before the
      // value is even parsed, so no QR type - entrance, room or anything else -
      // can reach a write path.
      if (passExpired) {
        await stopScanner();
        setScannerActive(false);
        setScanning(false);
        setShowExpiredNotice(true);
        handledRef.current = false;
        return;
      }

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
      passExpired,
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
    // Do not even open the camera for an expired pass. Showing the dialog
    // immediately is clearer than letting someone point at a code that will
    // always be refused. `stopScanner` also covers the late case where the
    // camera started before AuthGate finished resolving the pass state.
    if (passExpired) {
      await stopScanner();
      setScannerActive(false);
      setShowExpiredNotice(true);
      return;
    }

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
  }, [passExpired, stopScanner]);

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
  // Auto-open the camera on load. `startCamera` shows the expired-pass dialog
  // instead when the pass is no longer valid, so the camera never opens.
  useEffect(() => {
    startCamera();
  }, [startCamera]);

  // A popup alone would leave an expired visitor sitting on a scanner they
  // cannot use. Give them a moment to read it, then send them to verification.
  useEffect(() => {
    if (!showExpiredNotice) return;

    const timer = window.setTimeout(() => router.replace('/verify'), 5000);
    return () => window.clearTimeout(timer);
  }, [showExpiredNotice, router]);

  return (
    <div className='relative flex min-h-full w-full flex-col items-center px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-5'>
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
        <div className='absolute inset-0 overflow-hidden rounded-2xl border-2 border-yellow-400/50 bg-navy-900'>
          {/* Real Camera Feed */}
          <div id='qr-reader-mobile' className='h-full w-full' />

          {/* Placeholder when camera is off */}
          {!scannerActive && !scanning && (
            <div className='absolute inset-0 flex items-center justify-center bg-navy-900'>
              <div className='text-center'>
                <i className='fa-solid fa-camera mb-3 text-5xl text-navy-600'></i>
                <p className='text-xs text-navy-500'>Camera is off</p>
              </div>
            </div>
          )}

          {/* Scanning Laser (overlay) */}
          {scannerActive && !scanning && (
            <div
              className='pointer-events-none absolute left-0 right-0 h-0.5'
              style={{ animation: 'scan 2s ease-in-out infinite', top: '50%' }}
            ></div>
          )}

          {/* Success Animation */}
          {scanning && (
            <div className='absolute inset-0 flex animate-pulse items-center justify-center bg-green-500/20'>
              <div className='flex h-20 w-20 animate-scale-in items-center justify-center rounded-full bg-green-500'>
                <i className='fa-solid fa-check text-3xl text-paper'></i>
              </div>
            </div>
          )}

          {/* Error overlay */}
          {scanError && !scannerActive && !scanning && (
            <div
              role='alert'
              className='absolute inset-0 flex flex-col items-center justify-center bg-navy-950/95 p-5'
            >
              <i className='fa-solid fa-circle-exclamation mb-3 text-4xl text-red-500'></i>
              <p className='max-w-[18rem] text-center text-xs leading-relaxed text-red-300'>
                {scanError}
              </p>

              {/* R1 offers the fix rather than just the problem: someone who
                  scanned a room door has clearly arrived, so point them at the
                  check-in flow instead of making them guess what to do next. */}
              {status === 'not-clocked-in' && (
                <Button
                  onClick={startCamera}
                  size='sm'
                  icon='fa-door-open'
                  className='mt-4'
                >
                  Check in at the entrance
                </Button>
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
          className={`flex items-center gap-1.5 text-xs font-semibold transition-colors ${
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
          className={`relative my-2.5 h-6 w-12 rounded-full transition-colors duration-150 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-navy-950 ${
            showQR ? 'bg-yellow-500' : 'bg-navy-700'
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-paper shadow transition-transform duration-150 ${
              showQR ? 'translate-x-6' : 'translate-x-0'
            }`}
          />
        </button>
        <span
          className={`flex items-center gap-1.5 text-xs font-semibold transition-colors ${
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
          <div className='mb-4 inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2'>
            <i className='fa-solid fa-qrcode text-sm text-yellow-400'></i>
            <span className='text-sm font-medium text-yellow-300'>
              Show this QR at reception
            </span>
          </div>
        ) : !scannerActive && !scanning ? (
          <Button
            onClick={startCamera}
            icon='fa-camera'
            className='mb-4'
          >
            {status === 'not-clocked-in'
              ? 'Start camera to check in'
              : 'Open camera to scan'}
          </Button>
        ) : (
          <div className='mb-4 inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2'>
            <i className='fa-solid fa-camera text-sm text-yellow-400'></i>
            <span className='text-sm font-medium text-yellow-300'>
              {status === 'not-clocked-in'
                ? 'Point at the entrance code to check in'
                : 'Point at a room door or the entrance'}
            </span>
          </div>
        )}

        <p className='mx-auto mb-3 max-w-xs text-xs leading-relaxed text-navy-300'>
          {showQR
            ? 'Present this code if the reception desk needs to scan you.'
            : status === 'not-clocked-in'
              ? 'Scan the entrance code to start today’s attendance.'
              : 'You are checked in. Scan a room door to record where you are, or the entrance code to check out.'}
        </p>

        {/* A legend for the three different codes in the building. Each does a
            genuinely different thing and none of them is obvious from the
            poster alone, so the distinction is spelled out here rather than
            left to be inferred from a failed scan. */}
        <div className='mx-auto mb-4 max-w-xs divide-y divide-navy-800 overflow-hidden rounded-xl border border-navy-700 bg-navy-900/50 text-left'>
          <div className='flex items-start gap-2 px-3 py-2'>
            <i className='fa-solid fa-door-open mt-0.5 text-xs text-yellow-400'></i>
            <p className='text-[11px] leading-snug text-navy-300'>
              <span className='font-semibold text-white'>Entrance poster</span> —
              check in on arrival, check out on the way out.
            </p>
          </div>
          <div className='flex items-start gap-2 px-3 py-2'>
            <i className='fa-solid fa-location-dot mt-0.5 text-xs text-yellow-400'></i>
            <p className='text-[11px] leading-snug text-navy-300'>
              <span className='font-semibold text-white'>Room door poster</span> —
              records which room you are in. Never checks you in or out.
              {/* Called out while checked in, because that is the action a trainee
                  actually has available in the building and the scanner gave no
                  hint of it otherwise. */}
              {status !== 'not-clocked-in' && (
                <span className='mt-1 block text-yellow-300'>
                  <i className='fa-solid fa-circle-check mr-1 text-[10px]'></i>
                  You can scan these now.
                </span>
              )}
            </p>
          </div>
          <div className='flex items-start gap-2 px-3 py-2'>
            <i className='fa-solid fa-id-card mt-0.5 text-xs text-yellow-400'></i>
            <p className='text-[11px] leading-snug text-navy-300'>
              <span className='font-semibold text-white'>Your personal code</span> —
              shown on this screen for the reception desk to scan.
            </p>
          </div>
        </div>

        {/* Current state, as one plain line. This replaces a mode toggle: the
            scanner already knows which kind of code was scanned, so there is
            nothing to choose, only something to report. */}
        {status !== 'not-clocked-in' && (
          <p
            aria-live='polite'
            className='mb-3 text-xs font-medium text-navy-300'
          >
            Checked in ·{' '}
            {(() => {
              const current = user ? getCurrentRoom(user.id) : null;
              return current ? `In ${current.roomLabel}` : 'In the lobby';
            })()}
          </p>
        )}

        {/* Confirms the last door scan actually registered. */}
        {lastRoom && !scanError && !scannerActive && (
          <div className='mb-4 inline-flex items-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 px-4 py-2'>
            <i className='fa-solid fa-location-dot text-sm text-green-400'></i>
            <span className='text-sm font-medium text-green-300'>
              Recorded in {lastRoom}
            </span>
          </div>
        )}

        {/* Where they're recorded as being right now. */}
        {user && getCurrentRoom(user.id) && (
          <p className='mb-4 text-xs text-navy-400'>
            Currently in {getCurrentRoom(user.id)?.roomLabel} ·{' '}
            {getCurrentRoom(user.id)?.enteredAt.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        )}
      </div>

      {/* Expired pass. Shown on arrival (the camera never opens) and again if a
          scan somehow reaches the handler. The visitor cannot write attendance
          or room presence from here; the only way forward is verification. */}
      {showExpiredNotice && (
        <div className='fixed inset-0 z-[60] flex items-center justify-center bg-navy-950/85 p-4'>
          <div
            role='dialog'
            aria-modal='true'
            aria-labelledby='expired-pass-heading'
            className='glass-panel w-full max-w-sm rounded-2xl border border-yellow-500/30 p-6 text-center shadow-2xl shadow-black/40'
          >
            <div className='mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-yellow-500/20'>
              <i className='fa-solid fa-clock text-2xl text-yellow-400'></i>
            </div>
            <h3
              id='expired-pass-heading'
              className='mb-2 text-lg font-bold text-white'
            >
              Your pass has expired
            </h3>
            <p className='mb-2 text-sm leading-relaxed text-navy-300'>
              Scanning is paused, so entrance and room codes cannot start,
              change or end a visit. Ask the front desk to renew your pass.
            </p>
            <p className='mb-5 text-xs text-navy-400'>
              Taking you to verification so it can be renewed…
            </p>
            <Button
              onClick={() => router.replace('/verify')}
              className='w-full'
            >
              Go to verification
            </Button>
          </div>
        </div>
      )}

      {/* R2: the check-out confirmation. Shown only when the person is recorded
          inside a room, because that is the one case where the intent behind a
          second entrance scan is genuinely ambiguous. */}
      {pendingClockOut && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-navy-950/80 p-4'>
          <div
            role='dialog'
            aria-modal='true'
            aria-labelledby='checkout-heading'
            className='glass-panel w-full max-w-sm rounded-2xl border border-navy-700 p-6 shadow-2xl shadow-black/40'
          >
            <h3
              id='checkout-heading'
              className='mb-2 text-lg font-bold text-white'
            >
              Leave the building?
            </h3>
            <p className='mb-6 text-sm leading-relaxed text-navy-300'>
              You are recorded in {pendingClockOut.roomLabel}. Checking out
              closes your attendance and that room entry.
            </p>
            <div className='flex gap-3'>
              <Button
                variant='secondary'
                onClick={cancelClockOut}
                className='flex-1'
              >
                Cancel
              </Button>
              <Button
                variant='primary'
                onClick={confirmClockOut}
                className='flex-1'
              >
                Check out anyway
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Already-in-room notice. A dialog rather than the red error overlay,
          because nothing went wrong - the scan was simply redundant. */}
      {alreadyInRoom && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-navy-950/80 p-4'>
          <div
            role='dialog'
            aria-modal='true'
            aria-labelledby='already-in-room-heading'
            className='glass-panel w-full max-w-sm rounded-2xl border border-navy-700 p-6 text-center shadow-2xl shadow-black/40'
          >
            <div className='mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-yellow-500/20'>
              <i className='fa-solid fa-location-dot text-2xl text-yellow-400'></i>
            </div>
            <h3
              id='already-in-room-heading'
              className='mb-2 text-lg font-bold text-white'
            >
              You&apos;re already inside this room
            </h3>
            <p className='mb-6 text-sm leading-relaxed text-navy-300'>
              You&apos;re already recorded in {alreadyInRoom}. No need to scan
              again.
            </p>
            <Button
              onClick={() => setAlreadyInRoom(null)}
              className='w-full'
            >
              Got it
            </Button>
          </div>
        </div>
      )}

    </div>
  );
}
