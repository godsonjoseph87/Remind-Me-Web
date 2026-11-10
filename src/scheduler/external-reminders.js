/**
 * Due-time logic for Google / iCal external event reminders.
 * Compatible with Node.js 12+.
 */

'use strict';

var timeUtils = require('../utils/time-utils');

var GOOGLE_ADDRESS_SOURCES = new Set(['google_calendar', 'google_tasks']);
var GOOGLE_ADDRESS_NUDGE_INTERVAL_SECONDS = 600;
var GRACE_PERIOD_SECONDS = 300;

function effectiveStart(event) {
  if (!event || !event.start_time) return null;
  var dt = timeUtils.strToDt(event.start_time);
  if (!dt) return null;
  if (event.all_day) {
    return timeUtils.combineDateTime(dt, 9, 0, 0);
  }
  return dt;
}

function eventWindowStart(event) {
  return effectiveStart(event);
}

function eventWindowEnd(event) {
  if (!event || !event.start_time) return null;
  var start = eventWindowStart(event);
  if (!start) return null;

  if (event.end_time) {
    var end = timeUtils.strToDt(event.end_time);
    if (end) {
      if (event.all_day) {
        return new Date(end.getTime() - 1000);
      }
      return end;
    }
  }

  if (event.all_day) {
    return timeUtils.combineDateTime(start, 23, 59, 59);
  }

  // 1 hour after start or end of day
  var plusHour = new Date(start.getTime() + 60 * 60 * 1000);
  var endOfDay = timeUtils.combineDateTime(start, 23, 59, 59);
  return plusHour < endOfDay ? plusHour : endOfDay;
}

function isTodayEvent(event, now) {
  if (!event || !event.start_time) return false;
  now = now || timeUtils.localNow();
  var dt = timeUtils.strToDt(event.start_time);
  if (!dt) return false;
  return (
    dt.getFullYear() === now.getFullYear() &&
    dt.getMonth() === now.getMonth() &&
    dt.getDate() === now.getDate()
  );
}

function isWithinEventWindow(event, now) {
  now = now || timeUtils.localNow();
  if (!isTodayEvent(event, now)) return false;
  var start = eventWindowStart(event);
  var end = eventWindowEnd(event);
  if (!start || !end) return false;
  return now >= start && now <= end;
}

function eventHasStarted(event, now) {
  var start = effectiveStart(event);
  if (!start) return false;
  now = now || timeUtils.localNow();
  return start <= now;
}

async function dueExternalReminders(googleRepo, extRepo, settings, now, includeMissed) {
  now = now || timeUtils.localNow();
  if (!settings || !settings.enabled) return [];

  var upcoming = await googleRepo.listFromToday(100);
  var ids = upcoming.map(function(e) { return e.id; });
  var prefs = await extRepo.getPrefsBatch(ids);

  var due = [];
  var offsets = settings.offsets_minutes || [10, 5, 0];

  for (var i = 0; i < upcoming.length; i++) {
    var event = upcoming[i];
    var p = prefs[event.id] || { silent: false, snooze_until: null };
    if (p.silent) continue;
    if (p.snooze_until && p.snooze_until > now) continue;

    var start = effectiveStart(event);
    if (!start) continue;

    for (var o = 0; o < offsets.length; o++) {
      var offsetMinutes = offsets[o];
      var fireAt = new Date(start.getTime() - offsetMinutes * 60 * 1000);

      var hasFired = await extRepo.hasFired(event.id, offsetMinutes);
      if (hasFired) continue;

      if (fireAt > now) continue;

      var latenessSec = (now.getTime() - fireAt.getTime()) / 1000;
      if (includeMissed || latenessSec <= GRACE_PERIOD_SECONDS) {
        due.push({
          event: event,
          offset_minutes: offsetMinutes,
          fire_at: fireAt
        });
      }
    }
  }

  return due;
}

async function dueUnaddressedNudges(googleRepo, extRepo, now, intervalSeconds, settings) {
  now = now || timeUtils.localNow();
  intervalSeconds = intervalSeconds || GOOGLE_ADDRESS_NUDGE_INTERVAL_SECONDS;
  if (settings && !settings.enabled) return [];

  var todayEvents = await googleRepo.listFromToday(100);
  var ids = todayEvents.map(function(e) { return e.id; });
  var prefs = await extRepo.getPrefsBatch(ids);

  var due = [];
  for (var i = 0; i < todayEvents.length; i++) {
    var event = todayEvents[i];
    if (!GOOGLE_ADDRESS_SOURCES.has(event.source)) continue;
    if (!isWithinEventWindow(event, now)) continue;

    var p = prefs[event.id] || {};
    if (p.silent) continue;
    if (p.addressed) continue;
    if (p.snooze_until && p.snooze_until > now) continue;

    if (p.last_nudge_at) {
      var elapsed = (now.getTime() - p.last_nudge_at.getTime()) / 1000;
      if (elapsed < intervalSeconds) continue;
    }

    due.push(event);
  }

  return due;
}

module.exports = {
  GOOGLE_ADDRESS_SOURCES: GOOGLE_ADDRESS_SOURCES,
  GOOGLE_ADDRESS_NUDGE_INTERVAL_SECONDS: GOOGLE_ADDRESS_NUDGE_INTERVAL_SECONDS,
  effectiveStart: effectiveStart,
  eventWindowStart: eventWindowStart,
  eventWindowEnd: eventWindowEnd,
  isTodayEvent: isTodayEvent,
  isWithinEventWindow: isWithinEventWindow,
  eventHasStarted: eventHasStarted,
  dueExternalReminders: dueExternalReminders,
  dueUnaddressedNudges: dueUnaddressedNudges
};

