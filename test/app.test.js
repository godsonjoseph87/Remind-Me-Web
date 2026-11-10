/**
 * Comprehensive Integration & Unit Test Suite for RemindMe Web App.
 * Compatible with Node.js 12+.
 */

'use strict';

var assert = require('assert');
var http = require('http');
var path = require('path');
var fs = require('fs');

var timeUtils = require('../src/utils/time-utils');
var databaseModule = require('../src/db/database');
var scheduler = require('../src/scheduler/scheduler');
var soundGenerator = require('../src/notifications/sound-generator');
var urgentNudges = require('../src/scheduler/urgent-nudges');
var externalReminders = require('../src/scheduler/external-reminders');
var ReminderDaemon = require('../src/daemon/reminder-daemon');

function httpRequest(port, method, reqPath, body) {
  return new Promise(function(resolve, reject) {
    var dataStr = body ? JSON.stringify(body) : null;
    var req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: reqPath,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': dataStr ? Buffer.byteLength(dataStr) : 0
      }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting RemindMe Web App Test Suite ---');

  // Test 1: Time Utils
  console.log('Test 1: Time Utils...');
  var now = timeUtils.localNow();
  var dtStr = timeUtils.dtToStr(now);
  assert(dtStr && dtStr.length === 19, 'dtToStr should return YYYY-MM-DD HH:mm:ss');
  var parsedDt = timeUtils.strToDt(dtStr);
  assert(parsedDt && parsedDt.getFullYear() === now.getFullYear(), 'strToDt should parse date');
  var tp = timeUtils.parseTimeValue('15:45:30');
  assert(tp && tp.hour === 15 && tp.minute === 45 && tp.second === 30, 'parseTimeValue');
  assert.strictEqual(timeUtils.formatTime12('15:45:00'), '3:45 PM', 'formatTime12');
  var days = timeUtils.parseDaysOfWeek('MON,WED,FRI');
  assert(days.has(1) && days.has(3) && days.has(5), 'parseDaysOfWeek');
  console.log('✓ Time Utils passed.');

  // Test 2: Sound Generator & WAV Synthesis
  console.log('Test 2: Sound Generator & WAV Synthesis...');
  var tones = soundGenerator.listTones();
  assert(tones.length === 8, 'Should have 8 tones');
  var toneIds = ['chime', 'bell', 'gentle', 'urgent', 'digital', 'zen', 'birds'];
  for (var i = 0; i < toneIds.length; i++) {
    var tid = toneIds[i];
    var samples = soundGenerator.generateToneSamples(tid);
    assert(samples && samples.length > 0, 'Tone samples should exist for ' + tid);
    var wav = soundGenerator.createWavBuffer(samples);
    assert(wav && wav.length > 44, 'WAV buffer should have header and PCM data for ' + tid);
    assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF', 'WAV RIFF header');
    assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE', 'WAV WAVE header');
  }
  console.log('✓ Sound Generator passed.');

  // Test 3: Database & Repositories
  console.log('Test 3: Database & Repositories...');
  var testDbPath = path.resolve(__dirname, 'test-reminders.db');
  process.env.DATABASE_PATH = testDbPath;
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  var db = new databaseModule.Database(testDbPath);
  await db.init();
  var repo = new databaseModule.ReminderRepository(db);

  // Create One-time reminder
  var tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  var r1 = await repo.create({
    title: 'Doctor appointment',
    description: 'Bring medical insurance',
    type: 'ONE_TIME',
    trigger_time: tomorrow,
    tone: 'bell',
    priority: 'high'
  });
  assert(r1 && r1.id, 'Created reminder should have id');
  assert.strictEqual(r1.title, 'Doctor appointment');
  assert.strictEqual(r1.status, 'PENDING');

  // Create Interval reminder
  var r2 = await repo.create({
    title: 'Drink water',
    type: 'INTERVAL_MINUTES',
    interval_minutes: 15,
    tone: 'chime'
  });
  assert.strictEqual(r2.interval_minutes, 15);

  // Create Daily reminder with active window
  var r3 = await repo.create({
    title: 'Daily Standup',
    type: 'DAILY',
    trigger_time: '09:30:00',
    active_from: '08:00:00',
    active_until: '18:00:00',
    priority: 'urgent'
  });
  assert.strictEqual(r3.type, 'DAILY');
  assert.strictEqual(r3.active_from, '08:00:00');

  // List all
  var allList = await repo.listAll();
  assert(allList.length >= 3, 'Should list at least 3 reminders');

  // Snooze
  var snoozed = await repo.snooze(r1.id, 10);
  assert.strictEqual(snoozed.status, 'SNOOZED');
  assert(snoozed.snooze_until != null, 'snooze_until should be set');

  // Recover snoozed test
  var recoveredCount = await repo.recoverSnoozed();
  assert(typeof recoveredCount === 'number', 'recoverSnoozed returns number');

  // Dismiss
  var dismissed = await repo.dismiss(r1.id);
  assert.strictEqual(dismissed.status, 'DISMISSED');

  // Reactivate
  var reactivated = await repo.reactivate(r1.id);
  assert.strictEqual(reactivated.status, 'PENDING');

  // Audit Logs
  var logs = await repo.logsForReminder(r1.id);
  assert(logs.length >= 2, 'Should have logs for snooze and dismiss');

  console.log('✓ Database & Repositories passed.');

  // Test 4: Scheduler Calculations
  console.log('Test 4: Scheduler Calculations...');
  var nf1 = scheduler.nextFireTime(r2, new Date());
  assert(nf1 instanceof Date, 'Interval reminder should have a next fire Date');

  var occurrences = scheduler.occurrencesInRange(r2, new Date(), new Date(Date.now() + 60 * 60 * 1000));
  assert(occurrences.length >= 3, 'Interval 15m should have at least 3 occurrences in 1 hour');
  console.log('✓ Scheduler Calculations passed.');

  // Test 5: Full Express Server & REST API Endpoints
  console.log('Test 5: Full Express Server & REST API Endpoints...');
  var serverModule = require('../server');
  var testPort = 3199;
  var appServer = http.createServer(serverModule.app);

  await new Promise(function(resolve) {
    appServer.listen(testPort, '127.0.0.1', resolve);
  });

  try {
    // GET /api/meta
    var metaRes = await httpRequest(testPort, 'GET', '/api/meta');
    assert.strictEqual(metaRes.status, 200);
    assert(metaRes.body.tones.length === 8, 'Tones in meta');
    assert(metaRes.body.types.length === 5, 'Types in meta');

    // GET /api/stats
    var statsRes = await httpRequest(testPort, 'GET', '/api/stats');
    assert.strictEqual(statsRes.status, 200);
    assert(typeof statsRes.body.total === 'number', 'Stats total is number');

    // POST /api/reminders
    var createRes = await httpRequest(testPort, 'POST', '/api/reminders', {
      title: 'API Test Reminder',
      description: 'Testing via REST API',
      type: 'INTERVAL_MINUTES',
      interval_minutes: 20,
      priority: 'high',
      tone: 'chime'
    });
    assert.strictEqual(createRes.status, 201);
    assert(createRes.body.id, 'API created reminder has ID');
    var createdId = createRes.body.id;

    // GET /api/reminders/:id
    var getRes = await httpRequest(testPort, 'GET', '/api/reminders/' + createdId);
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.body.reminder.title, 'API Test Reminder');

    // POST /api/reminders/:id/snooze
    var snoozeRes = await httpRequest(testPort, 'POST', '/api/reminders/' + createdId + '/snooze', { minutes: 15 });
    assert.strictEqual(snoozeRes.status, 200);
    assert.strictEqual(snoozeRes.body.status, 'SNOOZED');

    // POST /api/reminders/:id/dismiss
    var dismissRes = await httpRequest(testPort, 'POST', '/api/reminders/' + createdId + '/dismiss');
    assert.strictEqual(dismissRes.status, 200);
    assert.strictEqual(dismissRes.body.status, 'DISMISSED');

    // POST /api/reminders/:id/reactivate
    var reactivateRes = await httpRequest(testPort, 'POST', '/api/reminders/' + createdId + '/reactivate');
    assert.strictEqual(reactivateRes.status, 200);
    assert.strictEqual(reactivateRes.body.status, 'PENDING');

    // POST /api/reminders/:id/test
    var testFireRes = await httpRequest(testPort, 'POST', '/api/reminders/' + createdId + '/test');
    assert.strictEqual(testFireRes.status, 200);
    assert.strictEqual(testFireRes.body.sent, true);

    // GET /api/calendar
    var calRes = await httpRequest(testPort, 'GET', '/api/calendar?year=2026&month=11');
    assert.strictEqual(calRes.status, 200);
    assert.strictEqual(calRes.body.year, 2026);
    assert.strictEqual(calRes.body.month, 11);

    // GET /api/tones/chime/wav (Check audio streaming)
    var wavRes = await httpRequest(testPort, 'GET', '/api/tones/chime/wav');
    assert.strictEqual(wavRes.status, 200);
    assert(wavRes.headers['content-type'] === 'audio/wav', 'Content-Type should be audio/wav');

    // GET /api/google/status
    var gStatusRes = await httpRequest(testPort, 'GET', '/api/google/status');
    assert.strictEqual(gStatusRes.status, 200);
    assert('signin_ready' in gStatusRes.body, 'signin_ready in Google status');

    // GET /api/google/setup-guide
    var guideRes = await httpRequest(testPort, 'GET', '/api/google/setup-guide');
    assert.strictEqual(guideRes.status, 200);
    assert(guideRes.body.redirect_uri, 'Setup guide must return redirect_uri');
    assert(Array.isArray(guideRes.body.steps), 'Setup guide must return steps array');
    assert(Array.isArray(guideRes.body.recommended_uris), 'Setup guide must return recommended_uris array');

    // POST /api/google/credentials
    var credsSaveRes = await httpRequest(testPort, 'POST', '/api/google/credentials', {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret-key'
    });
    assert.strictEqual(credsSaveRes.status, 200);
    assert.strictEqual(credsSaveRes.body.saved, true);

    // GET /api/gdrive/status
    var gdriveRes = await httpRequest(testPort, 'GET', '/api/gdrive/status');
    assert.strictEqual(gdriveRes.status, 200);
    assert('file_name' in gdriveRes.body, 'file_name in Google Drive status');
    assert.strictEqual(gdriveRes.body.file_name, 'remindme_data.json');

    // POST /api/gdrive/upload (unauthenticated test)
    var gdriveUploadRes = await httpRequest(testPort, 'POST', '/api/gdrive/upload');
    assert.strictEqual(gdriveUploadRes.status, 500); // Expect error because no google tokens in test db
    assert(gdriveUploadRes.body.error, 'Should return error when unauthenticated');

    // Google Calendar API v3 routes tests
    var GoogleCalendar = require('../src/integrations/google-calendar');
    var gcal = new GoogleCalendar();
    assert(typeof gcal.listEvents === 'function', 'listEvents function');
    assert(typeof gcal.createEvent === 'function', 'createEvent function');
    assert(typeof gcal.quickAddEvent === 'function', 'quickAddEvent function');
    assert(typeof gcal.listCalendarList === 'function', 'listCalendarList function');
    assert(typeof gcal.createCalendar === 'function', 'createCalendar function');
    assert(typeof gcal.getColors === 'function', 'getColors function');
    assert(typeof gcal.queryFreeBusy === 'function', 'queryFreeBusy function');
    assert(typeof gcal.listSettings === 'function', 'listSettings function');
    assert(typeof gcal.listAcl === 'function', 'listAcl function');
    assert(typeof gcal.stopChannel === 'function', 'stopChannel function');
    assert(typeof gcal.scheduleCall === 'function', 'scheduleCall function');
    assert(typeof gcal.respondToEvent === 'function', 'respondToEvent function');
    assert(typeof gcal.completeTask === 'function', 'completeTask function');
    assert(typeof gcal.deleteTask === 'function', 'deleteTask function');

    // POST /api/google/calls/schedule validation
    var callRes = await httpRequest(testPort, 'POST', '/api/google/calls/schedule', {});
    assert.strictEqual(callRes.status, 400);

    // POST /api/google/items/:id/accept validation
    var acceptRes = await httpRequest(testPort, 'POST', '/api/google/items/nonexistent/accept', {});
    assert.strictEqual(acceptRes.status, 404);

    // POST /api/google/items/:id/reject validation
    var rejectRes = await httpRequest(testPort, 'POST', '/api/google/items/nonexistent/reject', {});
    assert.strictEqual(rejectRes.status, 404);

    // GET /api/reminders?source=google
    var gRemindersRes = await httpRequest(testPort, 'GET', '/api/reminders?source=google');
    assert.strictEqual(gRemindersRes.status, 200);
    assert(Array.isArray(gRemindersRes.body), 'Google reminders is array');

    // GET /api/auth/me
    var authMeRes = await httpRequest(testPort, 'GET', '/api/auth/me');
    assert.strictEqual(authMeRes.status, 200);
    assert.strictEqual(authMeRes.body.authenticated, false);

    // DELETE /api/reminders/:id
    var delRes = await httpRequest(testPort, 'DELETE', '/api/reminders/' + createdId);
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.deleted, true);

    console.log('✓ Full Express Server & REST API Endpoints passed.');

    // Test 6: Desktop notification fallback should not crash when notify-send is unavailable
    console.log('Test 6: Desktop Notification Fallback...');
    var daemon = new ReminderDaemon({
      reminderRepo: { listActive: async function() { return []; }, recoverSnoozed: async function() { return 0; }, logAction: async function() {} },
      googleRepo: null,
      extRepo: { recoverSnoozes: async function() { return 0; }, getSettings: async function() { return {}; } },
      urgentAckRepo: null,
      sseClients: new Set()
    });
    assert.doesNotThrow(function() {
      daemon.fireDesktopNotification('Test reminder', 'Hello', 'normal');
    }, 'Desktop notifications should fail silently when notify-send is unavailable');
    console.log('✓ Desktop notification fallback passed.');
  } finally {
    await new Promise(function(resolve) {
      appServer.close(resolve);
    });
    await db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    var testSecret = path.resolve(__dirname, '../data/google/client_secret.json');
    if (fs.existsSync(testSecret)) fs.unlinkSync(testSecret);
  }

  console.log('------------------------------------------------');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! (100% SUCCESS)');
  console.log('------------------------------------------------');
}

runTests().catch(function(err) {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
