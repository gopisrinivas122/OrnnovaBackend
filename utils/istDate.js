const IST_TIME_ZONE = 'Asia/Kolkata';

function parseInstant(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() < 1971) return null;
  return parsed;
}

function toISTDateKey(date) {
  if (!date) return '';
  return date.toLocaleDateString('en-CA', { timeZone: IST_TIME_ZONE });
}

function isSameISTDay(value, reference = new Date()) {
  const instant = parseInstant(value);
  if (!instant) return false;
  return toISTDateKey(instant) === toISTDateKey(reference);
}

function isISTCalendarDateInRange(value, fromDateKey, toDateKey) {
  const instant = parseInstant(value);
  if (!instant) return false;
  const key = toISTDateKey(instant);
  if (!key) return false;
  if (fromDateKey && key < fromDateKey) return false;
  if (toDateKey && key > toDateKey) return false;
  return true;
}

function isISTCalendarDateOnOrBefore(value, dateKey) {
  const instant = parseInstant(value);
  if (!instant || !dateKey) return false;
  const key = toISTDateKey(instant);
  return Boolean(key) && key <= dateKey;
}

module.exports = {
  IST_TIME_ZONE,
  parseInstant,
  toISTDateKey,
  isSameISTDay,
  isISTCalendarDateInRange,
  isISTCalendarDateOnOrBefore,
};
