/**
 * Time and date manipulation utilities for RemindMe.
 * Compatible with Node.js 12+ (no optional chaining or nullish coalescing).
 */

'use strict';

function pad(n, width) {
  if (width === undefined) width = 2;
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

/**
 * Format a Date object to "YYYY-MM-DD HH:mm:ss" string in local time.
 */
function dtToStr(dt) {
  if (!dt || isNaN(new Date(dt).getTime())) return null;
  var d = new Date(dt);
  var y = d.getFullYear();
  var m = pad(d.getMonth() + 1);
  var day = pad(d.getDate());
  var h = pad(d.getHours());
  var min = pad(d.getMinutes());
  var s = pad(d.getSeconds());
  return y + '-' + m + '-' + day + ' ' + h + ':' + min + ':' + s;
}

/**
 * Format a Date object to "YYYY-MM-DDTHH:mm:ss" string in local time.
 */
function dtToIsoLocal(dt) {
  if (!dt || isNaN(new Date(dt).getTime())) return null;
  var d = new Date(dt);
  var y = d.getFullYear();
  var m = pad(d.getMonth() + 1);
  var day = pad(d.getDate());
  var h = pad(d.getHours());
  var min = pad(d.getMinutes());
  var s = pad(d.getSeconds());
  return y + '-' + m + '-' + day + 'T' + h + ':' + min + ':' + s;
}

/**
 * Parse an ISO or SQLite date string into a local Date object.
 */
function strToDt(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  var clean = String(val).trim();
  if (!clean) return null;

  // If ending with Z or timezone offset, standard Date parsing works
  if (/[Zz]$/.test(clean) || /[+-]\d{2}:?\d{2}$/.test(clean.replace(' ', 'T'))) {
    var dUtc = new Date(clean.replace(' ', 'T'));
    return isNaN(dUtc.getTime()) ? null : dUtc;
  }

  // Treat as local wall clock time
  var norm = clean.replace(' ', 'T');
  var parts = norm.split('T');
  var dateParts = parts[0].split('-').map(Number);
  var y = dateParts[0];
  var m = dateParts[1] - 1;
  var day = dateParts[2];

  var h = 0, min = 0, sec = 0, ms = 0;
  if (parts.length > 1 && parts[1]) {
    var timeParts = parts[1].split(':');
    h = Number(timeParts[0]) || 0;
    min = Number(timeParts[1]) || 0;
    if (timeParts.length > 2) {
      var secParts = timeParts[2].split('.');
      sec = Number(secParts[0]) || 0;
      if (secParts.length > 1) {
        ms = Number(secParts[1].slice(0, 3)) || 0;
      }
    }
  }

  var d = new Date(y, m, day, h, min, sec, ms);
  return isNaN(d.getTime()) ? null : d;
}

function localNow() {
  return new Date();
}

/**
 * Parse a time string e.g. "08:30" or "08:30:00" into { hour, minute, second }
 */
function parseTimeValue(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return {
      hour: val.getHours(),
      minute: val.getMinutes(),
      second: val.getSeconds()
    };
  }
  var clean = String(val).trim();
  if (clean.indexOf('T') !== -1) {
    clean = clean.split('T')[1];
  } else if (clean.indexOf(' ') !== -1) {
    clean = clean.split(' ')[1];
  }
  var parts = clean.split(':');
  if (parts.length < 2) return null;
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var s = parts.length > 2 ? parseInt(parts[2], 10) : 0;
  if (isNaN(h) || isNaN(m)) return null;
  return { hour: h, minute: m, second: isNaN(s) ? 0 : s };
}

/**
 * Format { hour, minute, second } or Date or string into "HH:mm:ss"
 */
function formatTimeValue(val) {
  if (!val) return null;
  var parsed = parseTimeValue(val);
  if (!parsed) return null;
  return pad(parsed.hour) + ':' + pad(parsed.minute) + ':' + pad(parsed.second);
}

/**
 * Format { hour, minute, second } or Date or string into "8:00 AM" / "1:30 PM"
 */
function formatTime12(val) {
  if (!val) return '—';
  var parsed = parseTimeValue(val);
  if (!parsed) return String(val);
  var h = parsed.hour;
  var ampm = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + pad(parsed.minute) + ' ' + ampm;
}

/**
 * Create a new Date with the given time on the same date as baseDate
 */
function combineTimeWithToday(timeVal, baseDate) {
  var base = baseDate ? new Date(baseDate) : localNow();
  var parsed = parseTimeValue(timeVal);
  if (!parsed) return base;
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    parsed.hour,
    parsed.minute,
    parsed.second,
    0
  );
}

/**
 * Combine a date with hour, minute, second
 */
function combineDateTime(baseDate, hour, minute, second) {
  var base = baseDate ? new Date(baseDate) : localNow();
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hour || 0,
    minute || 0,
    second || 0,
    0
  );
}

// Days mapping: JS getDay() is 0=Sun, 1=Mon, ..., 6=Sat
// Python weekday() was 0=Mon, ..., 6=Sun
// To support both gracefully:
var DAY_NAME_TO_JS = {
  'SUN': 0, 'SUNDAY': 0,
  'MON': 1, 'MONDAY': 1,
  'TUE': 2, 'TUESDAY': 2,
  'WED': 3, 'WEDNESDAY': 3,
  'THU': 4, 'THURSDAY': 4,
  'FRI': 5, 'FRIDAY': 5,
  'SAT': 6, 'SATURDAY': 6
};

/**
 * Parse days of week string e.g. "MON,WED,FRI" or "1,3,5" into a Set of JS day indices (0=Sun, 1=Mon... 6=Sat)
 */
function parseDaysOfWeek(val) {
  var set = new Set();
  if (!val) return set;
  var parts = String(val).toUpperCase().replace(/\s+/g, '').split(',');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) continue;
    if (DAY_NAME_TO_JS.hasOwnProperty(p)) {
      set.add(DAY_NAME_TO_JS[p]);
    } else if (/^\d+$/.test(p)) {
      var num = parseInt(p, 10);
      // If Python convention 0-6 where 0=Mon, 6=Sun was passed or JS 0-6 where 0=Sun
      // Standardize: if numbers 0-6, accept directly
      if (num >= 0 && num <= 6) {
        set.add(num);
      }
    }
  }
  return set;
}

module.exports = {
  pad: pad,
  dtToStr: dtToStr,
  dtToIsoLocal: dtToIsoLocal,
  strToDt: strToDt,
  localNow: localNow,
  parseTimeValue: parseTimeValue,
  formatTimeValue: formatTimeValue,
  formatTime12: formatTime12,
  combineTimeWithToday: combineTimeWithToday,
  combineDateTime: combineDateTime,
  parseDaysOfWeek: parseDaysOfWeek,
  DAY_NAME_TO_JS: DAY_NAME_TO_JS
};

