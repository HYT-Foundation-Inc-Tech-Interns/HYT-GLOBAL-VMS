'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useRecordsStore, formatDurationMinutes, type ClockInRecord } from '@/store/recordsStore';
import { useLiveData } from '@/hooks/useLiveData';
import Link from 'next/link';
import UserProfile from '@/components/UserProfile';

/** Columns the records table can be sorted by. */
type SortKey =
  | 'userName'
  | 'courseLabel'
  | 'purposeLabel'
  | 'timeIn'
  | 'timeOut'
  | 'durationMinutes'
  | 'status';

/**
 * Reduces a record to a value the comparator can order.
 *
 * Nullable fields collapse to +Infinity so an unset value (no time out, no
 * duration, no course) sorts to the end rather than jumping to the top - an
 * empty cell at the front of an ascending sort reads as a bug.
 */
function sortValue(record: ClockInRecord, key: SortKey): string | number {
  switch (key) {
    case 'timeIn':
      return record.timeIn.getTime();
    case 'timeOut':
      return record.timeOut ? record.timeOut.getTime() : Number.POSITIVE_INFINITY;
    case 'durationMinutes':
      return record.durationMinutes ?? Number.POSITIVE_INFINITY;
    case 'userName':
      return (record.userName ?? '').toLowerCase();
    case 'courseLabel':
      return (record.courseLabel ?? '').toLowerCase();
    case 'purposeLabel':
      return (record.purposeLabel ?? '').toLowerCase();
    case 'status':
      return record.status;
  }
}

export default function RecordsPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const { records } = useRecordsStore();

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed'>('all');
  // Date selection. Year + month are always applied; the day is optional —
  // leaving it on 'All days' shows the whole selected month.
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(String(now.getFullYear()));
  const [selectedMonth, setSelectedMonth] = useState(String(now.getMonth() + 1));
  const [selectedDay, setSelectedDay] = useState(String(now.getDate()));
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // Column sorting. `timeIn` descending is the default because the table is a
  // log: the most recent check-in is the one an admin almost always wants first.
  const [sortKey, setSortKey] = useState<SortKey>('timeIn');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Keep the table live. It used to fetch once on mount, so a new check-in
  // never appeared until the page was reloaded.
  useLiveData({
    records: 'all',
    presence: 'none',
    enabled: isAuthenticated && user?.role === 'admin',
  });

  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'admin') {
      router.push('/login');
    }
  }, [isAuthenticated, user, router]);

  // Close the export menu when clicking outside of it
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(event.target as Node)) {
        setExportOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!isAuthenticated || user?.role !== 'admin') {
    return null;
  }

  // Filter records
  // Dates are compared field-by-field using LOCAL time, so a record matches the
  // calendar day the admin sees regardless of timezone offset in the stored value.
  const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  // Number of days in the selected month/year (0 = all days of the month)
  const daysInSelectedMonth = new Date(
    Number(selectedYear),
    Number(selectedMonth),
    0
  ).getDate();

  // Years available to pick from: any year present in the records, plus the current year
  const availableYears = Array.from(
    new Set([
      String(now.getFullYear()),
      ...records.map((r) => String(new Date(r.timeIn).getFullYear())),
    ])
  )
    .map(Number)
    .sort((a, b) => b - a);

  const filteredRecords = records.filter((record) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      record.userName?.toLowerCase().includes(term) ||
      record.userId.toLowerCase().includes(term) ||
      // `destination` no longer exists; the room name and the purpose are the
      // two things that now identify where someone was going and why.
      (record.purposeLabel?.toLowerCase().includes(term) ?? false) ||
      (record.courseLabel?.toLowerCase().includes(term) ?? false) ||
      record.room.toLowerCase().includes(term);

    const matchesStatus = statusFilter === 'all' || record.status === statusFilter;

    const timeIn = new Date(record.timeIn);
    const matchesDate =
      timeIn.getFullYear() === Number(selectedYear) &&
      timeIn.getMonth() + 1 === Number(selectedMonth) &&
      (selectedDay === 'all' || timeIn.getDate() === Number(selectedDay));

    return matchesSearch && matchesStatus && matchesDate;
  });

  // Clicking a header sorts by it; clicking the active header flips direction.
  // Switching to a new column starts ascending, which is what "sort by this"
  // means when the column is not already the sort.
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedRecords = [...filteredRecords].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const dir = sortDir === 'asc' ? 1 : -1;
    if (typeof av === 'number' && typeof bv === 'number') {
      // Unset values (no time out, no duration) sink to the bottom whichever
      // direction is active, rather than flipping to the top on a descending sort.
      if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
      if (!Number.isFinite(av)) return 1;
      if (!Number.isFinite(bv)) return -1;
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });

  // A sortable header: the whole label is the click target, and the arrow shows
  // the current column and direction (a faint fa-sort marks the inactive ones).
  const sortHeader = (label: string, key: SortKey) => (
    <button
      type='button'
      onClick={() => toggleSort(key)}
      className='flex items-center gap-2 uppercase tracking-wider hover:text-white transition-colors'
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      <i
        className={`fa-solid text-[10px] ${
          sortKey === key
            ? sortDir === 'asc'
              ? 'fa-arrow-up text-yellow-400'
              : 'fa-arrow-down text-yellow-400'
            : 'fa-sort text-navy-600'
        }`}
      ></i>
    </button>
  );

  // --- Export helpers -------------------------------------------------------
  // Shared tabular view of the currently filtered records.
  const buildExportData = () => {
    const headers = [
      'User',
      'User ID',
      'Course',
      'Purpose',
      'Building',
      'Room',
      'Time In',
      'Time Out',
      'Duration',
      'Status',
    ];

    // Exported in the order shown on screen, so a sorted view and its export agree.
    const rows = sortedRecords.map((record) => [
      record.userName || 'User ' + record.userId.slice(0, 8),
      record.userId,
      record.courseLabel ?? '',
      record.purposeLabel ?? '',
      record.building ?? '',
      record.room,
      record.timeIn.toLocaleString('en-US'),
      record.timeOut ? record.timeOut.toLocaleString('en-US') : '',
      // Generated by Postgres; null while the visit is still open.
      formatDurationMinutes(record.durationMinutes),
      record.status,
    ]);

    return { headers, rows };
  };

  const periodLabel =
    selectedDay === 'all'
      ? `${MONTH_NAMES[Number(selectedMonth) - 1]} ${selectedYear}`
      : `${MONTH_NAMES[Number(selectedMonth) - 1]} ${selectedDay}, ${selectedYear}`;

  const exportFileName = (ext: string) =>
    'attendance-records-' + selectedYear + '-' + selectedMonth + '-' + selectedDay + '.' + ext;

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // CSV (.csv)
  const handleExportCSV = () => {
    const { headers, rows } = buildExportData();
    const csvEscape = (value: string) => '"' + value.replace(/"/g, '""') + '"';
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => csvEscape(String(cell))).join(','))
      .join('\n');
    // Prepend a UTF-8 BOM so Excel reads the encoding correctly
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, exportFileName('csv'));
  };

  // Excel (.xls) - an HTML table Excel opens natively (no extra dependency)
  const handleExportExcel = () => {
    const { headers, rows } = buildExportData();
    const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
    const body = rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`
      )
      .join('');
    const html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
      'xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8" /></head>' +
      `<body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
    const blob = new Blob(['\uFEFF' + html], {
      type: 'application/vnd.ms-excel;charset=utf-8;',
    });
    downloadBlob(blob, exportFileName('xls'));
  };

  // JSON (.json)
  const handleExportJSON = () => {
    const { headers, rows } = buildExportData();
    const data = rows.map((row) =>
      headers.reduce<Record<string, string>>((acc, header, i) => {
        acc[header] = String(row[i]);
        return acc;
      }, {})
    );
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8;',
    });
    downloadBlob(blob, exportFileName('json'));
  };

  // PDF - opens a print-ready report; choose "Save as PDF" in the print dialog
  const handleExportPDF = () => {
    const { headers, rows } = buildExportData();
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
    const body = rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`
      )
      .join('');

    printWindow.document.write(
      '<!doctype html><html><head><title>Attendance Records</title>' +
        '<meta charset="utf-8" />' +
        '<style>' +
        'body { font-family: Arial, Helvetica, sans-serif; padding: 24px; color: #111; }' +
        'h1 { font-size: 18px; margin: 0 0 4px; }' +
        'p { font-size: 12px; color: #555; margin: 0 0 16px; }' +
        'table { width: 100%; border-collapse: collapse; font-size: 11px; }' +
        'th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }' +
        'th { background: #f3f4f6; text-transform: uppercase; letter-spacing: 0.03em; }' +
        '</style></head><body>' +
        '<h1>Attendance Records</h1>' +
        `<p>${filteredRecords.length} record(s) &middot; ${escapeHtml(periodLabel)}</p>` +
        `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` +
        '</body></html>'
    );
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  return (
    <>
      <div className='min-h-screen'>
        {/* Header */}
        <header className='app-header border-b sticky top-0 z-50'>
          <div className='max-w-7xl mx-auto px-4 py-3 flex items-center justify-between'>
            <div className='flex items-center gap-3'>
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
                    Attendance Records
                  </h1>
                  <p className='text-navy-300 text-xs mt-0.5'>
                    All check-in/check-out logs
                  </p>
                </div>
              </Link>
            </div>

            <UserProfile />
          </div>
        </header>

        {/* Main Content */}
        <main className='max-w-7xl mx-auto px-4 py-5'>
          {/* Page Header */}
          <div className='flex items-center justify-between mb-6'>
            <Link
              href='/admin'
              className='text-navy-300 hover:text-navy-200 flex items-center gap-2 transition-colors'
            >
              <i className='fa-solid fa-arrow-left'></i>
              <span>Back to Dashboard</span>
            </Link>

            <div className='relative' ref={exportRef}>
              <button
                onClick={() => setExportOpen((v) => !v)}
                className='px-4 py-2 rounded-lg bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 hover:bg-yellow-500/30 transition-colors flex items-center gap-2'
              >
                <i className='fa-solid fa-download'></i>
                Export
                <i
                  className={`fa-solid fa-chevron-down text-xs transition-transform ${exportOpen ? 'rotate-180' : ''}`}
                ></i>
              </button>

              {exportOpen && (
                <div className='absolute right-0 mt-2 w-52 bg-navy-900 border border-navy-700 rounded-lg shadow-black/50 overflow-hidden z-50'>
                  {[
                    { label: 'CSV (.csv)', icon: 'fa-file-csv', handler: handleExportCSV },
                    {
                      label: 'Excel (.xls)',
                      icon: 'fa-file-excel',
                      handler: handleExportExcel,
                    },
                    { label: 'PDF', icon: 'fa-file-pdf', handler: handleExportPDF },
                    { label: 'JSON (.json)', icon: 'fa-file-code', handler: handleExportJSON },
                  ].map((option) => (
                    <button
                      key={option.label}
                      onClick={() => {
                        setExportOpen(false);
                        option.handler();
                      }}
                      className='w-full px-4 py-2.5 text-left text-navy-200 hover:bg-navy-800/50 hover:text-white transition-colors flex items-center gap-3'
                    >
                      <i className={`fa-solid ${option.icon} w-5`}></i>
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className='glass-panel border-navy-800 rounded-lg p-6 mb-6'>
            <div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
              {/* Search */}
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
                    placeholder='Search by name, course, purpose, or room...'
                    className='
                      w-full pl-12 pr-4 py-3 rounded-lg
                      bg-navy-900/50 border border-navy-700
                      text-white placeholder-navy-500
                      focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                      transition-colors
                      '
                  />
                </div>
              </div>

              {/* Status Filter */}
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Status
                </label>
                <div className='flex gap-2'>
                  {(['all', 'active', 'completed'] as const).map((status) => (
                    <button
                      key={status}
                      onClick={() => setStatusFilter(status)}
                      className={`
                  flex-1 px-4 py-3 rounded-lg font-semibold text-sm transition-colors
                  ${
                    statusFilter === status
                      ? 'bg-yellow-500/20 text-yellow-300 border-2 border-yellow-500'
                      : 'bg-navy-900/50 text-navy-300 border-2 border-navy-700 hover:border-navy-600'
                  }
                      `}
                    >
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date Filter - month/year required, day optional */}
              <div>
                <label className='block text-sm font-medium text-navy-200 mb-2'>
                  Date
                </label>
                <div className='flex gap-2'>
                  {/* Month */}
                  <div className='relative flex-1'>
                    <select
                      value={selectedMonth}
                      onChange={(e) => {
                        const month = e.target.value;
                        setSelectedMonth(month);
                        // Reset the day if the new month has fewer days
                        const maxDay = new Date(
                          Number(selectedYear),
                          Number(month),
                          0
                        ).getDate();
                        if (selectedDay !== 'all' && Number(selectedDay) > maxDay) {
                          setSelectedDay(String(maxDay));
                        }
                      }}
                      className='
                        w-full px-4 py-3 rounded-lg appearance-none
                        bg-navy-900/50 border border-navy-700
                        text-white font-semibold text-sm
                        focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                        transition-colors cursor-pointer
                        '
                    >
                      {MONTH_NAMES.map((name, i) => (
                        <option key={name} value={String(i + 1)} className='bg-navy-900'>
                          {name}
                        </option>
                      ))}
                    </select>
                    <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-300 text-xs pointer-events-none'></i>
                  </div>

                  {/* Year */}
                  <div className='relative w-28'>
                    <select
                      value={selectedYear}
                      onChange={(e) => {
                        const year = e.target.value;
                        setSelectedYear(year);
                        const maxDay = new Date(
                          Number(year),
                          Number(selectedMonth),
                          0
                        ).getDate();
                        if (selectedDay !== 'all' && Number(selectedDay) > maxDay) {
                          setSelectedDay(String(maxDay));
                        }
                      }}
                      className='
                        w-full px-4 py-3 rounded-lg appearance-none
                        bg-navy-900/50 border border-navy-700
                        text-white font-semibold text-sm
                        focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                        transition-colors cursor-pointer
                        '
                    >
                      {availableYears.map((year) => (
                        <option key={year} value={String(year)} className='bg-navy-900'>
                          {year}
                        </option>
                      ))}
                    </select>
                    <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-300 text-xs pointer-events-none'></i>
                  </div>

                  {/* Day (optional) */}
                  <div className='relative flex-1'>
                    <select
                      value={selectedDay}
                      onChange={(e) => setSelectedDay(e.target.value)}
                      className='
                        w-full px-4 py-3 rounded-lg appearance-none
                        bg-navy-900/50 border border-navy-700
                        text-white font-semibold text-sm
                        focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500
                        transition-colors cursor-pointer
                        '
                    >
                      <option value='all' className='bg-navy-900'>
                        All days
                      </option>
                      {Array.from({ length: daysInSelectedMonth }, (_, i) => i + 1).map(
                        (day) => (
                          <option key={day} value={String(day)} className='bg-navy-900'>
                            Day {day}
                          </option>
                        )
                      )}
                    </select>
                    <i className='fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-navy-300 text-xs pointer-events-none'></i>
                  </div>
                </div>

                {/* Active date description */}
                <p className='text-navy-500 text-xs mt-2'>
                  Showing{' '}
                  {selectedDay === 'all'
                    ? `all records in ${MONTH_NAMES[Number(selectedMonth) - 1]} ${selectedYear}`
                    : `${MONTH_NAMES[Number(selectedMonth) - 1]} ${selectedDay}, ${selectedYear}`}
                </p>
              </div>
            </div>
          </div>

          {/* Records Table */}
          <div className='glass-panel border-navy-800 rounded-lg overflow-hidden'>
            <div className='overflow-x-auto'>
              <table className='w-full'>
                <thead className='bg-navy-900/50 border-b border-navy-800'>
                  <tr>
                    <th className='px-4 py-3 text-left text-xs font-semibold text-navy-300'>
                      {sortHeader('User', 'userName')}
                    </th>
                    <th className='px-4 py-3 text-left text-xs font-semibold text-navy-300'>
                      {sortHeader('Course', 'courseLabel')}
                    </th>
                    <th className='px-4 py-3 text-left text-xs font-semibold text-navy-300'>
                      {sortHeader('Purpose / Room', 'purposeLabel')}
                    </th>
                    <th className='px-4 py-3 text-left text-xs font-semibold text-navy-300'>
                      {sortHeader('Time In', 'timeIn')}
                    </th>
                    <th className='px-4 py-3 text-left text-xs font-semibold text-navy-300'>
                      {sortHeader('Time Out', 'timeOut')}
                    </th>
                    <th className='px-4 py-3 text-left text-xs font-semibold text-navy-300'>
                      {sortHeader('Duration', 'durationMinutes')}
                    </th>
                    <th className='px-4 py-3 text-left text-xs font-semibold text-navy-300'>
                      {sortHeader('Status', 'status')}
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-navy-800'>
                  {sortedRecords.map((record) => (
                    <tr
                      key={record.id}
                      className='hover:bg-navy-900/30 transition-colors'
                    >
                      <td className='px-4 py-3 whitespace-nowrap'>
                        <div className='flex items-center gap-3'>
                          <div className='w-10 h-10 rounded-lg bg-yellow-500/20 flex items-center justify-center'>
                            <i className='fa-solid fa-user text-yellow-400'></i>
                          </div>
                          <div>
                            <p className='text-white font-semibold'>
                              {record.userName || 'User ' + record.userId.slice(0, 8)}
                            </p>
                            <p className='text-navy-500 text-xs'>{record.userId}</p>
                          </div>
                        </div>
                      </td>
                      <td className='px-4 py-3 whitespace-nowrap'>
                        {record.courseLabel ? (
                          <span className='px-2.5 py-1 rounded-md bg-yellow-500/10 text-yellow-300 border border-yellow-500/20 text-xs font-medium'>
                            {record.courseLabel}
                          </span>
                        ) : (
                          <span className='text-navy-500 text-sm'>—</span>
                        )}
                      </td>
                      <td className='px-4 py-3'>
                        <p className='text-white font-medium'>
                          {record.purposeLabel || 'No purpose recorded'}
                        </p>
                        <p className='text-navy-300 text-sm'>
                          {record.building ? `${record.building} • ` : ''}
                          {record.room}
                        </p>
                      </td>
                      <td className='px-4 py-3 whitespace-nowrap text-navy-200'>
                        {record.timeIn.toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className='px-4 py-3 whitespace-nowrap text-navy-200'>
                        {record.timeOut
                          ? record.timeOut.toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '—'}
                      </td>
                      <td className='px-4 py-3 whitespace-nowrap text-navy-200'>
                        {formatDurationMinutes(record.durationMinutes)}
                      </td>
                      <td className='px-4 py-3 whitespace-nowrap'>
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                            record.status === 'active'
                              ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                              : 'bg-navy-700 text-navy-200'
                          }`}
                        >
                          {record.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filteredRecords.length === 0 && (
                <div className='text-center py-8'>
                  <i className='fa-solid fa-inbox text-navy-600 text-5xl mb-4'></i>
                  <p className='text-navy-300 text-lg'>No records found</p>
                  <p className='text-navy-500 text-sm mt-1'>
                    No check-in records for the selected date. Try another month or day,
                    or adjust your filters.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Results Summary */}
          <div className='mt-4 text-center text-navy-300 text-sm'>
            Showing {filteredRecords.length} of {records.length} records
            {selectedDay === 'all'
              ? ` (${MONTH_NAMES[Number(selectedMonth) - 1]} ${selectedYear})`
              : ` (${MONTH_NAMES[Number(selectedMonth) - 1]} ${selectedDay}, ${selectedYear})`}
          </div>
        </main>
      </div>
    </>
  );
}
