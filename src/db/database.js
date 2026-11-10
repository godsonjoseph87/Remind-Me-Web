/**
 * SQLite Database and Repositories for RemindMe Web App.
 * Compatible with Node.js 12+.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var sqlite3 = require('sqlite3').verbose();
var timeUtils = require('../utils/time-utils');

function uuidv4() {
  var b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var s = b.toString('hex');
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-');
}

var Database = function(dbPath) {
  var self = this;
  if (!dbPath) {
    dbPath = path.resolve(__dirname, '../../data/reminders.db');
  }
  self.dbPath = dbPath;

  var dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  self.db = new sqlite3.Database(dbPath);
};

Database.prototype.run = function(sql, params) {
  var self = this;
  return new Promise(function(resolve, reject) {
    self.db.run(sql, params || [], function(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

Database.prototype.get = function(sql, params) {
  var self = this;
  return new Promise(function(resolve, reject) {
    self.db.get(sql, params || [], function(err, row) {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
};

Database.prototype.all = function(sql, params) {
  var self = this;
  return new Promise(function(resolve, reject) {
    self.db.all(sql, params || [], function(err, rows) {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
};

Database.prototype.exec = function(sql) {
  var self = this;
  return new Promise(function(resolve, reject) {
    self.db.exec(sql, function(err) {
      if (err) return reject(err);
      resolve();
    });
  });
};

Database.prototype.init = async function() {
  var schemaFile = path.resolve(__dirname, 'schema.sql');
  var schemaSql = fs.readFileSync(schemaFile, 'utf8');
  await this.exec(schemaSql);
};

Database.prototype.close = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    self.db.close(function(err) {
      if (err) return reject(err);
      resolve();
    });
  });
};

// ==========================================
// Reminders Repository
// ==========================================

var ReminderRepository = function(database) {
  this.db = database;
};

ReminderRepository.prototype.get = async function(id) {
  return await this.db.get('SELECT * FROM reminders WHERE id = ?', [id]);
};

ReminderRepository.prototype.resolveId = async function(partialOrFull) {
  if (!partialOrFull) return null;
  var exact = await this.get(partialOrFull);
  if (exact) return exact.id;

  var rows = await this.db.all(
    'SELECT id FROM reminders WHERE id LIKE ? LIMIT 2',
    [partialOrFull + '%']
  );
  if (rows && rows.length === 1) {
    return rows[0].id;
  }
  return null;
};

ReminderRepository.prototype.listAll = async function(opts) {
  opts = opts || {};
  var sql = 'SELECT * FROM reminders';
  var conditions = [];
  var params = [];

  if (opts.userId) {
    conditions.push('(user_id = ? OR user_id IS NULL)');
    params.push(opts.userId);
  }

  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status.toUpperCase());
  } else if (!opts.includeDismissed) {
    conditions.push("status IN ('PENDING', 'SNOOZED')");
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY sort_order ASC, created_at DESC';
  return await this.db.all(sql, params);
};

ReminderRepository.prototype.listActive = async function(opts) {
  opts = opts || {};
  return await this.listAll({
    includeDismissed: false,
    userId: opts.userId
  });
};

ReminderRepository.prototype.create = async function(data) {
  var id = data.id || uuidv4();
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());

  var triggerTime = null;
  if (data.trigger_time) {
    triggerTime = timeUtils.dtToStr(data.trigger_time);
  }

  var activeFrom = data.active_from ? timeUtils.formatTimeValue(data.active_from) : null;
  var activeUntil = data.active_until ? timeUtils.formatTimeValue(data.active_until) : null;

  var sql = `
    INSERT INTO reminders (
      id, title, description, type, trigger_time, interval_minutes,
      days_of_week, status, snooze_until, last_fired_at, tone,
      priority, color, all_day, active_from, active_until,
      sort_order, user_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, NULL, NULL, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `;

  var params = [
    id,
    data.title || '',
    data.description || '',
    data.type || 'ONE_TIME',
    triggerTime,
    data.interval_minutes != null ? parseInt(data.interval_minutes, 10) : null,
    data.days_of_week || null,
    'PENDING',
    data.tone || 'chime',
    data.priority || 'normal',
    data.color || '#6366f1',
    data.all_day ? 1 : 0,
    activeFrom,
    activeUntil,
    data.sort_order != null ? parseInt(data.sort_order, 10) : 0,
    data.user_id || null,
    nowStr,
    nowStr
  ];

  await this.db.run(sql, params);
  return await this.get(id);
};

ReminderRepository.prototype.update = async function(id, data) {
  var existing = await this.get(id);
  if (!existing) return null;

  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  var fields = [];
  var params = [];

  if (data.title !== undefined) {
    fields.push('title = ?');
    params.push(data.title);
  }
  if (data.description !== undefined) {
    fields.push('description = ?');
    params.push(data.description);
  }
  if (data.type !== undefined) {
    fields.push('type = ?');
    params.push(data.type);
  }
  if (data.trigger_time !== undefined) {
    fields.push('trigger_time = ?');
    params.push(data.trigger_time ? timeUtils.dtToStr(data.trigger_time) : null);
  }
  if (data.interval_minutes !== undefined) {
    fields.push('interval_minutes = ?');
    params.push(data.interval_minutes != null ? parseInt(data.interval_minutes, 10) : null);
  }
  if (data.days_of_week !== undefined) {
    fields.push('days_of_week = ?');
    params.push(data.days_of_week);
  }
  if (data.status !== undefined) {
    fields.push('status = ?');
    params.push(data.status);
  }
  if (data.snooze_until !== undefined) {
    fields.push('snooze_until = ?');
    params.push(data.snooze_until ? timeUtils.dtToStr(data.snooze_until) : null);
  }
  if (data.last_fired_at !== undefined) {
    fields.push('last_fired_at = ?');
    params.push(data.last_fired_at ? timeUtils.dtToStr(data.last_fired_at) : null);
  }
  if (data.tone !== undefined) {
    fields.push('tone = ?');
    params.push(data.tone);
  }
  if (data.priority !== undefined) {
    fields.push('priority = ?');
    params.push(data.priority);
  }
  if (data.color !== undefined) {
    fields.push('color = ?');
    params.push(data.color);
  }
  if (data.all_day !== undefined) {
    fields.push('all_day = ?');
    params.push(data.all_day ? 1 : 0);
  }
  if (data.clear_active_window) {
    fields.push('active_from = NULL');
    fields.push('active_until = NULL');
  } else {
    if (data.active_from !== undefined) {
      fields.push('active_from = ?');
      params.push(data.active_from ? timeUtils.formatTimeValue(data.active_from) : null);
    }
    if (data.active_until !== undefined) {
      fields.push('active_until = ?');
      params.push(data.active_until ? timeUtils.formatTimeValue(data.active_until) : null);
    }
  }
  if (data.sort_order !== undefined) {
    fields.push('sort_order = ?');
    params.push(data.sort_order != null ? parseInt(data.sort_order, 10) : 0);
  }

  fields.push('updated_at = ?');
  params.push(nowStr);

  params.push(id);
  var sql = 'UPDATE reminders SET ' + fields.join(', ') + ' WHERE id = ?';
  await this.db.run(sql, params);
  return await this.get(id);
};

ReminderRepository.prototype.delete = async function(id) {
  var res = await this.db.run('DELETE FROM reminders WHERE id = ?', [id]);
  return res.changes > 0;
};

ReminderRepository.prototype.snooze = async function(id, minutes) {
  var m = parseInt(minutes || 5, 10);
  var snoozeTime = new Date(Date.now() + m * 60 * 1000);
  var snoozeStr = timeUtils.dtToStr(snoozeTime);
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());

  await this.db.run(
    "UPDATE reminders SET status = 'SNOOZED', snooze_until = ?, updated_at = ? WHERE id = ?",
    [snoozeStr, nowStr, id]
  );
  await this.logAction(id, 'SNOOZED');
  return await this.get(id);
};

ReminderRepository.prototype.dismiss = async function(id) {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  await this.db.run(
    "UPDATE reminders SET status = 'DISMISSED', snooze_until = NULL, updated_at = ? WHERE id = ?",
    [nowStr, id]
  );
  await this.logAction(id, 'DISMISSED');
  return await this.get(id);
};

ReminderRepository.prototype.reactivate = async function(id) {
  var existing = await this.get(id);
  if (!existing) return null;

  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  var updates = {
    status: 'PENDING',
    snooze_until: null,
    updated_at: nowStr
  };

  // If one-time reminder is past, update trigger_time to today/now
  if (existing.type === 'ONE_TIME' && existing.trigger_time) {
    var dt = timeUtils.strToDt(existing.trigger_time);
    if (dt && dt <= timeUtils.localNow()) {
      var nextHour = new Date(Date.now() + 60 * 60 * 1000);
      nextHour.setMinutes(0, 0, 0);
      updates.trigger_time = timeUtils.dtToStr(nextHour);
      updates.last_fired_at = null;
    }
  }

  var sql = "UPDATE reminders SET status = 'PENDING', snooze_until = NULL, updated_at = ?";
  var params = [nowStr];
  if (updates.trigger_time) {
    sql += ', trigger_time = ?, last_fired_at = NULL';
    params.push(updates.trigger_time);
  }
  sql += ' WHERE id = ?';
  params.push(id);

  await this.db.run(sql, params);
  return await this.get(id);
};

ReminderRepository.prototype.reorder = async function(orderedIds) {
  if (!orderedIds || !orderedIds.length) return false;
  for (var i = 0; i < orderedIds.length; i++) {
    await this.db.run('UPDATE reminders SET sort_order = ? WHERE id = ?', [i, orderedIds[i]]);
  }
  return true;
};

ReminderRepository.prototype.recoverSnoozed = async function() {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  var res = await this.db.run(
    "UPDATE reminders SET status = 'PENDING', snooze_until = NULL WHERE status = 'SNOOZED' AND snooze_until <= ?",
    [nowStr]
  );
  return res.changes;
};

ReminderRepository.prototype.logAction = async function(reminderId, action) {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  await this.db.run(
    'INSERT INTO reminder_logs (reminder_id, triggered_at, action_taken) VALUES (?, ?, ?)',
    [reminderId, nowStr, action]
  );
};

ReminderRepository.prototype.logsForReminder = async function(reminderId, limit) {
  limit = limit || 10;
  return await this.db.all(
    'SELECT * FROM reminder_logs WHERE reminder_id = ? ORDER BY triggered_at DESC LIMIT ?',
    [reminderId, limit]
  );
};

// ==========================================
// External Reminders Settings & Prefs
// ==========================================

var ExternalReminderRepository = function(database) {
  this.db = database;
};

ExternalReminderRepository.notificationId = function(eventId, offsetMinutes) {
  return 'ext:' + eventId + ':' + offsetMinutes;
};

ExternalReminderRepository.nudgeNotificationId = function(eventId) {
  return 'ext-nudge:' + eventId;
};

ExternalReminderRepository.prototype.getSettings = async function() {
  var row = await this.db.get('SELECT * FROM external_reminder_settings WHERE id = 1');
  if (!row) {
    return {
      offsets_minutes: [10, 5, 0],
      tone: 'chime',
      enabled: true
    };
  }
  var offsets = [10, 5, 0];
  try {
    offsets = JSON.parse(row.offsets_minutes);
  } catch (e) {}
  return {
    offsets_minutes: offsets,
    tone: row.tone || 'chime',
    enabled: Boolean(row.enabled)
  };
};

ExternalReminderRepository.prototype.updateSettings = async function(data) {
  var curr = await this.getSettings();
  var offsets = data.offsets_minutes !== undefined ? data.offsets_minutes : curr.offsets_minutes;
  var tone = data.tone !== undefined ? data.tone : curr.tone;
  var enabled = data.enabled !== undefined ? (data.enabled ? 1 : 0) : (curr.enabled ? 1 : 0);

  await this.db.run(
    'UPDATE external_reminder_settings SET offsets_minutes = ?, tone = ?, enabled = ? WHERE id = 1',
    [JSON.stringify(offsets), tone, enabled]
  );
  return await this.getSettings();
};

ExternalReminderRepository.prototype.getPrefs = async function(eventId) {
  var row = await this.db.get('SELECT * FROM external_event_prefs WHERE event_id = ?', [eventId]);
  if (!row) {
    return { silent: false, snooze_until: null, addressed: false, addressed_at: null, last_nudge_at: null };
  }
  return {
    silent: Boolean(row.silent),
    snooze_until: row.snooze_until ? timeUtils.strToDt(row.snooze_until) : null,
    addressed: Boolean(row.addressed_at),
    addressed_at: row.addressed_at,
    last_nudge_at: row.last_nudge_at ? timeUtils.strToDt(row.last_nudge_at) : null
  };
};

ExternalReminderRepository.prototype.getPrefsBatch = async function(eventIds) {
  if (!eventIds || !eventIds.length) return {};
  var placeholders = eventIds.map(function() { return '?'; }).join(',');
  var rows = await this.db.all(
    'SELECT * FROM external_event_prefs WHERE event_id IN (' + placeholders + ')',
    eventIds
  );
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    map[r.event_id] = {
      silent: Boolean(r.silent),
      snooze_until: r.snooze_until ? timeUtils.strToDt(r.snooze_until) : null,
      addressed: Boolean(r.addressed_at),
      addressed_at: r.addressed_at,
      last_nudge_at: r.last_nudge_at ? timeUtils.strToDt(r.last_nudge_at) : null
    };
  }
  return map;
};

ExternalReminderRepository.prototype.setSilent = async function(eventId, silent) {
  await this.db.run(
    'INSERT INTO external_event_prefs (event_id, silent) VALUES (?, ?) ' +
    'ON CONFLICT(event_id) DO UPDATE SET silent = excluded.silent',
    [eventId, silent ? 1 : 0]
  );
};

ExternalReminderRepository.prototype.snooze = async function(eventId, offsetMinutes, snoozeMinutes) {
  var until = new Date(Date.now() + (snoozeMinutes || 5) * 60 * 1000);
  var untilStr = timeUtils.dtToStr(until);
  await this.db.run(
    'INSERT INTO external_event_prefs (event_id, snooze_until) VALUES (?, ?) ' +
    'ON CONFLICT(event_id) DO UPDATE SET snooze_until = excluded.snooze_until',
    [eventId, untilStr]
  );
  return until;
};

ExternalReminderRepository.prototype.markAddressed = async function(eventId) {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  await this.db.run(
    'INSERT INTO external_event_prefs (event_id, addressed_at) VALUES (?, ?) ' +
    'ON CONFLICT(event_id) DO UPDATE SET addressed_at = excluded.addressed_at',
    [eventId, nowStr]
  );
};

ExternalReminderRepository.prototype.recoverSnoozes = async function() {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  var res = await this.db.run(
    'UPDATE external_event_prefs SET snooze_until = NULL WHERE snooze_until IS NOT NULL AND snooze_until <= ?',
    [nowStr]
  );
  return res.changes;
};

ExternalReminderRepository.prototype.hasFired = async function(eventId, offsetMinutes) {
  var row = await this.db.get(
    'SELECT 1 FROM external_event_fires WHERE event_id = ? AND offset_minutes = ?',
    [eventId, offsetMinutes]
  );
  return Boolean(row);
};

ExternalReminderRepository.prototype.recordFire = async function(eventId, offsetMinutes, now) {
  var nowStr = timeUtils.dtToStr(now || timeUtils.localNow());
  await this.db.run(
    'INSERT OR REPLACE INTO external_event_fires (event_id, offset_minutes, fired_at, dismissed) VALUES (?, ?, ?, 0)',
    [eventId, offsetMinutes, nowStr]
  );
};

ExternalReminderRepository.prototype.recordNudge = async function(eventId, now) {
  var nowStr = timeUtils.dtToStr(now || timeUtils.localNow());
  await this.db.run(
    'INSERT INTO external_event_prefs (event_id, last_nudge_at) VALUES (?, ?) ' +
    'ON CONFLICT(event_id) DO UPDATE SET last_nudge_at = excluded.last_nudge_at',
    [eventId, nowStr]
  );
};

// ==========================================
// Urgent Acknowledgement Repository
// ==========================================

var UrgentAckRepository = function(database) {
  this.db = database;
};

UrgentAckRepository.nudgeNotificationId = function(reminderId, occurrenceKey) {
  return 'urgent-nudge:' + reminderId + ':' + occurrenceKey;
};

UrgentAckRepository.prototype.isAddressed = async function(reminderId, occurrenceKey) {
  var row = await this.db.get(
    'SELECT addressed_at FROM reminder_urgent_acks WHERE reminder_id = ? AND occurrence_key = ?',
    [reminderId, occurrenceKey]
  );
  return Boolean(row && row.addressed_at);
};

UrgentAckRepository.prototype.getAck = async function(reminderId, occurrenceKey) {
  var row = await this.db.get(
    'SELECT * FROM reminder_urgent_acks WHERE reminder_id = ? AND occurrence_key = ?',
    [reminderId, occurrenceKey]
  );
  if (!row) {
    return { addressed: false, addressed_at: null, last_nudge_at: null };
  }
  return {
    addressed: Boolean(row.addressed_at),
    addressed_at: row.addressed_at,
    last_nudge_at: row.last_nudge_at ? timeUtils.strToDt(row.last_nudge_at) : null
  };
};

UrgentAckRepository.prototype.markAddressed = async function(reminderId, occurrenceKey) {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  await this.db.run(
    'INSERT INTO reminder_urgent_acks (reminder_id, occurrence_key, addressed_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(reminder_id, occurrence_key) DO UPDATE SET addressed_at = excluded.addressed_at',
    [reminderId, occurrenceKey, nowStr]
  );
};

UrgentAckRepository.prototype.recordNudge = async function(reminderId, occurrenceKey, now) {
  var nowStr = timeUtils.dtToStr(now || timeUtils.localNow());
  await this.db.run(
    'INSERT INTO reminder_urgent_acks (reminder_id, occurrence_key, last_nudge_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(reminder_id, occurrence_key) DO UPDATE SET last_nudge_at = excluded.last_nudge_at',
    [reminderId, occurrenceKey, nowStr]
  );
};

// ==========================================
// Google & External Events Repository
// ==========================================

var GoogleRepository = function(database) {
  this.db = database;
};

GoogleRepository.prototype.getSyncState = async function() {
  var row = await this.db.get('SELECT * FROM google_sync_state WHERE id = 1');
  if (!row) {
    return { last_sync_at: null, last_error: null, account_email: null, account_name: null, account_picture: null };
  }
  return {
    last_sync_at: row.last_sync_at ? timeUtils.strToDt(row.last_sync_at) : null,
    last_error: row.last_error,
    account_email: row.account_email,
    account_name: row.account_name,
    account_picture: row.account_picture
  };
};

GoogleRepository.prototype.updateSyncState = async function(data) {
  var fields = [];
  var params = [];
  if (data.last_sync_at !== undefined) {
    fields.push('last_sync_at = ?');
    params.push(data.last_sync_at ? timeUtils.dtToStr(data.last_sync_at) : null);
  }
  if (data.last_error !== undefined) {
    fields.push('last_error = ?');
    params.push(data.last_error);
  }
  if (data.clear_error) {
    fields.push('last_error = NULL');
  }
  if (data.account_email !== undefined) {
    fields.push('account_email = ?');
    params.push(data.account_email);
  }
  if (data.account_name !== undefined) {
    fields.push('account_name = ?');
    params.push(data.account_name);
  }
  if (data.account_picture !== undefined) {
    fields.push('account_picture = ?');
    params.push(data.account_picture);
  }

  if (fields.length > 0) {
    var sql = 'UPDATE google_sync_state SET ' + fields.join(', ') + ' WHERE id = 1';
    await this.db.run(sql, params);
  }
  return await this.getSyncState();
};

GoogleRepository.prototype.upsertEvent = async function(event) {
  var sql = `
    INSERT INTO external_events (
      id, source, title, description, start_time, end_time,
      all_day, status, html_link, calendar_id, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      all_day = excluded.all_day,
      status = excluded.status,
      html_link = excluded.html_link,
      calendar_id = excluded.calendar_id,
      synced_at = excluded.synced_at
  `;

  var startStr = event.start_time ? timeUtils.dtToStr(event.start_time) : null;
  var endStr = event.end_time ? timeUtils.dtToStr(event.end_time) : null;
  var syncedStr = timeUtils.dtToStr(event.synced_at || timeUtils.localNow());

  await this.db.run(sql, [
    event.id,
    event.source,
    event.title || '',
    event.description || '',
    startStr,
    endStr,
    event.all_day ? 1 : 0,
    event.status || null,
    event.html_link || null,
    event.calendar_id || null,
    syncedStr
  ]);
};

GoogleRepository.prototype.deleteEventsNotIn = async function(source, keepIds) {
  if (!keepIds || keepIds.length === 0) {
    await this.db.run('DELETE FROM external_events WHERE source = ?', [source]);
    return;
  }
  var placeholders = keepIds.map(function() { return '?'; }).join(',');
  var sql = 'DELETE FROM external_events WHERE source = ? AND id NOT IN (' + placeholders + ')';
  var params = [source].concat(keepIds);
  await this.db.run(sql, params);
};

GoogleRepository.prototype.listUpcoming = async function(limit, source) {
  limit = limit || 50;
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  var sql = 'SELECT * FROM external_events WHERE start_time >= ?';
  var params = [nowStr];
  if (source) {
    sql += ' AND source = ?';
    params.push(source);
  }
  sql += ' ORDER BY start_time ASC LIMIT ?';
  params.push(limit);
  return await this.db.all(sql, params);
};

GoogleRepository.prototype.listTasksWithoutDue = async function(limit) {
  limit = limit || 50;
  var sql = "SELECT * FROM external_events WHERE source = 'google_tasks' AND start_time IS NULL ORDER BY synced_at DESC LIMIT ?";
  return await this.db.all(sql, [limit]);
};

GoogleRepository.prototype.listFromToday = async function(limit) {
  limit = limit || 100;
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var todayStr = timeUtils.dtToStr(today);
  return await this.db.all(
    'SELECT * FROM external_events WHERE start_time >= ? ORDER BY start_time ASC LIMIT ?',
    [todayStr, limit]
  );
};

GoogleRepository.prototype.listInRange = async function(start, end) {
  var startStr = timeUtils.dtToStr(start);
  var endStr = timeUtils.dtToStr(end);
  return await this.db.all(
    'SELECT * FROM external_events WHERE start_time >= ? AND start_time < ? ORDER BY start_time ASC',
    [startStr, endStr]
  );
};

GoogleRepository.prototype.getEvent = async function(id) {
  return await this.db.get('SELECT * FROM external_events WHERE id = ?', [id]);
};

GoogleRepository.prototype.updateEventStatus = async function(id, status) {
  return await this.db.run('UPDATE external_events SET status = ? WHERE id = ?', [status, id]);
};

GoogleRepository.prototype.deleteEvent = async function(id) {
  return await this.db.run('DELETE FROM external_events WHERE id = ?', [id]);
};

GoogleRepository.prototype.countAll = async function() {
  var row = await this.db.get('SELECT COUNT(*) as count FROM external_events');
  return row ? row.count : 0;
};

GoogleRepository.prototype.clearAll = async function() {
  await this.db.run('DELETE FROM external_events');
  await this.db.run('DELETE FROM external_event_prefs');
  await this.db.run('DELETE FROM external_event_fires');
  await this.db.run('UPDATE google_sync_state SET last_sync_at = NULL, last_error = NULL, account_email = NULL, account_name = NULL, account_picture = NULL WHERE id = 1');
};

// Calendar Feeds (iCal)
GoogleRepository.prototype.listFeeds = async function() {
  return await this.db.all('SELECT * FROM calendar_feeds ORDER BY id ASC');
};

GoogleRepository.prototype.addFeed = async function(url, label) {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  var res = await this.db.run(
    'INSERT INTO calendar_feeds (url, label, created_at) VALUES (?, ?, ?)',
    [url, label || 'Google Calendar', nowStr]
  );
  return await this.db.get('SELECT * FROM calendar_feeds WHERE id = ?', [res.lastID]);
};

GoogleRepository.prototype.removeFeed = async function(id) {
  await this.db.run('DELETE FROM external_events WHERE source = "ical" AND calendar_id = ?', [String(id)]);
  return await this.db.run('DELETE FROM calendar_feeds WHERE id = ?', [id]);
};

GoogleRepository.prototype.updateFeed = async function(id, data) {
  var fields = [];
  var params = [];
  if (data.last_sync_at !== undefined) {
    fields.push('last_sync_at = ?');
    params.push(data.last_sync_at ? timeUtils.dtToStr(data.last_sync_at) : null);
  }
  if (data.last_error !== undefined) {
    fields.push('last_error = ?');
    params.push(data.last_error);
  }
  if (data.etag !== undefined) {
    fields.push('etag = ?');
    params.push(data.etag);
  }
  if (fields.length > 0) {
    params.push(id);
    await this.db.run('UPDATE calendar_feeds SET ' + fields.join(', ') + ' WHERE id = ?', params);
  }
  return await this.db.get('SELECT * FROM calendar_feeds WHERE id = ?', [id]);
};

// ==========================================
// App Config & User Sessions
// ==========================================

var AppConfigRepository = function(database) {
  this.db = database;
};

AppConfigRepository.prototype.get = async function(key) {
  var row = await this.db.get('SELECT value FROM app_config WHERE key = ?', [key]);
  return row ? row.value : null;
};

AppConfigRepository.prototype.set = async function(key, value) {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  await this.db.run(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, String(value), nowStr]
  );
};

AppConfigRepository.prototype.getAll = async function() {
  var rows = await this.db.all('SELECT * FROM app_config');
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    map[rows[i].key] = rows[i].value;
  }
  return map;
};

var SessionRepository = function(database) {
  this.db = database;
};

SessionRepository.prototype.createSession = async function(userData) {
  var sessionId = uuidv4();
  var now = timeUtils.localNow();
  var nowStr = timeUtils.dtToStr(now);

  var sql = `
    INSERT INTO user_sessions (
      session_id, user_id, email, name, picture,
      access_token, refresh_token, token_expiry, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await this.db.run(sql, [
    sessionId,
    userData.userId || userData.id || userData.sub || userData.email,
    userData.email,
    userData.name || null,
    userData.picture || null,
    userData.accessToken || null,
    userData.refreshToken || null,
    userData.tokenExpiry || null,
    nowStr,
    nowStr
  ]);

  return await this.getSession(sessionId);
};

SessionRepository.prototype.getSession = async function(sessionId) {
  if (!sessionId) return null;
  return await this.db.get('SELECT * FROM user_sessions WHERE session_id = ?', [sessionId]);
};

SessionRepository.prototype.updateSessionTokens = async function(sessionId, accessToken, tokenExpiry) {
  var nowStr = timeUtils.dtToStr(timeUtils.localNow());
  await this.db.run(
    'UPDATE user_sessions SET access_token = ?, token_expiry = ?, last_seen_at = ? WHERE session_id = ?',
    [accessToken, tokenExpiry, nowStr, sessionId]
  );
};

SessionRepository.prototype.deleteSession = async function(sessionId) {
  await this.db.run('DELETE FROM user_sessions WHERE session_id = ?', [sessionId]);
};

module.exports = {
  Database: Database,
  ReminderRepository: ReminderRepository,
  ExternalReminderRepository: ExternalReminderRepository,
  UrgentAckRepository: UrgentAckRepository,
  GoogleRepository: GoogleRepository,
  AppConfigRepository: AppConfigRepository,
  SessionRepository: SessionRepository,
  uuidv4: uuidv4
};

