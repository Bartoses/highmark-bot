// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC DATE EXTRACTION
//
// Pulls a single calendar date out of a free-form guest message. Used in the
// booking flow to filter available tour slots by date. Replaces the per-message
// Claude call that previously handled this — same coverage, zero latency, zero
// token cost, and fully testable.
//
// Returns "YYYY-MM-DD" or null. On any parse error: null (caller treats as
// "no date specified" and shows the generic tour menu).
//
// Timezone: Dates are produced in the local calendar day of the `now` argument.
// Production calls pass `new Date()`; tests pass a fixed anchor so weekday /
// month-rollover logic is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_MAP = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS = [
  ["january",   "jan"],
  ["february",  "feb"],
  ["march",     "mar"],
  ["april",     "apr"],
  ["may"],
  ["june",      "jun"],
  ["july",      "jul"],
  ["august",    "aug"],
  ["september", "sep", "sept"],
  ["october",   "oct"],
  ["november",  "nov"],
  ["december",  "dec"],
];

function monthIndex(name) {
  const lower = name.toLowerCase().replace(/\.$/, "");
  for (let i = 0; i < MONTHS.length; i++) {
    if (MONTHS[i].includes(lower)) return i;
  }
  return -1;
}

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

// Next occurrence of `targetDow` strictly after `now` (today excluded).
// If `nextWeek` is true, add 7 more days so "next Friday" ≠ "this Friday".
function nextWeekday(now, targetDow, { nextWeek = false } = {}) {
  const today = startOfDay(now);
  const diff  = ((targetDow - today.getDay() + 7) % 7) || 7;
  const d     = new Date(today);
  d.setDate(today.getDate() + diff + (nextWeek ? 7 : 0));
  return d;
}

// Next Saturday strictly after `now`. "This weekend" = the coming Saturday;
// "next weekend" = the Saturday after.
function nextWeekend(now, { nextWeek = false } = {}) {
  return nextWeekday(now, 6, { nextWeek });
}

export function extractDateFromMessage(message, now = new Date()) {
  if (typeof message !== "string" || !message.trim()) return null;
  const t = message.toLowerCase();
  const today = startOfDay(now);

  try {
    // 1. YYYY-MM-DD (ISO) — first so it beats generic digit patterns below.
    const iso = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (iso) {
      const y = parseInt(iso[1], 10);
      const m = parseInt(iso[2], 10);
      const d = parseInt(iso[3], 10);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        const parsed = new Date(y, m - 1, d);
        if (parsed.getMonth() === m - 1 && parsed.getDate() === d) {
          return toYmd(parsed);
        }
      }
    }

    // 2. Relative day words — order matters: "day after tomorrow" must beat
    //    the bare "tomorrow" pattern, so check multi-word phrases first.
    if (/\bday after tomorrow\b/.test(t)) {
      const d = new Date(today);
      d.setDate(today.getDate() + 2);
      return toYmd(d);
    }
    if (/\btoday\b|\btonight\b/.test(t))        return toYmd(today);
    if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(t)) {
      const d = new Date(today);
      d.setDate(today.getDate() + 1);
      return toYmd(d);
    }

    // 3. Weekend phrases — check before weekday names so "this weekend"
    //    doesn't get picked off by a stray "sun" match.
    if (/\bnext weekend\b/.test(t)) return toYmd(nextWeekend(today, { nextWeek: true }));
    if (/\b(this\s+)?weekend\b/.test(t)) return toYmd(nextWeekend(today));

    // 4. Weekday name (with optional "next " prefix)
    const weekdayNames = Object.keys(WEEKDAY_MAP).join("|");
    const wd = t.match(new RegExp(`\\b(next\\s+)?(${weekdayNames})\\b`));
    if (wd) {
      const isNext = Boolean(wd[1]);
      const dow    = WEEKDAY_MAP[wd[2]];
      return toYmd(nextWeekday(today, dow, { nextWeek: isNext }));
    }

    // 5. Month name + day: "December 15", "Dec 15th", "Jan 3", "sept 7"
    const monthPattern = MONTHS.flat().join("|");
    const md = t.match(new RegExp(
      `\\b(${monthPattern})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`
    ));
    if (md) {
      const mi    = monthIndex(md[1]);
      const day   = parseInt(md[2], 10);
      const year  = md[3] ? parseInt(md[3], 10) : today.getFullYear();
      if (mi >= 0 && day >= 1 && day <= 31) {
        const parsed = new Date(year, mi, day);
        if (parsed.getMonth() === mi && parsed.getDate() === day) {
          // If no explicit year and the date is already in the past, roll forward
          if (!md[3] && parsed < today) parsed.setFullYear(year + 1);
          return toYmd(parsed);
        }
      }
    }

    // 6. Day + month: "15 December", "3rd of January"
    const dm = t.match(new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${monthPattern})\\b`
    ));
    if (dm) {
      const day = parseInt(dm[1], 10);
      const mi  = monthIndex(dm[2]);
      if (mi >= 0 && day >= 1 && day <= 31) {
        const parsed = new Date(today.getFullYear(), mi, day);
        if (parsed.getMonth() === mi && parsed.getDate() === day) {
          if (parsed < today) parsed.setFullYear(today.getFullYear() + 1);
          return toYmd(parsed);
        }
      }
    }

    // 7. MM/DD or MM/DD/YY(YY)
    const slash = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (slash) {
      const m   = parseInt(slash[1], 10);
      const d   = parseInt(slash[2], 10);
      let   y   = slash[3] ? parseInt(slash[3], 10) : today.getFullYear();
      if (slash[3] && y < 100) y += 2000;
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        const parsed = new Date(y, m - 1, d);
        if (parsed.getMonth() === m - 1 && parsed.getDate() === d) {
          if (!slash[3] && parsed < today) parsed.setFullYear(y + 1);
          return toYmd(parsed);
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
