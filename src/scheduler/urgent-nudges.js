/**
 * Repeat notifications for urgent timed reminders until marked addressed on the dashboard.
 * Compatible with Node.js 12+.
 */

'use strict';

var timeUtils = require('../utils/time-utils');
var scheduler = require('./scheduler');

var URGENT_NUDGE_DURATION_SECONDS = 14400; // 4 hours
var URGENT_NUDGE_INTERVAL_SECONDS = 600;   // 10 minutes

function isUrgentAddressable(reminder) {
  return (
    reminder.priority === 'urgent' &&
    (reminder.type === 'ONE_TIME' || reminder.type === 'DAILY') &&
    Boolean(reminder.trigger_time) &&
    !reminder.all_day &&
    reminder.status !== 'DISMISSED'
  );
}

function occurrenceKey(reminder, fireAt) {
  var d = new Date(fireAt);
  var y = d.getFullYear();
  var m = timeUtils.pad(d.getMonth() + 1);
  var day = timeUtils.pad(d.getDate());
  if (reminder.type === 'DAILY') {
    return y + '-' + m + '-' + day;
  }
  var h = timeUtils.pad(d.getHours());
  var min = timeUtils.pad(d.getMinutes());
  var s = timeUtils.pad(d.getSeconds());
  return y + '-' + m + '-' + day + 'T' + h + ':' + min + ':' + s;
}

function scheduledUrgentFireAt(reminder, now) {
  now = now || timeUtils.localNow();

  if (reminder.type === 'ONE_TIME') {
    if (!reminder.trigger_time) return null;
    var t = timeUtils.strToDt(reminder.trigger_time);
    if (!t || t > now) return null;
    return t;
  }

  if (reminder.type === 'DAILY') {
    if (!reminder.trigger_time) return null;
    var parsed = timeUtils.parseTimeValue(reminder.trigger_time);
    if (!parsed) return null;
    var fire = timeUtils.combineDateTime(now, parsed.hour, parsed.minute, parsed.second);
    if (fire > now) return null;

    if (scheduler.hasActiveWindow(reminder)) {
      if (!scheduler.isWithinActiveWindow(fire, reminder)) {
        return null;
      }
    }
    return fire;
  }

  return null;
}

function inUrgentNudgeWindow(reminder, now) {
  now = now || timeUtils.localNow();
  if (!isUrgentAddressable(reminder)) return false;
  if (reminder.snooze_until) {
    var s = timeUtils.strToDt(reminder.snooze_until);
    if (s && s > now) return false;
  }
  var fireAt = scheduledUrgentFireAt(reminder, now);
  if (!fireAt) return false;
  var elapsed = (now.getTime() - fireAt.getTime()) / 1000;
  return elapsed >= 0 && elapsed < URGENT_NUDGE_DURATION_SECONDS;
}

function currentUrgentOccurrence(reminder, now) {
  now = now || timeUtils.localNow();
  var fireAt = scheduledUrgentFireAt(reminder, now);
  if (!fireAt) return { fireAt: null, key: null };
  return { fireAt: fireAt, key: occurrenceKey(reminder, fireAt) };
}

async function dueUrgentNudges(activeReminders, urgentAckRepo, now) {
  now = now || timeUtils.localNow();
  var due = [];
  for (var i = 0; i < activeReminders.length; i++) {
    var reminder = activeReminders[i];
    if (!inUrgentNudgeWindow(reminder, now)) continue;

    var cur = currentUrgentOccurrence(reminder, now);
    if (!cur.key) continue;

    var isAck = await urgentAckRepo.isAddressed(reminder.id, cur.key);
    if (isAck) continue;

    var ack = await urgentAckRepo.getAck(reminder.id, cur.key);
    if (ack.last_nudge_at) {
      var elapsed = (now.getTime() - ack.last_nudge_at.getTime()) / 1000;
      if (elapsed < URGENT_NUDGE_INTERVAL_SECONDS) {
        continue;
      }
    }
    due.push({
      reminder: reminder,
      fire_at: cur.fireAt,
      occurrence_key: cur.key
    });
  }
  return due;
}

async function urgentFields(reminder, urgentAckRepo, now) {
  now = now || timeUtils.localNow();
  if (!isUrgentAddressable(reminder)) {
    return {
      urgent_addressable: false,
      in_urgent_window: false,
      urgent_occurrence_key: null,
      addressed: false,
      addressed_at: null,
      urgent_fire_at: null
    };
  }

  var cur = currentUrgentOccurrence(reminder, now);
  var inWindow = inUrgentNudgeWindow(reminder, now);
  var addressed = false;
  var addressedAt = null;

  if (cur.key && urgentAckRepo) {
    var ack = await urgentAckRepo.getAck(reminder.id, cur.key);
    addressed = ack.addressed;
    addressedAt = ack.addressed_at;
  }

  return {
    urgent_addressable: true,
    in_urgent_window: inWindow,
    urgent_occurrence_key: cur.key,
    addressed: addressed,
    addressed_at: addressedAt,
    urgent_fire_at: cur.fireAt ? timeUtils.dtToStr(cur.fireAt) : null
  };
}

module.exports = {
  URGENT_NUDGE_DURATION_SECONDS: URGENT_NUDGE_DURATION_SECONDS,
  URGENT_NUDGE_INTERVAL_SECONDS: URGENT_NUDGE_INTERVAL_SECONDS,
  isUrgentAddressable: isUrgentAddressable,
  occurrenceKey: occurrenceKey,
  scheduledUrgentFireAt: scheduledUrgentFireAt,
  inUrgentNudgeWindow: inUrgentNudgeWindow,
  currentUrgentOccurrence: currentUrgentOccurrence,
  dueUrgentNudges: dueUrgentNudges,
  urgentFields: urgentFields
};

