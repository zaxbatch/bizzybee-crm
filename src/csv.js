'use strict';

/**
 * Minimal CSV support (RFC 4180):
 *  - parseCsv: handles quoted fields, embedded commas / newlines / escaped
 *    quotes, CRLF or LF line endings, and a leading UTF-8 BOM.
 *  - toCsv: the same quoting rules used by the CRM's CSV export.
 */

/** Quote a field when it contains a comma, quote or newline. */
function csvField(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Serialize rows (arrays of values) to CSV text with CRLF endings. */
function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/**
 * Parse CSV text into an array of row arrays. Empty lines are dropped.
 * A leading UTF-8 BOM is stripped.
 */
function parseCsv(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  // Last record (no trailing newline).
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

module.exports = { parseCsv, toCsv, csvField };
