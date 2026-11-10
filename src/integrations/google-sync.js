/**
 * Google Calendar and Tasks Synchronization for RemindMe Web App.
 * Compatible with Node.js 12+.
 */

'use strict';

var httpClient = require('../utils/http-client');
var timeUtils = require('../utils/time-utils');

var CALENDAR_LOOKBACK_DAYS = 7;
var CALENDAR_LOOKAHEAD_DAYS = 90;

function parseGoogleDateTime(val, allDay) {
  if (!val) return null;
  if (allDay) {
    var dateOnly = val.slice(0, 10);
    return timeUtils.strToDt(dateOnly + ' 09:00:00');
  }
  return timeUtils.strToDt(val);
}

function parseTaskDue(val) {
  if (!val) return null;
  var dateOnly = val.slice(0, 10);
  return timeUtils.strToDt(dateOnly + ' 09:00:00');
}

async function syncGoogle(googleRepo, auth, configRepo, user) {
  var creds = await auth.getClientCredentials();
  if (!creds) {
    throw new Error('Google credentials not configured');
  }

  // Get tokens from user session or configRepo
  var accessToken = (user && user.accessToken) || await configRepo.get('google_access_token');
  var refreshToken = (user && user.refreshToken) || await configRepo.get('google_refresh_token');
  var tokenExpiry = (user && user.tokenExpiry) || await configRepo.get('google_token_expiry');

  if (!accessToken && !refreshToken) {
    throw new Error('Google account not connected');
  }

  // Check if access token is expired or missing
  var nowMs = Date.now();
  if (!accessToken || (tokenExpiry && parseInt(tokenExpiry, 10) <= nowMs + 60000)) {
    if (refreshToken) {
      try {
        var refreshed = await auth.refreshAccessToken(refreshToken);
        accessToken = refreshed.accessToken;
        var newExpiry = nowMs + (refreshed.expiresIn || 3600) * 1000;
        await configRepo.set('google_access_token', accessToken);
        await configRepo.set('google_token_expiry', String(newExpiry));
      } catch (err) {
        throw new Error('Failed to refresh Google token: ' + err.message);
      }
    } else {
      throw new Error('Access token expired and no refresh token available');
    }
  }

  var now = timeUtils.localNow();
  var syncedAt = now;
  var calendarIds = [];
  var taskIds = [];

  var headers = {
    Authorization: 'Bearer ' + accessToken
  };

  try {
    // 1. Fetch Calendar Events
    var past = new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    var future = new Date(now.getTime() + CALENDAR_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

    var timeMin = past.toISOString();
    var timeMax = future.toISOString();

    var calUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + [
      'timeMin=' + encodeURIComponent(timeMin),
      'timeMax=' + encodeURIComponent(timeMax),
      'singleEvents=true',
      'orderBy=startTime',
      'maxResults=500'
    ].join('&');

    var calData = await httpClient.getJson(calUrl, headers);
    var calItems = calData.items || [];

    for (var i = 0; i < calItems.length; i++) {
      var item = calItems[i];
      var start = item.start || {};
      var end = item.end || {};
      var allDay = Boolean(start.date);
      var startRaw = start.dateTime || start.date;
      var endRaw = end.dateTime || end.date;
      if (!startRaw) continue;

      var eventId = 'cal:' + item.id;
      calendarIds.push(eventId);

      await googleRepo.upsertEvent({
        id: eventId,
        source: 'google_calendar',
        title: item.summary || '(No title)',
        description: item.description || '',
        start_time: parseGoogleDateTime(startRaw, allDay),
        end_time: parseGoogleDateTime(endRaw, allDay),
        all_day: allDay,
        status: item.status || 'confirmed',
        html_link: item.htmlLink || null,
        calendar_id: 'primary',
        synced_at: syncedAt
      });
    }

    // 2. Fetch Tasks
    try {
      var listUrl = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20';
      var listData = await httpClient.getJson(listUrl, headers);
      var taskLists = listData.items || [];

      for (var l = 0; l < taskLists.length; l++) {
        var tl = taskLists[l];
        var taskItemsUrl = 'https://tasks.googleapis.com/tasks/v1/lists/' + encodeURIComponent(tl.id) + '/tasks?showCompleted=false&maxResults=100';
        var tasksData = await httpClient.getJson(taskItemsUrl, headers);
        var tasks = tasksData.items || [];

        for (var t = 0; t < tasks.length; t++) {
          var task = tasks[t];
          var taskId = 'task:' + task.id;
          taskIds.push(taskId);

          var dueDt = parseTaskDue(task.due);
          await googleRepo.upsertEvent({
            id: taskId,
            source: 'google_tasks',
            title: task.title || '(Untitled task)',
            description: task.notes || '',
            start_time: dueDt,
            end_time: dueDt,
            all_day: Boolean(dueDt),
            status: task.status || 'needsAction',
            html_link: task.webViewLink || null,
            calendar_id: tl.id,
            synced_at: syncedAt
          });
        }
      }
    } catch (taskErr) {
      // Tasks API might not be enabled on the project; log and continue
      console.warn('Google Tasks sync warning:', taskErr.message);
    }

    // Clean up events no longer present in Google
    if (calendarIds.length > 0) {
      await googleRepo.deleteEventsNotIn('google_calendar', calendarIds);
    }
    if (taskIds.length > 0) {
      await googleRepo.deleteEventsNotIn('google_tasks', taskIds);
    }

    await googleRepo.updateSyncState({
      last_sync_at: syncedAt,
      clear_error: true
    });

    return {
      synced: true,
      calendar_events: calendarIds.length,
      tasks: taskIds.length,
      synced_at: timeUtils.dtToStr(syncedAt)
    };
  } catch (err) {
    await googleRepo.updateSyncState({
      last_error: err.message
    });
    throw err;
  }
}

module.exports = {
  syncGoogle: syncGoogle
};

