// CSV files that open cleanly in Excel and Google Sheets.
// The BOM makes Excel read the file as UTF-8, so names with accents and "×" survive.

// A cell starting with = + - @ could run as a formula in Excel, so it is prefixed with an apostrophe.
// Plain numbers (including negatives) are left alone so they stay numbers.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(headers, rows) {
  return '﻿' + [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function sendCsv(res, filename, headers, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(toCsv(headers, rows));
}

module.exports = { toCsv, sendCsv };
