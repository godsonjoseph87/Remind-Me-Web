/**
 * Scheduling Engine for RemindMe.
 * Computes next fire times, current due times, and occurrences.
 * Compatible with Node.js 12+.
 */

'use strict';

var timeUtils = require('../utils/time-utils');

var DEDUP_WINDOW_SECONDS = 10;
var GRACE_PERIOD_SECONDS = 300;

function hasActiveWindow(reminder) {
  return Boolean(reminder.active_from && reminder.active_until);
}

function windowBoundsOn(day, reminder) {
  var fromParsed = timeUtils.parseTimeValue(reminder.active_from);
  var untilParsed = timeUtils.parseTimeValue(reminder.active_until);
  if (!fromParsed || !untilParsed) return null;

  var start = timeUtils.combineDateTime(day, fromParsed.hour, fromParsed.minute, fromParsed.second);
  var end = timeUtils.combineDateTime(day, untilParsed.hour, untilParsed.minute, untilParsed.second);
  return { start: start, end: end };
}

function isWithinActiveWindow(dt, reminder) {
  if (!hasActiveWindow(reminder)) return true;
  var bounds = windowBoundsOn(dt, reminder);
  if (!bounds) return true;
  return dt >= bounds.start && dt <= bounds.end;
}

function applyActiveWindow(candidate, reminder) {
  if (!hasActiveWindow(reminder) || !candidate) return candidate;
  if (isWithinActiveWindow(candidate, reminder)) return candidate;

  var bounds = windowBoundsOn(candidate, reminder);
  if (!bounds) return candidate;

  if (candidate < bounds.start) {
    return bounds.start;
  }

  // Move to start of active window next day
  var nextDay = new Date(candidate);
  nextDay.setDate(nextDay.getDate() + 1);
  var nextBounds = windowBoundsOn(nextDay, reminder);
  return nextBounds ? nextBounds.start : candidate;
}

function nextFireTimeRaw(reminder, now) {
  now = now || timeUtils.localNow();

  if (reminder.type === 'ONE_TIME') {
    if (!reminder.trigger_time) return null;
    if (reminder.last_fired_at) return null;
    return timeUtils.strToDt(reminder.trigger_time);
  }

  if (reminder.type === 'DAILY') {
    if (!reminder.trigger_time) return null;
    var parsed = timeUtils.parseTimeValue(reminder.trigger_time);
    if (!parsed) return null;
    var target = timeUtils.combineDateTime(now, parsed.hour, parsed.minute, parsed.second);
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  if (reminder.type === 'HOURLY') {
    var anchor = timeUtils.strToDt(reminder.last_fired_at) ||
                 timeUtils.strToDt(reminder.created_at) ||
                 new Date(now);
    if (reminder.trigger_time) {
      var tParsed = timeUtils.parseTimeValue(reminder.trigger_time);
      if (tParsed) {
        anchor.setMinutes(tParsed.minute, 0, 0);
      }
    }
    var candidate = new Date(anchor);
    while (candidate <= now) {
      candidate.setHours(candidate.getHours() + 1);
    }
    candidate.setSeconds(0, 0);
    return candidate;
  }

  if (reminder.type === 'INTERVAL_MINUTES') {
    var interval = reminder.interval_minutes;
    if (!interval || interval <= 0) return null;

    var intAnchor = timeUtils.strToDt(reminder.last_fired_at) ||
                    timeUtils.strToDt(reminder.created_at) ||
                    new Date(now);
    var intCandidate = new Date(intAnchor.getTime() + interval * 60 * 1000);
    while (intCandidate <= now) {
      intCandidate = new Date(intCandidate.getTime() + interval * 60 * 1000);
    }
    return intCandidate;
  }

  if (reminder.type === 'WEEKLY') {
    if (!reminder.trigger_time) return null;
    var allowedDays = timeUtils.parseDaysOfWeek(reminder.days_of_week);
    if (allowedDays.size === 0) return null;

    var wParsed = timeUtils.parseTimeValue(reminder.trigger_time);
    if (!wParsed) return null;

    for (var offset = 0; offset <= 8; offset++) {
      var day = new Date(now);
      day.setDate(day.getDate() + offset);
      if (!allowedDays.has(day.getDay())) continue;

      var wCandidate = timeUtils.combineDateTime(day, wParsed.hour, wParsed.minute, wParsed.second);
      if (wCandidate > now) {
        return wCandidate;
      }
    }
    return null;
  }

  return null;
}

function nextFireTime(reminder, now) {
  now = now || timeUtils.localNow();

  if (reminder.snooze_until) {
    var snoozeDt = timeUtils.strToDt(reminder.snooze_until);
    if (snoozeDt && snoozeDt > now) {
      return snoozeDt;
    }
  }

  var nf = nextFireTimeRaw(reminder, now);
  if (!nf) return null;
  return applyActiveWindow(nf, reminder);
}

function currentDueTimeRaw(reminder, now) {
  now = now || timeUtils.localNow();

  if (reminder.type === 'ONE_TIME') {
    if (!reminder.trigger_time || reminder.last_fired_at) return null;
    var tr = timeUtils.strToDt(reminder.trigger_time);
    return (tr && tr <= now) ? tr : null;
  }

  if (reminder.type === 'DAILY') {
    if (!reminder.trigger_time) return null;
    var dParsed = timeUtils.parseTimeValue(reminder.trigger_time);
    if (!dParsed) return null;
    var dTarget = timeUtils.combineDateTime(now, dParsed.hour, dParsed.minute, dParsed.second);
    return dTarget <= now ? dTarget : null;
  }

  if (reminder.type === 'HOURLY') {
    var hAnchor = timeUtils.strToDt(reminder.last_fired_at) ||
                  timeUtils.strToDt(reminder.created_at) ||
                  new Date(now);
    if (reminder.trigger_time) {
      var hp = timeUtils.parseTimeValue(reminder.trigger_time);
      if (hp) hAnchor.setMinutes(hp.minute, 0, 0);
    }
    var hCand = new Date(hAnchor);
    var hLastDue = null;
    while (hCand <= now) {
      hLastDue = new Date(hCand);
      hCand.setHours(hCand.getHours() + 1);
    }
    return hLastDue;
  }

  if (reminder.type === 'INTERVAL_MINUTES') {
    var interval = reminder.interval_minutes;
    if (!interval || interval <= 0) return null;
    var iAnchor = timeUtils.strToDt(reminder.last_fired_at) ||
                  timeUtils.strToDt(reminder.created_at) ||
                  new Date(now);
    var iCand = new Date(iAnchor.getTime() + interval * 60 * 1000);
    var iLastDue = null;
    while (iCand <= now) {
      iLastDue = new Date(iCand);
      iCand = new Date(iCand.getTime() + interval * 60 * 1000);
    }
    return iLastDue;
  }

  if (reminder.type === 'WEEKLY') {
    if (!reminder.trigger_time) return null;
    var allowed = timeUtils.parseDaysOfWeek(reminder.days_of_week);
    if (allowed.size === 0) return null;
    var wp = timeUtils.parseTimeValue(reminder.trigger_time);
    if (!wp) return null;

    for (var back = 0; back <= 7; back++) {
      var d = new Date(now);
      d.setDate(d.getDate() - back);
      if (!allowed.has(d.getDay())) continue;
      var wc = timeUtils.combineDateTime(d, wp.hour, wp.minute, wp.second);
      if (wc <= now) {
        return wc;
      }
    }
    return null;
  }

  return null;
}

function currentDueTime(reminder, now) {
  now = now || timeUtils.localNow();
  if (reminder.snooze_until) {
    var sDt = timeUtils.strToDt(reminder.snooze_until);
    if (sDt && sDt > now) return null;
  }
  return currentDueTimeRaw(reminder, now);
}

function isDue(reminder, now, includeMissed) {
  now = now || timeUtils.localNow();

  if (reminder.status === 'DISMISSED' || reminder.status === 'TRIGGERED') {
    return false;
  }

  if (reminder.snooze_until) {
    var sDt = timeUtils.strToDt(reminder.snooze_until);
    if (sDt && sDt > now) return false;
  }

  if (hasActiveWindow(reminder) && !isWithinActiveWindow(now, reminder)) {
    return false;
  }

  var dueAt = currentDueTime(reminder, now);
  if (!dueAt) return false;

  var lastFired = timeUtils.strToDt(reminder.last_fired_at);
  if (lastFired && lastFired >= dueAt) {
    return false;
  }

  // Prevent duplicate firing within dedup window
  if (lastFired) {
    var elapsedSec = (now.getTime() - lastFired.getTime()) / 1000;
    if (elapsedSec < DEDUP_WINDOW_SECONDS) {
      return false;
    }
  }

  if (includeMissed) return true;

  var lateness = (now.getTime() - dueAt.getTime()) / 1000;
  return lateness <= GRACE_PERIOD_SECONDS || dueAt <= now;
}

function missedReminders(reminders, now) {
  now = now || timeUtils.localNow();
  var missed = [];
  for (var i = 0; i < reminders.length; i++) {
    var r = reminders[i];
    if (r.type === 'ONE_TIME' && r.last_fired_at) continue;
    var dueAt = currentDueTime(r, now);
    if (!dueAt) continue;

    var threshold = new Date(now.getTime() - GRACE_PERIOD_SECONDS * 1000);
    if (dueAt < threshold) {
      var lf = timeUtils.strToDt(r.last_fired_at);
      if (!lf || lf < dueAt) {
        missed.push(r);
      }
    }
  }
  return missed;
}

function occurrencesInRange(reminder, start, end, maxOccurrences) {
  if (maxOccurrences === undefined) maxOccurrences = 200;
  if (reminder.status === 'DISMISSED' || reminder.status === 'TRIGGERED') {
    return [];
  }

  if (reminder.type === 'ONE_TIME') {
    if (reminder.last_fired_at || !reminder.trigger_time) return [];
    var t = timeUtils.strToDt(reminder.trigger_time);
    if (t && t >= start && t < end) {
      return [t];
    }
    return [];
  }

  var results = [];
  var sim = Object.assign({}, reminder);
  var probe = new Date(start.getTime() - 1000);

  for (var i = 0; i < maxOccurrences; i++) {
    var nf = nextFireTime(sim, probe);
    if (!nf || nf >= end) break;
    if (nf >= start) {
      results.push(nf);
    }
    probe = nf;
    sim.last_fired_at = timeUtils.dtToStr(nf);
    sim.snooze_until = null;
    sim.status = 'PENDING';
  }

  return results;
}

module.exports = {
  DEDUP_WINDOW_SECONDS: DEDUP_WINDOW_SECONDS,
  GRACE_PERIOD_SECONDS: GRACE_PERIOD_SECONDS,
  hasActiveWindow: hasActiveWindow,
  isWithinActiveWindow: isWithinActiveWindow,
  applyActiveWindow: applyActiveWindow,
  nextFireTimeRaw: nextFireTimeRaw,
  nextFireTime: nextFireTime,
  currentDueTimeRaw: currentDueTimeRaw,
  currentDueTime: currentDueTime,
  isDue: isDue,
  missedReminders: missedReminders,
  occurrencesInRange: occurrencesInRange
};

