/**
 * Google Calendar API v3 Complete Client for RemindMe Web App.
 * Implements all 8 resource types:
 * - Acl
 * - CalendarList
 * - Calendars
 * - Channels
 * - Colors
 * - Events
 * - Freebusy
 * - Settings
 *
 * Compatible with Node.js 12+.
 */

'use strict';

var querystring = require('querystring');
var httpClient = require('../utils/http-client');

var BASE_URL = 'https://www.googleapis.com/calendar/v3';

var GoogleCalendar = function(auth, configRepo) {
  this.auth = auth;
  this.configRepo = configRepo;
};

/**
 * Obtain a valid access token for the given user.
 */
GoogleCalendar.prototype.getAccessToken = async function(user) {
  if (user && user.accessToken) {
    return user.accessToken;
  }
  var token = await this.configRepo.get('google_access_token');
  if (token) return token;

  var refreshToken = (user && user.refreshToken) || (await this.configRepo.get('google_refresh_token'));
  if (refreshToken && this.auth) {
    var refreshed = await this.auth.refreshAccessToken(refreshToken);
    await this.configRepo.set('google_access_token', refreshed.accessToken);
    var expiry = Date.now() + (refreshed.expiresIn || 3600) * 1000;
    await this.configRepo.set('google_token_expiry', String(expiry));
    return refreshed.accessToken;
  }
  throw new Error('Google account not connected or access token expired');
};

/**
 * Refresh access token using refresh token.
 */
GoogleCalendar.prototype.refreshTokens = async function(user) {
  var refreshToken = (user && user.refreshToken) || (await this.configRepo.get('google_refresh_token'));
  if (!refreshToken || !this.auth) {
    throw new Error('Cannot refresh token: refresh token not available');
  }

  var refreshed = await this.auth.refreshAccessToken(refreshToken);
  if (user) {
    user.accessToken = refreshed.accessToken;
  }
  if (this.configRepo) {
    await this.configRepo.set('google_access_token', refreshed.accessToken);
    var expiry = Date.now() + (refreshed.expiresIn || 3600) * 1000;
    await this.configRepo.set('google_token_expiry', String(expiry));
  }
  return refreshed.accessToken;
};

/**
 * Wrapper to run any API call with automatic token refresh on 401.
 */
GoogleCalendar.prototype.withToken = async function(user, actionFn) {
  var self = this;
  var accessToken = await this.getAccessToken(user);
  try {
    return await actionFn(accessToken);
  } catch (err) {
    var isAuthError = err && err.message && (
      err.message.indexOf('401') !== -1 ||
      err.message.indexOf('Invalid Credentials') !== -1 ||
      err.message.indexOf('invalid_grant') !== -1
    );
    if (isAuthError && self.auth) {
      console.log('[GoogleCalendar] Token expired (401). Refreshing token and retrying...');
      try {
        var refreshedToken = await self.refreshTokens(user);
        if (refreshedToken) {
          return await actionFn(refreshedToken);
        }
      } catch (refErr) {
        console.warn('[GoogleCalendar] Token refresh failed:', refErr.message);
      }
    }
    throw err;
  }
};

function authHeader(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json'
  };
}

function buildQuery(params) {
  if (!params) return '';
  var clean = {};
  for (var k in params) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
      clean[k] = params[k];
    }
  }
  var qs = querystring.stringify(clean);
  return qs ? '?' + qs : '';
}

// ==========================================
// 1. Events Resource
// ==========================================

GoogleCalendar.prototype.listEvents = async function(user, calendarId, options) {
  calendarId = calendarId || 'primary';
  var qs = buildQuery(options);
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events' + qs;
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.getEvent = async function(user, calendarId, eventId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.createEvent = async function(user, calendarId, eventData, options) {
  calendarId = calendarId || 'primary';
  var opts = Object.assign({}, options || {});
  if (eventData && eventData.conferenceData && opts.conferenceDataVersion === undefined) {
    opts.conferenceDataVersion = 1;
  }
  var qs = buildQuery(opts);
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events' + qs;
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, eventData, authHeader(token));
  });
};

/**
 * Accept, decline, or mark tentative RSVP on a calendar event.
 */
GoogleCalendar.prototype.respondToEvent = async function(user, calendarId, eventId, responseStatus) {
  calendarId = calendarId || 'primary';
  responseStatus = responseStatus || 'accepted';
  var self = this;
  return await this.withToken(user, async function(token) {
    var userEmail = (user && user.email) || (await self.configRepo.get('google_account_email'));
    var getUrl = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
    var event = await httpClient.getJson(getUrl, authHeader(token));
    var attendees = (event && event.attendees) ? event.attendees.slice() : [];
    var matched = false;

    for (var i = 0; i < attendees.length; i++) {
      if (attendees[i].self || (userEmail && attendees[i].email && attendees[i].email.toLowerCase() === userEmail.toLowerCase())) {
        attendees[i].responseStatus = responseStatus;
        matched = true;
        break;
      }
    }

    if (!matched) {
      attendees.push({
        email: userEmail || 'me',
        responseStatus: responseStatus
      });
    }

    var patchUrl = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
    return await httpClient.patchJson(patchUrl, { attendees: attendees }, authHeader(token));
  });
};

/**
 * Schedule a Google Meet call / conference call.
 */
GoogleCalendar.prototype.scheduleCall = async function(user, options) {
  options = options || {};
  var title = options.title || options.summary || 'Scheduled Call';
  var description = options.description || '';
  var startTime = options.start_time || options.startTime;
  var endTime = options.end_time || options.endTime;

  if (!startTime) {
    throw new Error('Start time is required to schedule a call');
  }

  if (!endTime) {
    var startDt = new Date(startTime);
    var duration = parseInt(options.durationMinutes || 30, 10);
    var endDt = new Date(startDt.getTime() + duration * 60 * 1000);
    endTime = endDt.toISOString();
  }

  var attendeesList = [];
  if (options.attendees) {
    var rawList = Array.isArray(options.attendees) ? options.attendees : String(options.attendees).split(/[,;\s]+/);
    for (var a = 0; a < rawList.length; a++) {
      var email = rawList[a].trim();
      if (email && email.indexOf('@') > 0) {
        attendeesList.push({ email: email });
      }
    }
  }

  var requestId = 'call-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
  var eventData = {
    summary: title,
    description: description,
    start: {
      dateTime: typeof startTime === 'string' ? startTime : startTime.toISOString()
    },
    end: {
      dateTime: typeof endTime === 'string' ? endTime : endTime.toISOString()
    },
    conferenceData: {
      createRequest: {
        requestId: requestId,
        conferenceSolutionKey: {
          type: 'hangoutsMeet'
        }
      }
    }
  };

  if (attendeesList.length > 0) {
    eventData.attendees = attendeesList;
  }

  var calendarId = options.calendarId || 'primary';
  var createOpts = { conferenceDataVersion: 1 };
  if (options.sendUpdates) {
    createOpts.sendUpdates = options.sendUpdates;
  }

  return await this.createEvent(user, calendarId, eventData, createOpts);
};

/**
 * Mark a Google Task as completed (Accepted).
 */
GoogleCalendar.prototype.completeTask = async function(user, taskListId, taskId) {
  taskListId = taskListId || '@default';
  var url = 'https://tasks.googleapis.com/tasks/v1/lists/' + encodeURIComponent(taskListId) + '/tasks/' + encodeURIComponent(taskId);
  return await this.withToken(user, function(token) {
    return httpClient.patchJson(url, { status: 'completed' }, authHeader(token));
  });
};

/**
 * Delete a Google Task (Rejected / Dismissed).
 */
GoogleCalendar.prototype.deleteTask = async function(user, taskListId, taskId) {
  taskListId = taskListId || '@default';
  var url = 'https://tasks.googleapis.com/tasks/v1/lists/' + encodeURIComponent(taskListId) + '/tasks/' + encodeURIComponent(taskId);
  return await this.withToken(user, function(token) {
    return httpClient.deleteJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.importEvent = async function(user, calendarId, eventData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/import';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, eventData, authHeader(token));
  });
};

GoogleCalendar.prototype.quickAddEvent = async function(user, calendarId, text) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/quickAdd?text=' + encodeURIComponent(text);
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, {}, authHeader(token));
  });
};

GoogleCalendar.prototype.patchEvent = async function(user, calendarId, eventId, patchData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
  return await this.withToken(user, function(token) {
    return httpClient.patchJson(url, patchData, authHeader(token));
  });
};

GoogleCalendar.prototype.updateEvent = async function(user, calendarId, eventId, eventData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
  return await this.withToken(user, function(token) {
    return httpClient.putJson(url, eventData, authHeader(token));
  });
};

GoogleCalendar.prototype.deleteEvent = async function(user, calendarId, eventId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId);
  return await this.withToken(user, function(token) {
    return httpClient.deleteJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.getEventInstances = async function(user, calendarId, eventId, options) {
  calendarId = calendarId || 'primary';
  var qs = buildQuery(options);
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId) + '/instances' + qs;
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.moveEvent = async function(user, calendarId, eventId, destinationCalendarId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId) + '/move?destination=' + encodeURIComponent(destinationCalendarId);
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, {}, authHeader(token));
  });
};

GoogleCalendar.prototype.watchEvents = async function(user, calendarId, watchData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/events/watch';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, watchData, authHeader(token));
  });
};

// ==========================================
// 2. CalendarList Resource
// ==========================================

GoogleCalendar.prototype.listCalendarList = async function(user, options) {
  var qs = buildQuery(options);
  var url = BASE_URL + '/users/me/calendarList' + qs;
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.getCalendarListEntry = async function(user, calendarId) {
  var url = BASE_URL + '/users/me/calendarList/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.insertCalendarListEntry = async function(user, calendarData) {
  var url = BASE_URL + '/users/me/calendarList';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, calendarData, authHeader(token));
  });
};

GoogleCalendar.prototype.patchCalendarListEntry = async function(user, calendarId, patchData) {
  var url = BASE_URL + '/users/me/calendarList/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.patchJson(url, patchData, authHeader(token));
  });
};

GoogleCalendar.prototype.updateCalendarListEntry = async function(user, calendarId, calendarData) {
  var url = BASE_URL + '/users/me/calendarList/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.putJson(url, calendarData, authHeader(token));
  });
};

GoogleCalendar.prototype.deleteCalendarListEntry = async function(user, calendarId) {
  var url = BASE_URL + '/users/me/calendarList/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.deleteJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.watchCalendarList = async function(user, watchData) {
  var url = BASE_URL + '/users/me/calendarList/watch';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, watchData, authHeader(token));
  });
};

// ==========================================
// 3. Calendars Resource
// ==========================================

GoogleCalendar.prototype.getCalendar = async function(user, calendarId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.createCalendar = async function(user, calendarData) {
  var url = BASE_URL + '/calendars';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, calendarData, authHeader(token));
  });
};

GoogleCalendar.prototype.patchCalendar = async function(user, calendarId, patchData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.patchJson(url, patchData, authHeader(token));
  });
};

GoogleCalendar.prototype.updateCalendar = async function(user, calendarId, calendarData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.putJson(url, calendarData, authHeader(token));
  });
};

GoogleCalendar.prototype.clearCalendar = async function(user, calendarId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/clear';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, {}, authHeader(token));
  });
};

GoogleCalendar.prototype.deleteCalendar = async function(user, calendarId) {
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId);
  return await this.withToken(user, function(token) {
    return httpClient.deleteJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.transferCalendarOwnership = async function(user, calendarId, newDataOwner) {
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/transferOwnership?newDataOwner=' + encodeURIComponent(newDataOwner) + '&useAdminAccess=true';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, {}, authHeader(token));
  });
};

// ==========================================
// 4. Channels Resource
// ==========================================

GoogleCalendar.prototype.stopChannel = async function(user, id, resourceId) {
  var url = BASE_URL + '/channels/stop';
  var body = { id: id, resourceId: resourceId };
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, body, authHeader(token));
  });
};

// ==========================================
// 5. Colors Resource
// ==========================================

GoogleCalendar.prototype.getColors = async function(user) {
  var url = BASE_URL + '/colors';
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

// ==========================================
// 6. Freebusy Resource
// ==========================================

GoogleCalendar.prototype.queryFreeBusy = async function(user, options) {
  var url = BASE_URL + '/freeBusy';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, options, authHeader(token));
  });
};

// ==========================================
// 7. Settings Resource
// ==========================================

GoogleCalendar.prototype.listSettings = async function(user) {
  var url = BASE_URL + '/users/me/settings';
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.getSetting = async function(user, settingId) {
  var url = BASE_URL + '/users/me/settings/' + encodeURIComponent(settingId);
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.watchSettings = async function(user, watchData) {
  var url = BASE_URL + '/users/me/settings/watch';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, watchData, authHeader(token));
  });
};

// ==========================================
// 8. Acl Resource (Access Control List)
// ==========================================

GoogleCalendar.prototype.listAcl = async function(user, calendarId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/acl';
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.getAcl = async function(user, calendarId, ruleId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/acl/' + encodeURIComponent(ruleId);
  return await this.withToken(user, function(token) {
    return httpClient.getJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.insertAcl = async function(user, calendarId, aclData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/acl';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, aclData, authHeader(token));
  });
};

GoogleCalendar.prototype.patchAcl = async function(user, calendarId, ruleId, patchData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/acl/' + encodeURIComponent(ruleId);
  return await this.withToken(user, function(token) {
    return httpClient.patchJson(url, patchData, authHeader(token));
  });
};

GoogleCalendar.prototype.updateAcl = async function(user, calendarId, ruleId, aclData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/acl/' + encodeURIComponent(ruleId);
  return await this.withToken(user, function(token) {
    return httpClient.putJson(url, aclData, authHeader(token));
  });
};

GoogleCalendar.prototype.deleteAcl = async function(user, calendarId, ruleId) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/acl/' + encodeURIComponent(ruleId);
  return await this.withToken(user, function(token) {
    return httpClient.deleteJson(url, authHeader(token));
  });
};

GoogleCalendar.prototype.watchAcl = async function(user, calendarId, watchData) {
  calendarId = calendarId || 'primary';
  var url = BASE_URL + '/calendars/' + encodeURIComponent(calendarId) + '/acl/watch';
  return await this.withToken(user, function(token) {
    return httpClient.postJson(url, watchData, authHeader(token));
  });
};

module.exports = GoogleCalendar;

