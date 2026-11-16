'use strict';

const DEFAULT_TIMEZONE = process.env.STORE_TIMEZONE || 'Africa/Johannesburg';

const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_TO_LONG_DAY = {
  sun: 'sunday',
  mon: 'monday',
  tue: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  fri: 'friday',
  sat: 'saturday',
};

function getZonedClock(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(safeNow);
    const map = {};
    parts.forEach((p) => {
      map[p.type] = p.value;
    });
    const shortDay = String(map.weekday || '').slice(0, 3).toLowerCase();
    const dayKey = SHORT_TO_LONG_DAY[shortDay] || WEEKDAY_KEYS[safeNow.getDay()];
    const dayIdx = WEEKDAY_KEYS.indexOf(dayKey);
    const prevDayKey = WEEKDAY_KEYS[(dayIdx + 6) % 7];
    const hour = Math.min(23, Math.max(0, parseInt(map.hour, 10) || 0));
    const minute = Math.min(59, Math.max(0, parseInt(map.minute, 10) || 0));
    return {
      dayKey,
      prevDayKey,
      nowMinutes: hour * 60 + minute,
      hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      timeZone,
    };
  } catch {
    // Fallback if Intl timezone unavailable (e.g. minimal ICU build): apply fixed UTC+2 offset for SAST
    const offsetMs = 2 * 60 * 60 * 1000;
    const shifted = new Date(safeNow.getTime() + offsetMs);
    const dayIdx = shifted.getUTCDay();
    const dayKey = WEEKDAY_KEYS[dayIdx];
    const prevDayKey = WEEKDAY_KEYS[(dayIdx + 6) % 7];
    const hour = shifted.getUTCHours();
    const minute = shifted.getUTCMinutes();
    return {
      dayKey,
      prevDayKey,
      nowMinutes: hour * 60 + minute,
      hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      timeZone: 'Africa/Johannesburg',
    };
  }
}

function parseTimeToMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/\./g, ':').replace(/h/g, ':');
  const match = s.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hh = parseInt(match[1], 10);
  const mm = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;

  if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm < 0 || mm > 59) return null;

  if (meridiem) {
    if (hh < 1 || hh > 12) return null;
    if (meridiem === 'am') {
      hh = hh === 12 ? 0 : hh;
    } else if (meridiem === 'pm') {
      hh = hh === 12 ? 12 : hh + 12;
    }
  } else {
    if (hh === 24 && mm === 0) return 1440;
    if (hh < 0 || hh > 23) return null;
  }

  return hh * 60 + mm;
}

function formatMinutesHHMM(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const norm = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseDisplayRanges(displayStr) {
  if (!displayStr || typeof displayStr !== 'string') return { mode: 'unknown', ranges: [] };
  const cleaned = displayStr.trim();
  const lower = cleaned.toLowerCase();

  if (/24\s*\/\s*7|24\s*hours|always\s*open/.test(lower)) {
    return { mode: 'always_open', ranges: [{ open: 0, close: 1440, overnight: false }] };
  }
  if (/^(closed|unavailable|off)$/i.test(lower)) {
    return { mode: 'closed', ranges: [] };
  }

  const segments = cleaned.split(/[,;/]/).map((p) => p.trim()).filter(Boolean);
  const ranges = [];

  for (const seg of segments) {
    const match = seg.match(
      /(\d{1,2}(?:[:.h]\d{1,2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?:[:.h]\d{1,2})?\s*(?:am|pm)?)/i
    );
    if (!match) continue;
    const openMin = parseTimeToMinutes(match[1]);
    const closeMin = parseTimeToMinutes(match[2]);
    if (openMin === null || closeMin === null) continue;
    if (openMin === closeMin) {
      return { mode: 'always_open', ranges: [{ open: 0, close: 1440, overnight: false }] };
    }
    ranges.push({
      open: openMin,
      close: closeMin,
      overnight: closeMin < openMin,
    });
  }

  return ranges.length > 0 ? { mode: 'ranges', ranges } : { mode: 'unknown', ranges: [] };
}

function parseOpeningHours(openingHours) {
  if (!openingHours) {
    return { display: '08:00 - 21:00', parsed: null };
  }
  if (typeof openingHours === 'object') {
    return {
      display: openingHours.display || '08:00 - 21:00',
      parsed: openingHours,
    };
  }
  const str = String(openingHours).trim();
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj === 'object') {
      return {
        display: obj.display || str,
        parsed: obj,
      };
    }
  } catch {
    // Plain display string
  }
  return {
    display: str || '08:00 - 21:00',
    parsed: null,
  };
}

function getDayEntry(obj, dayKey) {
  if (!obj || typeof obj !== 'object') return null;
  const short = dayKey.slice(0, 3);
  return obj[dayKey] || obj[short] || null;
}

function evaluateStructuredSchedule(obj, clock) {
  const todayEntry = getDayEntry(obj, clock.dayKey);
  const prevEntry = getDayEntry(obj, clock.prevDayKey);

  // Check if yesterday's schedule spilled past midnight into early today
  if (prevEntry && !prevEntry.closed) {
    const pOpen = parseTimeToMinutes(prevEntry.open);
    const pClose = parseTimeToMinutes(prevEntry.close);
    if (pOpen !== null && pClose !== null && pClose < pOpen && clock.nowMinutes < pClose) {
      return {
        isWithinHours: true,
        opensAt: formatMinutesHHMM(pOpen),
        closesAt: formatMinutesHHMM(pClose),
        hasSchedule: true,
      };
    }
  }

  if (!todayEntry) {
    return { isWithinHours: true, opensAt: null, closesAt: null, hasSchedule: false };
  }

  if (todayEntry.closed) {
    return {
      isWithinHours: false,
      opensAt: todayEntry.open ? formatMinutesHHMM(parseTimeToMinutes(todayEntry.open)) : null,
      closesAt: null,
      hasSchedule: true,
    };
  }

  const openMin = parseTimeToMinutes(todayEntry.open);
  const closeMin = parseTimeToMinutes(todayEntry.close);
  if (openMin === null || closeMin === null) {
    return { isWithinHours: true, opensAt: null, closesAt: null, hasSchedule: false };
  }

  const overnight = closeMin < openMin;
  const isOpen = overnight
    ? clock.nowMinutes >= openMin || clock.nowMinutes < closeMin
    : clock.nowMinutes >= openMin && clock.nowMinutes < closeMin;

  return {
    isWithinHours: isOpen,
    opensAt: formatMinutesHHMM(openMin),
    closesAt: formatMinutesHHMM(closeMin),
    hasSchedule: true,
  };
}

function checkOpeningHoursNow(openingHours, now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const { display, parsed } = parseOpeningHours(openingHours);
  const clock = getZonedClock(now, timeZone);

  // Structured per-day schedule takes priority if weekday keys exist
  if (parsed && WEEKDAY_KEYS.some((d) => getDayEntry(parsed, d) !== null)) {
    const res = evaluateStructuredSchedule(parsed, clock);
    if (res.hasSchedule) {
      return {
        ...res,
        display,
        clock,
      };
    }
  }

  const displaySpec = parseDisplayRanges(display);
  if (displaySpec.mode === 'always_open') {
    return { isWithinHours: true, opensAt: null, closesAt: null, hasSchedule: true, display, clock };
  }
  if (displaySpec.mode === 'closed') {
    return { isWithinHours: false, opensAt: null, closesAt: null, hasSchedule: true, display, clock };
  }
  if (displaySpec.mode === 'ranges') {
    let matchedRange = null;
    for (const r of displaySpec.ranges) {
      const openNow = r.overnight
        ? clock.nowMinutes >= r.open || clock.nowMinutes < r.close
        : clock.nowMinutes >= r.open && clock.nowMinutes < r.close;
      if (openNow) {
        matchedRange = r;
        break;
      }
    }
    const primary = matchedRange || displaySpec.ranges[0];
    return {
      isWithinHours: Boolean(matchedRange),
      opensAt: primary ? formatMinutesHHMM(primary.open) : null,
      closesAt: primary ? formatMinutesHHMM(primary.close) : null,
      hasSchedule: true,
      display,
      clock,
    };
  }

  return { isWithinHours: true, opensAt: null, closesAt: null, hasSchedule: false, display, clock };
}

/**
 * Evaluates full store availability combining is_active, manual is_accepting_orders toggle,
 * and scheduled opening_hours in STORE_TIMEZONE.
 */
function evaluateRestaurantAvailability(restaurant, now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  if (!restaurant) {
    return {
      is_active: false,
      manual_is_accepting_orders: false,
      is_within_hours: false,
      is_open_now: false,
      is_accepting_orders: false,
      opening_hours_display: '08:00 - 21:00',
      opens_at: null,
      closes_at: null,
      status_reason: 'not_found',
      status_message: 'Restaurant not found.',
    };
  }

  const isActive = restaurant.is_active !== false;
  const manualAccepting = restaurant.is_accepting_orders !== false;
  const schedule = checkOpeningHoursNow(restaurant.opening_hours, now, timeZone);
  const name = restaurant.name || 'This restaurant';

  let isOpenNow = isActive && manualAccepting && schedule.isWithinHours;
  let statusReason = 'open';
  let statusMessage = '';

  if (!isActive) {
    isOpenNow = false;
    statusReason = 'inactive';
    statusMessage = `${name} is currently unavailable.`;
  } else if (!manualAccepting) {
    isOpenNow = false;
    statusReason = 'paused';
    statusMessage = `${name} is currently paused and not accepting new orders.`;
  } else if (!schedule.isWithinHours) {
    isOpenNow = false;
    statusReason = 'outside_hours';
    statusMessage = schedule.opensAt
      ? `${name} is currently closed (Opening hours: ${schedule.display}). Opens at ${schedule.opensAt}.`
      : `${name} is currently closed (Opening hours: ${schedule.display}).`;
  }

  return {
    is_active: isActive,
    manual_is_accepting_orders: manualAccepting,
    is_within_hours: schedule.isWithinHours,
    is_open_now: isOpenNow,
    is_accepting_orders: isOpenNow,
    opening_hours_display: schedule.display,
    opens_at: schedule.opensAt,
    closes_at: schedule.closesAt,
    current_store_time: schedule.clock.hhmm,
    status_reason: statusReason,
    status_message: statusMessage,
  };
}

/**
 * Enriches a customer-facing restaurant/menu record with live opening-hours availability.
 * Preserves `manual_is_accepting_orders` while exposing effective open status in `is_accepting_orders` and `is_open_now`.
 */
function applyAvailabilityToRestaurant(row, now = new Date()) {
  if (!row || typeof row !== 'object') return row;
  const effectiveNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const avail = evaluateRestaurantAvailability(
    {
      name: row.restaurant_name || row.name,
      is_active: row.is_active !== undefined ? row.is_active : true,
      is_accepting_orders: row.is_accepting_orders,
      opening_hours: row.opening_hours,
    },
    effectiveNow
  );

  return {
    ...row,
    opening_hours_display: avail.opening_hours_display,
    manual_is_accepting_orders: avail.manual_is_accepting_orders,
    is_within_hours: avail.is_within_hours,
    is_open_now: avail.is_open_now,
    is_accepting_orders: avail.is_open_now,
    closed_reason: avail.is_open_now ? null : avail.status_message,
    opens_at: avail.opens_at,
    closes_at: avail.closes_at,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  getZonedClock,
  parseOpeningHours,
  checkOpeningHoursNow,
  evaluateRestaurantAvailability,
  applyAvailabilityToRestaurant,
};
