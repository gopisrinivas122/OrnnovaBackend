const XLSX = require('xlsx');
const path = require('path');

function normalizeHeader(header = '') {
  return String(header).trim().toLowerCase().replace(/\s+/g, ' ');
}

function mapRowToSchema(row = {}, aliases = {}) {
  const mapped = {};
  const normalizedEntries = Object.entries(row).map(([key, value]) => [
    normalizeHeader(key),
    value,
  ]);

  Object.entries(aliases).forEach(([schemaKey, headerNames]) => {
    const candidates = [schemaKey.toLowerCase(), ...headerNames.map(normalizeHeader)];
    for (const [header, value] of normalizedEntries) {
      if (candidates.includes(header)) {
        mapped[schemaKey] = value;
        break;
      }
    }
  });

  return mapped;
}

function parseImportDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const serial = Number(value);
  if (!Number.isNaN(serial) && serial > 25569 && serial < 60000) {
    const parts = XLSX.SSF.parse_date_code(serial);
    if (parts?.y) {
      return new Date(parts.y, parts.m - 1, parts.d);
    }
  }

  const isoMatch = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const date = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const dmyMatch = String(value).trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const date = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  return null;
}

function toStringValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function toNumberValue(value, fallback = undefined) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isNaN(num) ? fallback : num;
}

function parseListValue(value) {
  const text = toStringValue(value);
  if (!text) return [];
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function buildImportResponse(imported, errors = []) {
  return {
    status: imported > 0 ? 'Success' : 'Error',
    imported,
    failed: errors.length,
    errors,
    created: imported,
    msg: imported > 0
      ? `Imported ${imported} record(s) successfully.`
      : 'No records were imported.',
  };
}

function validateRequiredColumns(rows, requiredKeys, aliases) {
  if (!rows.length) {
    return { ok: false, reason: 'Worksheet is empty.' };
  }

  const headerProbe = {};
  Object.keys(rows[0] || {}).forEach((header) => {
    headerProbe[header] = 'probe';
  });
  const mappedHeaders = mapRowToSchema(headerProbe, aliases);
  const matchedRequired = requiredKeys.filter((key) => mappedHeaders[key] !== undefined);

  if (!matchedRequired.length) {
    const foundHeaders = Object.keys(rows[0] || {}).join(', ') || 'none';
    return {
      ok: false,
      reason: `Missing required columns. Expected: ${requiredKeys.join(', ')}. Found: ${foundHeaders}`,
    };
  }

  return { ok: true };
}

module.exports = {
  normalizeHeader,
  mapRowToSchema,
  parseImportDate,
  toStringValue,
  toNumberValue,
  parseListValue,
  buildImportResponse,
  validateRequiredColumns,
};
