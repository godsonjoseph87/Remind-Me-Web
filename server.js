/**
 * RemindMe Web Application — Node.js Server & REST API.
 * Compatible with Node.js 12+.
 */

'use strict';

require('./src/utils/env-loader');

var http = require('http');
var path = require('path');
var fs = require('fs');
var express = require('express');
var cookieParser = require('cookie-parser');
var cors = require('cors');

var databaseModule = require('./src/db/database');
var timeUtils = require('./src/utils/time-utils');
var soundGenerator = require('./src/notifications/sound-generator');
var scheduler = require('./src/scheduler/scheduler');
var urgentNudges = require('./src/scheduler/urgent-nudges');
var externalReminders = require('./src/scheduler/external-reminders');
var GoogleAuth = require('./src/integrations/google-auth');
var googleSync = require('./src/integrations/google-sync');
var icalSync = require('./src/integrations/ical-sync');
var ReminderDaemon = require('./src/daemon/reminder-daemon');

var PORT = parseInt(process.env.PORT || '3000', 10);
var HOST = process.env.HOST || '0.0.0.0';
var APP_BASE_PATH = (process.env.APP_BASE_PATH || '/remind-me').replace(/\/+$/, '');

var app = express();
app.enable('trust proxy');
var server = http.createServer(app);

function stripBasePath(req, res, next) {
  if (!req || !req.url) return next();

  var base = APP_BASE_PATH || '';
  var rawUrl = req.originalUrl || req.url;
  var pathPart = rawUrl.split('?')[0];

  if (base && (pathPart === base || pathPart === base + '/' || pathPart.indexOf(base + '/') === 0)) {
    var strippedPath = pathPart.slice(base.length) || '/';
    var query = rawUrl.indexOf('?') >= 0 ? rawUrl.substring(rawUrl.indexOf('?')) : '';
    req.url = strippedPath + query;
    req.originalUrl = strippedPath + query;
  }

  next();
}

// Middlewares
app.use(cors());
app.use(cookieParser('remindme-secret-key'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(stripBasePath);

// Serve static frontend
app.use(function(req, res, next) {
  var isFrontendAsset = /\.(html|js|css|svg|json|png|jpg|jpeg|webp|ico)$/i.test(req.path);
  if (isFrontendAsset) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use('/static', express.static(path.resolve(__dirname, 'public')));
app.use(express.static(path.resolve(__dirname, 'public')));

// Database & Repositories
var dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, 'data/reminders.db');
var db = new databaseModule.Database(dbPath);

var reminderRepo = new databaseModule.ReminderRepository(db);
var extRepo = new databaseModule.ExternalReminderRepository(db);
var urgentAckRepo = new databaseModule.UrgentAckRepository(db);
var googleRepo = new databaseModule.GoogleRepository(db);
var configRepo = new databaseModule.AppConfigRepository(db);
var sessionRepo = new databaseModule.SessionRepository(db);

var googleAuth = new GoogleAuth(configRepo);
var GDriveSync = require('./src/integrations/gdrive-sync');
var gdriveSync = new GDriveSync(googleAuth, configRepo);
var GoogleCalendar = require('./src/integrations/google-calendar');
var googleCalendar = new GoogleCalendar(googleAuth, configRepo);

// Helper: auto-sync changes to Google Drive in background
function triggerDriveBackup(user) {
  setTimeout(async function() {
    try {
      await gdriveSync.syncToDrive(user, reminderRepo, extRepo, googleRepo);
    } catch (e) {
      // Skipped if user not yet signed in with Google
    }
  }, 1000);
}

// SSE connection pool
var sseClients = new Set();

// Background Daemon
var daemon = new ReminderDaemon({
  reminderRepo: reminderRepo,
  googleRepo: googleRepo,
  extRepo: extRepo,
  urgentAckRepo: urgentAckRepo,
  sseClients: sseClients
});

// Periodic Google Calendar & Tasks background sync (every 5 seconds)
var lastSyncSummary = '';
var syncTimer = setInterval(async function() {
  try {
    var hasCreds = await googleAuth.hasCredentials();
    var hasToken = await configRepo.get('google_access_token');
    if (hasCreds && hasToken) {
      var syncRes = await googleSync.syncGoogle(googleRepo, googleAuth, configRepo);
      if (syncRes && syncRes.synced) {
        var currentSummary = syncRes.calendar_events + ':' + syncRes.tasks;
        if (currentSummary !== lastSyncSummary) {
          lastSyncSummary = currentSummary;
          daemon.broadcast('GOOGLE_EVENTS_UPDATED', syncRes);
        }
      }
    }
  } catch (err) {}
}, 5000);
if (syncTimer && syncTimer.unref) syncTimer.unref();

// Helper: Serializer for reminder
async function serializeReminder(reminder, now) {
  if (!reminder) return null;
  now = now || timeUtils.localNow();
  var nf = scheduler.nextFireTime(reminder, now);
  var priorityMeta = soundGenerator.PRIORITIES[reminder.priority] || soundGenerator.PRIORITIES.normal;

  var windowStr = null;
  if (scheduler.hasActiveWindow(reminder)) {
    windowStr = timeUtils.formatTime12(reminder.active_from) + ' – ' + timeUtils.formatTime12(reminder.active_until);
  }

  var isRecurring = reminder.type !== 'ONE_TIME';
  var uFields = await urgentNudges.urgentFields(reminder, urgentAckRepo, now);

  return Object.assign(
    {},
    reminder,
    {
      all_day: Boolean(reminder.all_day),
      priority_label: priorityMeta.label,
      priority_color: priorityMeta.color,
      active_window: windowStr,
      until_dismissed: isRecurring,
      next_fire: nf ? timeUtils.dtToStr(nf) : null,
      is_recurring: isRecurring
    },
    uFields
  );
}

// Helper: External event serializer
function serializeExternalEvent(event, prefs, settings, now) {
  now = now || timeUtils.localNow();
  var p = prefs || {};
  return {
    id: event.id,
    source: event.source,
    title: event.title,
    description: event.description || '',
    start_time: event.start_time,
    end_time: event.end_time,
    all_day: Boolean(event.all_day),
    status: event.status || 'SYNCED',
    html_link: event.html_link || null,
    calendar_id: event.calendar_id || null,
    synced_at: event.synced_at,
    silent: Boolean(p.silent),
    reminder_offsets: (settings && settings.offsets_minutes) || [10, 5, 0],
    addressed: Boolean(p.addressed),
    addressed_at: p.addressed_at || null,
    started: externalReminders.eventHasStarted(event, now),
    in_nudge_window: externalReminders.isWithinEventWindow(event, now)
  };
}

// Helper: Session middleware
async function authMiddleware(req, res, next) {
  var sid = req.cookies.remindme_session;
  req.user = null;
  if (sid) {
    try {
      var session = await sessionRepo.getSession(sid);
      if (session) {
        req.user = {
          userId: session.user_id,
          email: session.email,
          name: session.name,
          picture: session.picture,
          accessToken: session.access_token
        };
      }
    } catch (e) {}
  }
  next();
}

app.use(authMiddleware);

// ==========================================
// API Routes
// ==========================================

// Meta definitions
app.get('/api/meta', function(req, res) {
  res.json({
    tones: soundGenerator.listTones(),
    priorities: Object.keys(soundGenerator.PRIORITIES).map(function(k) {
      return Object.assign({ id: k }, soundGenerator.PRIORITIES[k]);
    }),
    types: [
      { id: 'ONE_TIME', label: 'One Time', icon: '📌' },
      { id: 'DAILY', label: 'Daily until dismissed', icon: '☀️' },
      { id: 'HOURLY', label: 'Hourly', icon: '⏰' },
      { id: 'INTERVAL_MINUTES', label: 'Interval', icon: '🔄' },
      { id: 'WEEKLY', label: 'Weekly', icon: '📅' }
    ],
    colors: [
      '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
      '#f97316', '#eab308', '#22c55e', '#06b6d4'
    ],
    statuses: ['PENDING', 'SNOOZED', 'TRIGGERED', 'DISMISSED']
  });
});

// Stats
app.get('/api/stats', async function(req, res) {
  try {
    var all = await reminderRepo.listAll({ includeDismissed: true, userId: req.user ? req.user.userId : null });
    var active = all.filter(function(r) { return r.status === 'PENDING' || r.status === 'SNOOZED'; });
    res.json({
      total: all.length,
      active: active.length,
      pending: all.filter(function(r) { return r.status === 'PENDING'; }).length,
      snoozed: all.filter(function(r) { return r.status === 'SNOOZED'; }).length,
      dismissed: all.filter(function(r) { return r.status === 'DISMISSED'; }).length,
      triggered: all.filter(function(r) { return r.status === 'TRIGGERED'; }).length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real-time Server-Sent Events (SSE) notification stream
app.get('/api/events/stream', function(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('event: connected\ndata: {"status":"connected"}\n\n');

  sseClients.add(res);

  req.on('close', function() {
    sseClients.delete(res);
  });
});

// Tone audio preview stream (WAV)
app.get('/api/tones/:tone/wav', function(req, res) {
  var toneId = req.params.tone || 'chime';
  var samples = soundGenerator.generateToneSamples(toneId);
  if (!samples) {
    return res.status(404).send('Tone not found or silent');
  }
  var wavBuf = soundGenerator.createWavBuffer(samples);
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': wavBuf.length,
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(wavBuf);
});

// Tone preview test endpoint
app.post('/api/tones/preview', function(req, res) {
  var tone = (req.body && req.body.tone) || 'chime';
  res.json({ played: true, tone: tone, wavUrl: '/api/tones/' + encodeURIComponent(tone) + '/wav' });
});

// Reminders list
app.get('/api/reminders', async function(req, res) {
  try {
    if (req.query.source === 'google') {
      var limit = parseInt(req.query.limit || '100', 10);
      var dated = await googleRepo.listFromToday(limit);
      var undated = await googleRepo.listTasksWithoutDue(limit);

      if (dated.length === 0 && undated.length === 0) {
        try {
          await googleSync.syncGoogle(googleRepo, googleAuth, configRepo, req.user);
          dated = await googleRepo.listFromToday(limit);
          undated = await googleRepo.listTasksWithoutDue(limit);
        } catch (syncErr) {}
      }

      var events = dated.concat(undated);
      var ids = events.map(function(e) { return e.id; });
      var prefs = await extRepo.getPrefsBatch(ids);
      var settings = await extRepo.getSettings();
      var now = timeUtils.localNow();

      var list = events.map(function(e) {
        return serializeExternalEvent(e, prefs[e.id], settings, now);
      });
      return res.json(list);
    }

    var includeDismissed = String(req.query.all).toLowerCase() === 'true';
    var statusFilter = req.query.status || null;

    var rows = await reminderRepo.listAll({
      includeDismissed: includeDismissed,
      status: statusFilter,
      userId: req.user ? req.user.userId : null
    });

    var nowTime = timeUtils.localNow();
    var payload = [];
    for (var i = 0; i < rows.length; i++) {
      payload.push(await serializeReminder(rows[i], nowTime));
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create reminder
app.post('/api/reminders', async function(req, res) {
  try {
    var data = req.body || {};
    var title = (data.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });

    var rtype = data.type || 'ONE_TIME';
    var triggerTime = null;
    if (data.trigger_time) {
      if (rtype === 'ONE_TIME') {
        triggerTime = timeUtils.strToDt(data.trigger_time);
      } else {
        var parsedTime = timeUtils.parseTimeValue(data.trigger_time);
        if (parsedTime) {
          triggerTime = timeUtils.combineTimeWithToday(parsedTime, timeUtils.localNow());
        } else {
          triggerTime = timeUtils.strToDt(data.trigger_time);
        }
      }
    }

    if (rtype === 'ONE_TIME' && !triggerTime) {
      return res.status(400).json({ error: 'trigger_time required for ONE_TIME' });
    }
    if (rtype === 'DAILY' && !triggerTime) {
      return res.status(400).json({ error: 'time required for daily reminder' });
    }
    if (rtype === 'WEEKLY' && (!triggerTime || !data.days_of_week)) {
      return res.status(400).json({ error: 'time and days_of_week required for WEEKLY' });
    }
    if (rtype === 'INTERVAL_MINUTES' && !data.interval_minutes) {
      return res.status(400).json({ error: 'interval_minutes required for INTERVAL_MINUTES' });
    }
    if (rtype === 'HOURLY' && !triggerTime) {
      var hNow = timeUtils.localNow();
      hNow.setMinutes(0, 0, 0);
      triggerTime = hNow;
    }

    var activeFrom = null;
    var activeUntil = null;
    if (data.use_active_window) {
      activeFrom = timeUtils.parseTimeValue(data.active_from || '08:00:00');
      activeUntil = timeUtils.parseTimeValue(data.active_until || '18:00:00');
    }

    var reminder = await reminderRepo.create({
      title: title,
      description: data.description || '',
      type: rtype,
      trigger_time: triggerTime,
      interval_minutes: data.interval_minutes ? parseInt(data.interval_minutes, 10) : null,
      days_of_week: data.days_of_week || null,
      tone: data.tone || 'chime',
      priority: data.priority || 'normal',
      color: data.color || '#6366f1',
      all_day: Boolean(data.all_day),
      active_from: activeFrom,
      active_until: activeUntil,
      user_id: req.user ? req.user.userId : null
    });

    var serialized = await serializeReminder(reminder);
    triggerDriveBackup(req.user);
    res.status(201).json(serialized);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reorder reminders
app.post('/api/reminders/reorder', async function(req, res) {
  try {
    var order = req.body && req.body.order;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'order must be a non-empty list of reminder ids' });
    }
    await reminderRepo.reorder(order);
    triggerDriveBackup(req.user);
    var all = await reminderRepo.listAll({ includeDismissed: true, userId: req.user ? req.user.userId : null });
    var payload = [];
    for (var i = 0; i < all.length; i++) {
      payload.push(await serializeReminder(all[i]));
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single reminder
app.get('/api/reminders/:id', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });
    var reminder = await reminderRepo.get(resolved);
    var logs = await reminderRepo.logsForReminder(resolved, 10);
    var serialized = await serializeReminder(reminder);
    res.json({ reminder: serialized, logs: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update reminder
app.put('/api/reminders/:id', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });

    var data = req.body || {};
    var triggerTime = undefined;
    if (data.trigger_time !== undefined) {
      if (!data.trigger_time) {
        triggerTime = null;
      } else {
        var parsedTime = timeUtils.parseTimeValue(data.trigger_time);
        if (parsedTime && data.type !== 'ONE_TIME') {
          triggerTime = timeUtils.combineTimeWithToday(parsedTime, timeUtils.localNow());
        } else {
          triggerTime = timeUtils.strToDt(data.trigger_time);
        }
      }
    }

    var updates = {
      title: data.title,
      description: data.description,
      type: data.type,
      trigger_time: triggerTime,
      interval_minutes: data.interval_minutes,
      days_of_week: data.days_of_week,
      tone: data.tone,
      priority: data.priority,
      color: data.color,
      all_day: data.all_day,
      sort_order: data.sort_order
    };

    if (data.use_active_window === false) {
      updates.clear_active_window = true;
    } else if (data.use_active_window === true || (data.active_from && data.active_until)) {
      updates.active_from = data.active_from;
      updates.active_until = data.active_until;
    }

    var updated = await reminderRepo.update(resolved, updates);
    triggerDriveBackup(req.user);
    var serialized = await serializeReminder(updated);
    res.json(serialized);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete reminder
app.delete('/api/reminders/:id', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });
    await reminderRepo.delete(resolved);
    triggerDriveBackup(req.user);
    res.json({ deleted: true, id: resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Snooze reminder
app.post('/api/reminders/:id/snooze', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });
    var minutes = parseInt((req.body && req.body.minutes) || 5, 10);
    var updated = await reminderRepo.snooze(resolved, minutes);
    triggerDriveBackup(req.user);
    var serialized = await serializeReminder(updated);
    res.json(serialized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss reminder
app.post('/api/reminders/:id/dismiss', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });
    var updated = await reminderRepo.dismiss(resolved);
    triggerDriveBackup(req.user);
    var serialized = await serializeReminder(updated);
    res.json(serialized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reactivate reminder
app.post('/api/reminders/:id/reactivate', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });
    var updated = await reminderRepo.reactivate(resolved);
    triggerDriveBackup(req.user);
    var serialized = await serializeReminder(updated);
    res.json(serialized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark reminder addressed
app.post('/api/reminders/:id/addressed', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });
    var reminder = await reminderRepo.get(resolved);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });

    var now = timeUtils.localNow();
    if (!urgentNudges.inUrgentNudgeWindow(reminder, now)) {
      return res.status(400).json({ error: 'Address mark is only available during the urgent reminder window' });
    }
    var cur = urgentNudges.currentUrgentOccurrence(reminder, now);
    if (!cur.key) {
      return res.status(400).json({ error: 'No active urgent occurrence' });
    }
    await urgentAckRepo.markAddressed(resolved, cur.key);
    res.json({
      id: resolved,
      addressed: true,
      addressed_at: timeUtils.dtToStr(now),
      urgent_occurrence_key: cur.key
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test reminder trigger
app.post('/api/reminders/:id/test', async function(req, res) {
  try {
    var resolved = await reminderRepo.resolveId(req.params.id);
    if (!resolved) return res.status(404).json({ error: 'Reminder not found' });
    var reminder = await reminderRepo.get(resolved);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });

    var nowStr = timeUtils.dtToStr(timeUtils.localNow());
    daemon.broadcast('REMINDER_FIRED', {
      reminder: reminder,
      type: 'REMINDER_FIRED',
      fired_at: nowStr,
      test: true
    });
    daemon.fireDesktopNotification('⏰ Test: ' + reminder.title, reminder.description || 'Test notification', 'normal');
    res.json({ sent: true, id: resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calendar monthly view
app.get('/api/calendar', async function(req, res) {
  try {
    var now = timeUtils.localNow();
    var year = parseInt(req.query.year || now.getFullYear(), 10);
    var month = parseInt(req.query.month || (now.getMonth() + 1), 10);

    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'Month must be 1-12' });
    }

    var start = new Date(year, month - 1, 1);
    var end = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1);

    var statusFilter = req.query.status || null;
    var googleOnly = req.query.source === 'google' || statusFilter === 'GOOGLE';

    var days = {};

    if (!googleOnly) {
      var reminders;
      if (statusFilter && statusFilter !== 'all' && statusFilter !== 'GOOGLE') {
        reminders = await reminderRepo.listAll({ includeDismissed: true, status: statusFilter });
      } else {
        reminders = await reminderRepo.listAll({ includeDismissed: false });
      }

      for (var i = 0; i < reminders.length; i++) {
        var r = reminders[i];
        if (r.status === 'TRIGGERED') continue;
        var fires = scheduler.occurrencesInRange(r, start, end, 200);
        for (var f = 0; f < fires.length; f++) {
          var fireDate = fires[f];
          var dayKey = timeUtils.dtToStr(fireDate).slice(0, 10);
          var timeStr = timeUtils.dtToStr(fireDate).slice(11);
          if (!days[dayKey]) days[dayKey] = [];
          days[dayKey].push({
            reminder_id: r.id,
            title: r.title,
            time: timeStr,
            all_day: Boolean(r.all_day),
            color: r.color,
            priority: r.priority,
            type: r.type,
            status: r.status
          });
        }
      }
    }

    // Include Google/iCal events
    var googleEvents = await googleRepo.listInRange(start, end);
    for (var g = 0; g < googleEvents.length; g++) {
      var ev = googleEvents[g];
      if (!ev.start_time) continue;
      var evDt = timeUtils.strToDt(ev.start_time);
      if (!evDt) continue;
      var evDayKey = timeUtils.dtToStr(evDt).slice(0, 10);
      var evTimeStr = timeUtils.dtToStr(evDt).slice(11);

      var color = ev.source === 'google_calendar' ? '#4285f4' : ev.source === 'google_tasks' ? '#34a853' : '#9333ea';
      var sourceLabel = ev.source === 'google_calendar' ? 'Calendar' : ev.source === 'google_tasks' ? 'Tasks' : 'Calendar link';

      if (!days[evDayKey]) days[evDayKey] = [];
      days[evDayKey].push({
        reminder_id: null,
        external_id: ev.id,
        title: ev.title,
        time: evTimeStr,
        all_day: Boolean(ev.all_day),
        color: color,
        priority: 'normal',
        type: ev.source,
        status: ev.status || 'SYNCED',
        is_google: true,
        source_label: sourceLabel,
        html_link: ev.html_link,
        description: ev.description
      });
    }

    // Sort events on each day by time
    var dayKeys = Object.keys(days);
    for (var k = 0; k < dayKeys.length; k++) {
      days[dayKeys[k]].sort(function(a, b) {
        return a.time.localeCompare(b.time);
      });
    }

    res.json({
      year: year,
      month: month,
      days: days
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Google Authentication & Integration Routes
// ==========================================

function getAppBasePath(req) {
  var reqBase = (req && (req.headers && (req.headers['x-forwarded-prefix'] || req.headers['x-forwarded-prefix']))) || process.env.APP_BASE_PATH || '';
  if (reqBase && typeof reqBase === 'string') {
    return reqBase.replace(/\/+$/, '');
  }
  return APP_BASE_PATH || '';
}

function getRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  var basePath = getAppBasePath(req);
  var callbackPath = basePath ? basePath + '/api/google/oauth/callback' : '/api/google/oauth/callback';
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '') + callbackPath;
  if (req) {
    var proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    var host = req.headers['x-forwarded-host'] || req.get('host');
    if (host) return proto + '://' + host + callbackPath;
  }
  var h = (HOST === '0.0.0.0') ? '127.0.0.1' : HOST;
  return 'http://' + h + ':' + PORT + callbackPath;
}

app.get('/api/google/status', async function(req, res) {
  try {
    var redirectUri = getRedirectUri(req);
    var state = await googleRepo.getSyncState();
    var hasCreds = await googleAuth.hasCredentials();
    var creds = await googleAuth.getClientCredentials();
    var feeds = await googleRepo.listFeeds();
    var extSettings = await extRepo.getSettings();

    var hasToken = Boolean(await configRepo.get('google_access_token') || (req.user && req.user.accessToken));

    res.json({
      connected: Boolean(state.account_email || hasToken),
      has_credentials: hasCreds,
      signin_ready: hasCreds,
      signin_mode: 'web',
      credentials_source: creds ? creds.source : null,
      calendar_feeds: feeds,
      ical_connected: feeds.length > 0,
      credentials_path: creds ? creds.path || null : null,
      libraries_available: true,
      setup_instructions: 'Add Client ID and Client Secret in setup guide.',
      last_sync_at: state.last_sync_at ? timeUtils.dtToStr(state.last_sync_at) : null,
      last_error: state.last_error,
      account_email: state.account_email || (req.user ? req.user.email : null),
      account_name: state.account_name || (req.user ? req.user.name : null),
      account_picture: state.account_picture || (req.user ? req.user.picture : null),
      events_count: await googleRepo.countAll(),
      redirect_uri: redirectUri,
      reminder_settings: {
        offsets_minutes: extSettings.offsets_minutes,
        tone: extSettings.tone,
        enabled: extSettings.enabled
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/auth', async function(req, res) {
  try {
    var authUrl = await googleAuth.createAuthUrl(getRedirectUri(req));
    res.json({ auth_url: authUrl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/google/signin', async function(req, res) {
  try {
    var authUrl = await googleAuth.createAuthUrl(getRedirectUri(req));
    res.json({ status: 'redirect', auth_url: authUrl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// OAuth Callback
app.get('/api/google/oauth/callback', async function(req, res) {
  var code = req.query.code;
  var error = req.query.error;

  var baseRedirect = APP_BASE_PATH || '';
  if (error) {
    return res.redirect(baseRedirect + '/?google=error&message=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.redirect(baseRedirect + '/?google=error&message=missing_code');
  }

  try {
    var redirectUri = getRedirectUri(req);
    var tokenData = await googleAuth.exchangeCode(code, redirectUri);
    var userInfo = await googleAuth.getUserInfo(tokenData.accessToken);

    // Save tokens in configRepo
    await configRepo.set('google_access_token', tokenData.accessToken);
    if (tokenData.refreshToken) {
      await configRepo.set('google_refresh_token', tokenData.refreshToken);
    }
    var expiry = Date.now() + (tokenData.expiresIn || 3600) * 1000;
    await configRepo.set('google_token_expiry', String(expiry));

    // Update sync state
    await googleRepo.updateSyncState({
      account_email: userInfo.email,
      account_name: userInfo.name,
      account_picture: userInfo.picture,
      clear_error: true
    });

    // Create session cookie for user login!
    var session = await sessionRepo.createSession({
      userId: userInfo.sub || userInfo.email,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      tokenExpiry: expiry
    });

    res.cookie('remindme_session', session.session_id, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true
    });

    // 1. Sync & Restore user events and tasks from Google Drive
    try {
      await gdriveSync.syncFromDrive(
        {
          userId: userInfo.sub || userInfo.email,
          email: userInfo.email,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          tokenExpiry: expiry
        },
        reminderRepo,
        extRepo,
        googleRepo
      );
    } catch (driveErr) {
      console.warn('[GDrive] Initial restore warning:', driveErr.message);
    }

    // 2. Trigger initial Google Calendar & Tasks sync
    try {
      await googleSync.syncGoogle(googleRepo, googleAuth, configRepo);
    } catch (syncErr) {
      console.warn('Initial Google sync warning:', syncErr.message);
    }

    res.redirect((APP_BASE_PATH || '') + '/?google=connected');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect((APP_BASE_PATH || '') + '/?google=error&message=' + encodeURIComponent(err.message.slice(0, 200)));
  }
});

// Save client credentials
app.post('/api/google/credentials', async function(req, res) {
  try {
    var body = req.body || {};
    var clientId = body.client_id;
    var clientSecret = body.client_secret;

    if (!clientId && body.credentials) {
      var raw = body.credentials;
      if (typeof raw === 'string') raw = JSON.parse(raw);
      var b = raw.web || raw.installed || raw;
      clientId = b.client_id;
      clientSecret = b.client_secret;
    }

    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Client ID and Client Secret are required' });
    }

    var redirectUriOverride = body.redirect_uri || (body.credentials && (body.credentials.web || body.credentials.installed || body.credentials).redirect_uris && (body.credentials.web || body.credentials.installed || body.credentials).redirect_uris[0]);
    var result = await googleAuth.saveCredentials(clientId, clientSecret, redirectUriOverride);
    res.json({
      saved: true,
      path: result.path,
      message: 'Credentials saved! You can now click Sign in with Google.'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Google sync manual
app.post('/api/google/sync', async function(req, res) {
  try {
    var result = await googleSync.syncGoogle(googleRepo, googleAuth, configRepo, req.user);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google disconnect
app.post('/api/google/disconnect', async function(req, res) {
  try {
    await configRepo.set('google_access_token', '');
    await configRepo.set('google_refresh_token', '');
    await configRepo.set('google_token_expiry', '');
    await googleRepo.clearAll();
    res.clearCookie('remindme_session');
    res.json({ disconnected: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google events
app.get('/api/google/events', async function(req, res) {
  try {
    var limit = parseInt(req.query.limit || '50', 10);
    var source = req.query.source || null;
    var upcoming = await googleRepo.listUpcoming(limit, source);
    var undated = [];
    if (!source || source === 'google_tasks') {
      undated = await googleRepo.listTasksWithoutDue(limit);
    }
    var events = upcoming.concat(undated);
    var ids = events.map(function(e) { return e.id; });
    var prefs = await extRepo.getPrefsBatch(ids);
    var settings = await extRepo.getSettings();
    var now = timeUtils.localNow();

    var payload = events.map(function(e) {
      return serializeExternalEvent(e, prefs[e.id], settings, now);
    });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/events/silent', async function(req, res) {
  try {
    var eventId = req.body && req.body.id;
    if (!eventId) return res.status(400).json({ error: 'Event id required' });
    var silent = Boolean(req.body.silent !== undefined ? req.body.silent : true);
    await extRepo.setSilent(eventId, silent);
    res.json({ id: eventId, silent: silent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/events/snooze', async function(req, res) {
  try {
    var eventId = req.body && req.body.id;
    if (!eventId) return res.status(400).json({ error: 'Event id required' });
    var offset = parseInt((req.body && req.body.offset_minutes) || 10, 10);
    var minutes = parseInt((req.body && req.body.minutes) || 5, 10);
    var until = await extRepo.snooze(eventId, offset, minutes);
    res.json({ id: eventId, offset_minutes: offset, snooze_until: timeUtils.dtToStr(until) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/events/addressed', async function(req, res) {
  try {
    var eventId = req.body && req.body.id;
    if (!eventId) return res.status(400).json({ error: 'Event id required' });
    var event = await googleRepo.getEvent(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!externalReminders.GOOGLE_ADDRESS_SOURCES.has(event.source)) {
      return res.status(400).json({ error: 'Address tracking is only available for Google events and tasks' });
    }
    await extRepo.markAddressed(eventId);
    res.json({ id: eventId, addressed: true, addressed_at: timeUtils.dtToStr(timeUtils.localNow()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/reminder-settings', async function(req, res) {
  try {
    var s = await extRepo.getSettings();
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/google/reminder-settings', async function(req, res) {
  try {
    var s = await extRepo.updateSettings(req.body || {});
    res.json(s);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/google/setup-guide', function(req, res) {
  var redirectUri = getRedirectUri(req);
  res.json(googleAuth.getSetupGuide(redirectUri));
});

// ==========================================
// Calendar Feeds (iCal)
// ==========================================

app.get('/api/calendar-feeds', async function(req, res) {
  try {
    var feeds = await googleRepo.listFeeds();
    res.json(feeds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calendar-feeds', async function(req, res) {
  try {
    var url = (req.body && req.body.url || '').trim();
    var label = (req.body && req.body.label || 'Google Calendar').trim();
    if (!url) return res.status(400).json({ error: 'Calendar link URL is required' });

    var validUrl = icalSync.validateFeedUrl(url);
    var feed = await googleRepo.addFeed(validUrl, label);
    var syncRes = await icalSync.syncIcalFeed(feed.id, validUrl, googleRepo);
    res.status(201).json({ feed: feed, sync: syncRes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/calendar-feeds/:id', async function(req, res) {
  try {
    await googleRepo.removeFeed(parseInt(req.params.id, 10));
    res.json({ removed: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/calendar-feeds/sync', async function(req, res) {
  try {
    var result = await icalSync.syncAllFeeds(googleRepo);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Google Calendar API v3 Full Suite Endpoints
// Implements Acl, CalendarList, Calendars, Channels, Colors, Events, Freebusy, Settings
// ==========================================

// 1. Events Resource
app.get('/api/google/calendar/events', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var options = {
      timeMin: req.query.timeMin,
      timeMax: req.query.timeMax,
      q: req.query.q,
      singleEvents: req.query.singleEvents !== undefined ? req.query.singleEvents : 'true',
      orderBy: req.query.orderBy || 'startTime',
      maxResults: req.query.maxResults ? parseInt(req.query.maxResults, 10) : 250,
      pageToken: req.query.pageToken
    };
    var data = await googleCalendar.listEvents(req.user, calendarId, options);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schedule a Google Meet call / conference call
app.post('/api/google/calls/schedule', async function(req, res) {
  try {
    var body = req.body || {};
    var title = body.title || body.summary;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Call title / topic is required' });
    }

    var startTime = body.start_time || body.startTime;
    if (!startTime) {
      return res.status(400).json({ error: 'Start date and time is required' });
    }

    var result = await googleCalendar.scheduleCall(req.user, {
      title: title.trim(),
      description: body.description || '',
      start_time: startTime,
      end_time: body.end_time || body.endTime,
      durationMinutes: body.durationMinutes || body.duration || 30,
      attendees: body.attendees,
      calendarId: body.calendarId || 'primary',
      sendUpdates: body.sendUpdates || 'all'
    });

    var meetLink = result.hangoutLink ||
      (result.conferenceData && result.conferenceData.entryPoints && result.conferenceData.entryPoints[0] && result.conferenceData.entryPoints[0].uri) ||
      null;

    // Trigger sync and broadcast immediately
    setTimeout(function() {
      googleSync.syncGoogle(googleRepo, googleAuth, configRepo, req.user)
        .then(function(syncRes) {
          daemon.broadcast('GOOGLE_EVENTS_UPDATED', syncRes);
        })
        .catch(function() {});
    }, 500);

    triggerDriveBackup(req.user);

    res.status(201).json({
      success: true,
      event: result,
      meetLink: meetLink,
      message: 'Call scheduled successfully with Google Meet!'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Accept Google Calendar event or Google Task
app.post('/api/google/items/:id/accept', async function(req, res) {
  try {
    var itemId = req.params.id;
    var event = await googleRepo.getEvent(itemId);
    if (!event) {
      return res.status(404).json({ error: 'Item not found' });
    }

    var rawId = itemId.replace(/^(cal:|task:)/, '');
    var result = { success: true, id: itemId };

    if (event.source === 'google_tasks') {
      try {
        await googleCalendar.completeTask(req.user, event.calendar_id, rawId);
      } catch (apiErr) {}
      await googleRepo.updateEventStatus(itemId, 'completed');
      result.status = 'completed';
    } else {
      try {
        await googleCalendar.respondToEvent(req.user, event.calendar_id || 'primary', rawId, 'accepted');
      } catch (apiErr) {}
      await googleRepo.updateEventStatus(itemId, 'accepted');
      result.status = 'accepted';
    }

    daemon.broadcast('GOOGLE_ITEMS_CHANGED', { id: itemId, status: result.status, action: 'accept' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject Google Calendar event or Google Task
app.post('/api/google/items/:id/reject', async function(req, res) {
  try {
    var itemId = req.params.id;
    var event = await googleRepo.getEvent(itemId);
    if (!event) {
      return res.status(404).json({ error: 'Item not found' });
    }

    var rawId = itemId.replace(/^(cal:|task:)/, '');
    var result = { success: true, id: itemId };

    if (event.source === 'google_tasks') {
      try {
        await googleCalendar.deleteTask(req.user, event.calendar_id, rawId);
      } catch (apiErr) {}
      await googleRepo.deleteEvent(itemId);
      result.status = 'deleted';
    } else {
      try {
        await googleCalendar.respondToEvent(req.user, event.calendar_id || 'primary', rawId, 'declined');
      } catch (apiErr) {}
      await googleRepo.updateEventStatus(itemId, 'declined');
      result.status = 'declined';
    }

    daemon.broadcast('GOOGLE_ITEMS_CHANGED', { id: itemId, status: result.status, action: 'reject' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/calendar/events/:eventId', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var data = await googleCalendar.getEvent(req.user, calendarId, req.params.eventId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/calendar/events', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || (req.body && req.body.calendarId) || 'primary';
    var eventData = req.body || {};
    var data = await googleCalendar.createEvent(req.user, calendarId, eventData);
    setTimeout(function() { googleSync.syncGoogle(googleRepo, googleAuth, configRepo).catch(function() {}); }, 500);
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/google/calendar/events/quickAdd', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var text = (req.body && req.body.text) || req.query.text;
    if (!text) return res.status(400).json({ error: 'Text query is required for quickAdd' });
    var data = await googleCalendar.quickAddEvent(req.user, calendarId, text);
    setTimeout(function() { googleSync.syncGoogle(googleRepo, googleAuth, configRepo).catch(function() {}); }, 500);
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/google/calendar/events/import', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var data = await googleCalendar.importEvent(req.user, calendarId, req.body || {});
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/google/calendar/events/:eventId', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var data = await googleCalendar.patchEvent(req.user, calendarId, req.params.eventId, req.body || {});
    setTimeout(function() { googleSync.syncGoogle(googleRepo, googleAuth, configRepo).catch(function() {}); }, 500);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/google/calendar/events/:eventId', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var data = await googleCalendar.updateEvent(req.user, calendarId, req.params.eventId, req.body || {});
    setTimeout(function() { googleSync.syncGoogle(googleRepo, googleAuth, configRepo).catch(function() {}); }, 500);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/google/calendar/events/:eventId', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var data = await googleCalendar.deleteEvent(req.user, calendarId, req.params.eventId);
    setTimeout(function() { googleSync.syncGoogle(googleRepo, googleAuth, configRepo).catch(function() {}); }, 500);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/google/calendar/events/:eventId/instances', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var data = await googleCalendar.getEventInstances(req.user, calendarId, req.params.eventId, req.query);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/calendar/events/:eventId/move', async function(req, res) {
  try {
    var calendarId = req.query.calendarId || 'primary';
    var dest = req.query.destination || (req.body && req.body.destination);
    if (!dest) return res.status(400).json({ error: 'Destination calendar required' });
    var data = await googleCalendar.moveEvent(req.user, calendarId, req.params.eventId, dest);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. CalendarList Resource
app.get('/api/google/calendar/list', async function(req, res) {
  try {
    var data = await googleCalendar.listCalendarList(req.user, req.query);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/calendar/list/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.getCalendarListEntry(req.user, req.params.calendarId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/calendar/list', async function(req, res) {
  try {
    var data = await googleCalendar.insertCalendarListEntry(req.user, req.body || {});
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/google/calendar/list/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.patchCalendarListEntry(req.user, req.params.calendarId, req.body || {});
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/google/calendar/list/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.deleteCalendarListEntry(req.user, req.params.calendarId);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 3. Calendars Resource (Metadata & Secondary Calendars)
app.get('/api/google/calendar/meta/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.getCalendar(req.user, req.params.calendarId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/calendar/secondary', async function(req, res) {
  try {
    var data = await googleCalendar.createCalendar(req.user, req.body || {});
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/google/calendar/meta/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.patchCalendar(req.user, req.params.calendarId, req.body || {});
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/google/calendar/meta/:calendarId/clear', async function(req, res) {
  try {
    var data = await googleCalendar.clearCalendar(req.user, req.params.calendarId);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/google/calendar/meta/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.deleteCalendar(req.user, req.params.calendarId);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Colors Resource
app.get('/api/google/calendar/colors', async function(req, res) {
  try {
    var data = await googleCalendar.getColors(req.user);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Freebusy Resource
app.post('/api/google/calendar/freebusy', async function(req, res) {
  try {
    var data = await googleCalendar.queryFreeBusy(req.user, req.body || {});
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Settings Resource
app.get('/api/google/calendar/settings', async function(req, res) {
  try {
    var data = await googleCalendar.listSettings(req.user);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/calendar/settings/:settingId', async function(req, res) {
  try {
    var data = await googleCalendar.getSetting(req.user, req.params.settingId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Acl Resource (Access Control List)
app.get('/api/google/calendar/acl/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.listAcl(req.user, req.params.calendarId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/calendar/acl/:calendarId/:ruleId', async function(req, res) {
  try {
    var data = await googleCalendar.getAcl(req.user, req.params.calendarId, req.params.ruleId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/google/calendar/acl/:calendarId', async function(req, res) {
  try {
    var data = await googleCalendar.insertAcl(req.user, req.params.calendarId, req.body || {});
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/google/calendar/acl/:calendarId/:ruleId', async function(req, res) {
  try {
    var data = await googleCalendar.patchAcl(req.user, req.params.calendarId, req.params.ruleId, req.body || {});
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/google/calendar/acl/:calendarId/:ruleId', async function(req, res) {
  try {
    var data = await googleCalendar.deleteAcl(req.user, req.params.calendarId, req.params.ruleId);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 8. Channels Resource
app.post('/api/google/calendar/channels/stop', async function(req, res) {
  try {
    var id = req.body && req.body.id;
    var resourceId = req.body && req.body.resourceId;
    if (!id || !resourceId) return res.status(400).json({ error: 'id and resourceId required' });
    var data = await googleCalendar.stopChannel(req.user, id, resourceId);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// Google Drive Sync (User Data Backup & Restore)
// ==========================================

app.get('/api/gdrive/status', async function(req, res) {
  try {
    var status = await gdriveSync.getStatus(req.user);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gdrive/file: fetch raw JSON data from user's Google Drive
app.get('/api/gdrive/file', async function(req, res) {
  try {
    var data = await gdriveSync.getDriveData(req.user);
    if (!data) {
      return res.status(404).json({ error: 'No RemindMe data file found in Google Drive' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gdrive/upload (or update): upload/update reminders in Google Drive
app.post('/api/gdrive/upload', async function(req, res) {
  try {
    var result = await gdriveSync.syncToDrive(req.user, reminderRepo, extRepo, googleRepo);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gdrive/update', async function(req, res) {
  try {
    var result = await gdriveSync.syncToDrive(req.user, reminderRepo, extRepo, googleRepo);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gdrive/restore: restore reminders from Google Drive
app.post('/api/gdrive/restore', async function(req, res) {
  try {
    var result = await gdriveSync.syncFromDrive(req.user, reminderRepo, extRepo, googleRepo);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gdrive/sync', async function(req, res) {
  try {
    var direction = req.query.direction || (req.body && req.body.direction);
    var result;
    if (direction === 'from' || direction === 'pull' || direction === 'download' || direction === 'restore') {
      result = await gdriveSync.syncFromDrive(req.user, reminderRepo, extRepo, googleRepo);
    } else {
      result = await gdriveSync.syncToDrive(req.user, reminderRepo, extRepo, googleRepo);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// User Authentication & Session
// ==========================================

app.get('/api/auth/me', function(req, res) {
  if (req.user) {
    res.json({
      authenticated: true,
      user: {
        userId: req.user.userId,
        email: req.user.email,
        name: req.user.name,
        picture: req.user.picture
      }
    });
  } else {
    res.json({ authenticated: false, user: null });
  }
});

app.post('/api/auth/logout', async function(req, res) {
  var sid = req.cookies.remindme_session;
  if (sid) {
    await sessionRepo.deleteSession(sid);
    res.clearCookie('remindme_session');
  }
  res.json({ logged_out: true });
});

app.get('/auth/google', async function(req, res) {
  try {
    var redirectUri = getRedirectUri(req);
    var authUrl = await googleAuth.createAuthUrl(redirectUri);
    res.redirect(authUrl);
  } catch (err) {
    res.redirect((APP_BASE_PATH || '') + '/?google=error&message=' + encodeURIComponent(err.message));
  }
});

// Fallback index.html
app.get('*', function(req, res) {
  res.sendFile(path.resolve(__dirname, 'public/index.html'));
});

// Initialize and start server
async function startServer() {
  await db.init();
  await daemon.start();

  server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      console.error('\n❌ Port ' + PORT + ' is already in use by another process.');
      console.error('To free port ' + PORT + ' on Linux, run:');
      console.error('   fuser -k ' + PORT + '/tcp\n');
      console.error('Or start on an alternate port:');
      console.error('   PORT=' + (PORT + 1) + ' npm start\n');
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, function() {
    var detectedUri = getRedirectUri();
    console.log('----------------------------------------------------');
    console.log('⏰ RemindMe Web App running at http://' + HOST + ':' + PORT);
    console.log('Google OAuth Redirect URI: ' + detectedUri);
    console.log('----------------------------------------------------');
  });
}

if (require.main === module) {
  startServer().catch(function(err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = {
  app: app,
  server: server,
  startServer: startServer
};
