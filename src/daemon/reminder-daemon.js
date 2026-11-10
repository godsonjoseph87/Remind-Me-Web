/**
 * Background Reminder Daemon for RemindMe Web App.
 * Periodically polls for due reminders, recovers snoozed items,
 * and broadcasts notifications to connected web clients.
 * Compatible with Node.js 12+.
 */

'use strict';

var childProcess = require('child_process');
var scheduler = require('../scheduler/scheduler');
var urgentNudges = require('../scheduler/urgent-nudges');
var externalReminders = require('../scheduler/external-reminders');
var timeUtils = require('../utils/time-utils');

var POLL_INTERVAL_MS = 10000; // 10 seconds

var ReminderDaemon = function(options) {
  this.reminderRepo = options.reminderRepo;
  this.googleRepo = options.googleRepo;
  this.extRepo = options.extRepo;
  this.urgentAckRepo = options.urgentAckRepo;
  this.sseClients = options.sseClients || new Set();

  this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
  this.timer = null;
  this.running = false;
  this.firingLock = new Set();
};

ReminderDaemon.prototype.broadcast = function(eventType, payload) {
  var message = 'event: ' + eventType + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  this.sseClients.forEach(function(res) {
    try {
      res.write(message);
    } catch (e) {}
  });
};

ReminderDaemon.prototype.fireDesktopNotification = function(title, body, urgency) {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return;
    }

    var args = [
      title,
      body,
      '-u', urgency === 'critical' ? 'critical' : urgency === 'low' ? 'low' : 'normal',
      '-a', 'RemindMe'
    ];

    var proc = childProcess.spawn('notify-send', args, {
      stdio: 'ignore',
      detached: true
    });

    proc.on('error', function() {
      // Desktop notifications are optional; ignore missing platform binaries.
    });
    proc.unref();
  } catch (e) {}
};

ReminderDaemon.prototype.start = async function() {
  if (this.running) return;
  this.running = true;
  console.log('[Daemon] Starting reminder daemon (polling every ' + (this.pollIntervalMs / 1000) + 's)...');

  // Startup recovery
  await this.startupRecovery();

  var self = this;
  this.timer = setInterval(function() {
    self.tick().catch(function(err) {
      console.error('[Daemon] Error during scheduler tick:', err);
    });
  }, this.pollIntervalMs);
};

ReminderDaemon.prototype.stop = function() {
  this.running = false;
  if (this.timer) {
    clearInterval(this.timer);
    this.timer = null;
  }
  console.log('[Daemon] Reminder daemon stopped.');
};

ReminderDaemon.prototype.startupRecovery = async function() {
  try {
    var snoozedRecovered = await this.reminderRepo.recoverSnoozed();
    if (snoozedRecovered > 0) {
      console.log('[Daemon] Recovered ' + snoozedRecovered + ' expired snoozed reminder(s)');
    }

    var extRecovered = await this.extRepo.recoverSnoozes();
    if (extRecovered > 0) {
      console.log('[Daemon] Recovered ' + extRecovered + ' expired external snooze(s)');
    }

    var active = await this.reminderRepo.listActive();
    var missed = scheduler.missedReminders(active);
    if (missed && missed.length > 0) {
      console.log('[Daemon] Found ' + missed.length + ' missed reminder(s) from downtime');
      for (var i = 0; i < missed.length; i++) {
        await this.fireReminder(missed[i], true);
      }
    }

    var settings = await this.extRepo.getSettings();
    var missedExt = await externalReminders.dueExternalReminders(
      this.googleRepo,
      this.extRepo,
      settings,
      timeUtils.localNow(),
      true
    );
    if (missedExt && missedExt.length > 0) {
      console.log('[Daemon] Found ' + missedExt.length + ' missed external reminder(s)');
      for (var j = 0; j < missedExt.length; j++) {
        await this.fireExternalReminder(missedExt[j], true);
      }
    }
  } catch (err) {
    console.error('[Daemon] Error during startup recovery:', err);
  }
};

ReminderDaemon.prototype.tick = async function() {
  await this.reminderRepo.recoverSnoozed();
  await this.extRepo.recoverSnoozes();

  var now = timeUtils.localNow();
  var active = await this.reminderRepo.listActive();

  // 1. Check local active reminders
  for (var i = 0; i < active.length; i++) {
    var reminder = active[i];
    if (this.firingLock.has(reminder.id)) continue;

    if (scheduler.isDue(reminder, now)) {
      await this.fireReminder(reminder, false);
    }
  }

  // 2. Check external event reminders (Google & iCal)
  var settings = await this.extRepo.getSettings();
  var dueExt = await externalReminders.dueExternalReminders(
    this.googleRepo,
    this.extRepo,
    settings,
    now,
    false
  );
  for (var j = 0; j < dueExt.length; j++) {
    var item = dueExt[j];
    var lockKey = 'ext:' + item.event.id + ':' + item.offset_minutes;
    if (this.firingLock.has(lockKey)) continue;
    await this.fireExternalReminder(item, false);
  }

  // 3. Check Google unaddressed nudges
  var dueNudges = await externalReminders.dueUnaddressedNudges(
    this.googleRepo,
    this.extRepo,
    now,
    externalReminders.GOOGLE_ADDRESS_NUDGE_INTERVAL_SECONDS,
    settings
  );
  for (var k = 0; k < dueNudges.length; k++) {
    var nudgeEvent = dueNudges[k];
    var nLockKey = 'ext-nudge:' + nudgeEvent.id;
    if (this.firingLock.has(nLockKey)) continue;
    await this.fireUnaddressedNudge(nudgeEvent);
  }

  // 4. Check urgent reminder nudges
  var urgentDue = await urgentNudges.dueUrgentNudges(active, this.urgentAckRepo, now);
  for (var u = 0; u < urgentDue.length; u++) {
    var urgentItem = urgentDue[u];
    var uLockKey = 'urgent:' + urgentItem.reminder.id + ':' + urgentItem.occurrence_key;
    if (this.firingLock.has(uLockKey)) continue;
    await this.fireUrgentNudge(urgentItem);
  }
};

ReminderDaemon.prototype.fireReminder = async function(reminder, missedOnStartup) {
  var self = this;
  if (self.firingLock.has(reminder.id)) return;
  self.firingLock.add(reminder.id);

  try {
    var current = await self.reminderRepo.get(reminder.id);
    if (!current) return;
    if (!scheduler.isDue(current, timeUtils.localNow(), missedOnStartup)) return;

    var nowStr = timeUtils.dtToStr(timeUtils.localNow());
    var updates = {
      last_fired_at: nowStr,
      snooze_until: null
    };

    if (current.type === 'ONE_TIME') {
      updates.status = 'TRIGGERED';
    }

    await self.reminderRepo.update(current.id, updates);
    await self.reminderRepo.logAction(current.id, 'FIRED');

    var updated = await self.reminderRepo.get(current.id);

    console.log('[Daemon] Reminder fired:', updated.title, '(' + updated.id + ')');

    // Broadcast SSE to web clients
    self.broadcast('REMINDER_FIRED', {
      reminder: updated,
      type: 'REMINDER_FIRED',
      fired_at: nowStr
    });

    // Native desktop notify-send fallback
    self.fireDesktopNotification(
      '⏰ ' + updated.title,
      updated.description || 'Reminder alert',
      updated.priority === 'urgent' ? 'critical' : 'normal'
    );
  } catch (err) {
    console.error('[Daemon] Error firing reminder ' + reminder.id + ':', err);
  } finally {
    setTimeout(function() {
      self.firingLock.delete(reminder.id);
    }, 5000);
  }
};

ReminderDaemon.prototype.fireExternalReminder = async function(item, missedOnStartup) {
  var self = this;
  var lockKey = 'ext:' + item.event.id + ':' + item.offset_minutes;
  if (self.firingLock.has(lockKey)) return;
  self.firingLock.add(lockKey);

  try {
    var now = timeUtils.localNow();
    await self.extRepo.recordFire(item.event.id, item.offset_minutes, now);

    var settings = await self.extRepo.getSettings();
    var offsetLabel = item.offset_minutes === 0 ? 'Starting now' : 'In ' + item.offset_minutes + ' minutes';
    var sourceName = item.event.source === 'google_calendar' ? 'Calendar' : item.event.source === 'google_tasks' ? 'Tasks' : 'Calendar';

    console.log('[Daemon] Google/iCal reminder fired: ' + item.event.title + ' (' + offsetLabel + ')');

    self.broadcast('EXTERNAL_REMINDER_FIRED', {
      event: item.event,
      offset_minutes: item.offset_minutes,
      offset_label: offsetLabel,
      source_name: sourceName,
      tone: settings.tone || 'chime',
      fired_at: timeUtils.dtToStr(now)
    });

    self.fireDesktopNotification(
      '📅 ' + item.event.title,
      offsetLabel + (item.event.description ? ' — ' + item.event.description : ''),
      'normal'
    );
  } catch (err) {
    console.error('[Daemon] Error firing external reminder:', err);
  } finally {
    setTimeout(function() {
      self.firingLock.delete(lockKey);
    }, 5000);
  }
};

ReminderDaemon.prototype.fireUnaddressedNudge = async function(event) {
  var self = this;
  var lockKey = 'ext-nudge:' + event.id;
  if (self.firingLock.has(lockKey)) return;
  self.firingLock.add(lockKey);

  try {
    var now = timeUtils.localNow();
    await self.extRepo.recordNudge(event.id, now);
    var settings = await self.extRepo.getSettings();

    console.log('[Daemon] Unaddressed nudge fired: ' + event.title);

    self.broadcast('UNADDRESSED_NUDGE_FIRED', {
      event: event,
      tone: settings.tone || 'urgent',
      nudge_at: timeUtils.dtToStr(now)
    });
  } catch (err) {
    console.error('[Daemon] Error firing unaddressed nudge:', err);
  } finally {
    setTimeout(function() {
      self.firingLock.delete(lockKey);
    }, 5000);
  }
};

ReminderDaemon.prototype.fireUrgentNudge = async function(item) {
  var self = this;
  var lockKey = 'urgent:' + item.reminder.id + ':' + item.occurrence_key;
  if (self.firingLock.has(lockKey)) return;
  self.firingLock.add(lockKey);

  try {
    var now = timeUtils.localNow();
    await self.urgentAckRepo.recordNudge(item.reminder.id, item.occurrence_key, now);

    console.log('[Daemon] Urgent reminder nudge fired: ' + item.reminder.title);

    self.broadcast('URGENT_NUDGE_FIRED', {
      reminder: item.reminder,
      occurrence_key: item.occurrence_key,
      tone: item.reminder.tone || 'urgent',
      nudge_at: timeUtils.dtToStr(now)
    });

    self.fireDesktopNotification(
      '⚡ Urgent: ' + item.reminder.title,
      item.reminder.description || 'Needs attention!',
      'critical'
    );
  } catch (err) {
    console.error('[Daemon] Error firing urgent nudge:', err);
  } finally {
    setTimeout(function() {
      self.firingLock.delete(lockKey);
    }, 5000);
  }
};

module.exports = ReminderDaemon;

