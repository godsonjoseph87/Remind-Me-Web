/**
 * Google Drive Synchronization for RemindMe Web App.
 * Automatically backs up and restores reminders, settings, and feeds to/from the user's Google Drive.
 * Compatible with Node.js 12+.
 */

'use strict';

var httpClient = require('../utils/http-client');
var timeUtils = require('../utils/time-utils');

var GDRIVE_FILE_NAME = 'remindme_data.json';
var DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
var DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

var GDriveSync = function(auth, configRepo) {
  this.auth = auth;
  this.configRepo = configRepo;
};

/**
 * Get a valid access token for the given user/session.
 */
GDriveSync.prototype.getAccessToken = async function(user) {
  if (user && user.accessToken) {
    return user.accessToken;
  }
  var token = await this.configRepo.get('google_access_token');
  if (token) return token;

  // Try refreshing
  var refreshToken = (user && user.refreshToken) || (await this.configRepo.get('google_refresh_token'));
  if (refreshToken && this.auth) {
    var refreshed = await this.auth.refreshAccessToken(refreshToken);
    await this.configRepo.set('google_access_token', refreshed.accessToken);
    var expiry = Date.now() + (refreshed.expiresIn || 3600) * 1000;
    await this.configRepo.set('google_token_expiry', String(expiry));
    return refreshed.accessToken;
  }
  throw new Error('User not authenticated with Google');
};

/**
 * Refresh tokens and save them.
 */
GDriveSync.prototype.refreshTokens = async function(user) {
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
 * Helper to execute an action with automatic token refresh on 401.
 */
GDriveSync.prototype.withToken = async function(user, actionFn) {
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
      console.log('[GDrive] Access token expired or invalid (401). Refreshing token...');
      try {
        var refreshedToken = await self.refreshTokens(user);
        if (refreshedToken) {
          return await actionFn(refreshedToken);
        }
      } catch (refreshErr) {
        console.warn('[GDrive] Token refresh attempt failed:', refreshErr.message);
      }
    }
    throw err;
  }
};

/**
 * Locate the remindme_data.json file in user's Google Drive.
 */
GDriveSync.prototype.findDriveFile = async function(accessToken) {
  var q = "name = '" + GDRIVE_FILE_NAME + "' and trashed = false";
  var searchUrl = DRIVE_FILES_URL + '?q=' + encodeURIComponent(q) +
    '&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime%20desc&spaces=drive';

  var data = await httpClient.getJson(searchUrl, {
    Authorization: 'Bearer ' + accessToken
  });

  if (data.files && data.files.length > 0) {
    return data.files[0];
  }
  return null;
};

/**
 * Download and parse remindme_data.json from Google Drive (GET API).
 */
GDriveSync.prototype.downloadDriveFile = async function(accessToken, fileId) {
  var downloadUrl = DRIVE_FILES_URL + '/' + encodeURIComponent(fileId) + '?alt=media';
  var raw = await httpClient.getText(downloadUrl, {
    Authorization: 'Bearer ' + accessToken
  });

  if (!raw || !raw.trim()) {
    return { reminders: [], settings: null, calendar_feeds: [] };
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Failed to parse Google Drive data file: ' + err.message);
  }
};

/**
 * Create a new remindme_data.json file in user's Google Drive (UPLOAD API).
 * Uses Google Drive API v3 multipart upload with 2-step fallback.
 */
GDriveSync.prototype.createDriveFile = async function(accessToken, jsonData) {
  var boundary = '-------RemindMeDriveBoundary' + Date.now();
  var jsonStr = JSON.stringify(jsonData, null, 2);

  var metadata = JSON.stringify({
    name: GDRIVE_FILE_NAME,
    mimeType: 'application/json',
    description: 'RemindMe application data & reminders backup'
  });

  var delimiter = '\r\n--' + boundary + '\r\n';
  var closeDelimiter = '\r\n--' + boundary + '--';

  var multipartBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata +
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    jsonStr +
    closeDelimiter;

  var uploadUrl = DRIVE_UPLOAD_URL + '?uploadType=multipart';

  var res = await httpClient.request(
    {
      url: uploadUrl,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary,
        Accept: 'application/json'
      }
    },
    multipartBody
  );

  if (res.statusCode >= 200 && res.statusCode < 300) {
    try {
      var parsed = JSON.parse(res.body);
      return parsed.id;
    } catch (e) {}
  }

  // Fallback to 2-step create & patch if multipart was rejected
  console.warn('[GDrive] Multipart upload status ' + res.statusCode + ', falling back to 2-step upload...');
  var file = await httpClient.postJson(
    DRIVE_FILES_URL,
    {
      name: GDRIVE_FILE_NAME,
      mimeType: 'application/json',
      description: 'RemindMe application data & reminders backup'
    },
    {
      Authorization: 'Bearer ' + accessToken
    }
  );

  var patchUrl = DRIVE_UPLOAD_URL + '/' + encodeURIComponent(file.id) + '?uploadType=media';
  var patchRes = await httpClient.request(
    {
      url: patchUrl,
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    },
    jsonStr
  );

  if (patchRes.statusCode >= 300) {
    throw new Error('Google Drive upload media failed (' + patchRes.statusCode + '): ' + patchRes.body.slice(0, 200));
  }

  return file.id;
};

/**
 * Update an existing remindme_data.json file in user's Google Drive (UPDATE API).
 */
GDriveSync.prototype.updateDriveFile = async function(accessToken, fileId, jsonData) {
  var uploadUrl = DRIVE_UPLOAD_URL + '/' + encodeURIComponent(fileId) + '?uploadType=media';
  var jsonStr = JSON.stringify(jsonData, null, 2);

  var res = await httpClient.request(
    {
      url: uploadUrl,
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    },
    jsonStr
  );

  if (res.statusCode === 404) {
    console.warn('[GDrive] File ID ' + fileId + ' not found (404). Re-creating file in Google Drive...');
    return await this.createDriveFile(accessToken, jsonData);
  }

  if (res.statusCode >= 300) {
    throw new Error('Google Drive update failed (' + res.statusCode + '): ' + res.body.slice(0, 200));
  }

  return fileId;
};

/**
 * Fetch the latest backup data directly from Google Drive without restoring (GET API).
 */
GDriveSync.prototype.getDriveData = async function(user) {
  var self = this;
  return await this.withToken(user, async function(accessToken) {
    var file = await self.findDriveFile(accessToken);
    if (!file) return null;
    return await self.downloadDriveFile(accessToken, file.id);
  });
};

/**
 * Restore / Sync from Google Drive into the local database for this user.
 */
GDriveSync.prototype.syncFromDrive = async function(user, reminderRepo, extRepo, googleRepo) {
  var self = this;
  return await this.withToken(user, async function(accessToken) {
    var file = await self.findDriveFile(accessToken);

    if (!file) {
      console.log('[GDrive] No existing backup found in Google Drive. Performing initial upload...');
      return await self.syncToDrive(user, reminderRepo, extRepo, googleRepo);
    }

    console.log('[GDrive] Found backup in Google Drive (ID: ' + file.id + '). Restoring data...');
    var backup = await self.downloadDriveFile(accessToken, file.id);

    var userId = user ? (user.userId || user.email) : null;
    var restoredCount = 0;

    if (Array.isArray(backup.reminders)) {
      for (var i = 0; i < backup.reminders.length; i++) {
        var item = backup.reminders[i];
        var existing = await reminderRepo.get(item.id);
        if (existing) {
          await reminderRepo.update(item.id, {
            title: item.title,
            description: item.description,
            type: item.type,
            trigger_time: item.trigger_time ? timeUtils.strToDt(item.trigger_time) : null,
            interval_minutes: item.interval_minutes,
            days_of_week: item.days_of_week,
            status: item.status,
            snooze_until: item.snooze_until ? timeUtils.strToDt(item.snooze_until) : null,
            last_fired_at: item.last_fired_at ? timeUtils.strToDt(item.last_fired_at) : null,
            tone: item.tone,
            priority: item.priority,
            color: item.color,
            all_day: Boolean(item.all_day),
            active_from: item.active_from,
            active_until: item.active_until,
            sort_order: item.sort_order
          });
        } else {
          await reminderRepo.create({
            id: item.id,
            title: item.title,
            description: item.description,
            type: item.type,
            trigger_time: item.trigger_time ? timeUtils.strToDt(item.trigger_time) : null,
            interval_minutes: item.interval_minutes,
            days_of_week: item.days_of_week,
            status: item.status || 'PENDING',
            tone: item.tone || 'chime',
            priority: item.priority || 'normal',
            color: item.color || '#6366f1',
            all_day: Boolean(item.all_day),
            active_from: item.active_from,
            active_until: item.active_until,
            sort_order: item.sort_order != null ? item.sort_order : 0,
            user_id: userId
          });
        }
        restoredCount++;
      }
    }

    // Restore settings if present
    if (backup.settings && extRepo) {
      await extRepo.updateSettings(backup.settings);
    }

    // Restore calendar feeds if present
    if (Array.isArray(backup.calendar_feeds) && googleRepo) {
      var existingFeeds = await googleRepo.listFeeds();
      var existingUrls = new Set(existingFeeds.map(function(f) { return f.url; }));
      for (var f = 0; f < backup.calendar_feeds.length; f++) {
        var feed = backup.calendar_feeds[f];
        if (feed && feed.url && !existingUrls.has(feed.url)) {
          try {
            await googleRepo.addFeed(feed.url, feed.label || 'Google Calendar');
          } catch (e) {}
        }
      }
    }

    var nowStr = timeUtils.dtToStr(timeUtils.localNow());
    await self.configRepo.set('gdrive_last_synced_at', nowStr);
    await self.configRepo.set('gdrive_file_id', file.id);

    console.log('[GDrive] Successfully restored ' + restoredCount + ' reminder(s) from Google Drive.');

    return {
      synced: true,
      action: 'restored',
      file_id: file.id,
      reminders_count: restoredCount,
      synced_at: nowStr
    };
  });
};

/**
 * Backup / Save user reminders to their Google Drive.
 */
GDriveSync.prototype.syncToDrive = async function(user, reminderRepo, extRepo, googleRepo) {
  var self = this;
  return await this.withToken(user, async function(accessToken) {
    var userId = user ? (user.userId || user.email) : null;

    var reminders = await reminderRepo.listAll({
      includeDismissed: true,
      userId: userId
    });

    var settings = extRepo ? await extRepo.getSettings() : null;
    var feeds = googleRepo ? await googleRepo.listFeeds() : [];

    var payload = {
      version: 1,
      app: 'RemindMe',
      user_email: user ? user.email : 'guest',
      last_synced_at: timeUtils.dtToStr(timeUtils.localNow()),
      reminders: reminders,
      settings: settings,
      calendar_feeds: feeds.map(function(f) { return { url: f.url, label: f.label }; })
    };

    var file = await self.findDriveFile(accessToken);
    var fileId;

    if (file) {
      fileId = await self.updateDriveFile(accessToken, file.id, payload);
      console.log('[GDrive] Updated existing backup in Google Drive (ID: ' + fileId + ')');
    } else {
      fileId = await self.createDriveFile(accessToken, payload);
      console.log('[GDrive] Created new backup in Google Drive (ID: ' + fileId + ')');
    }

    var nowStr = timeUtils.dtToStr(timeUtils.localNow());
    await self.configRepo.set('gdrive_last_synced_at', nowStr);
    await self.configRepo.set('gdrive_file_id', fileId);

    return {
      synced: true,
      action: file ? 'updated' : 'created',
      file_id: fileId,
      reminders_count: reminders.length,
      synced_at: nowStr
    };
  });
};

/**
 * Get current Google Drive sync status.
 */
GDriveSync.prototype.getStatus = async function(user) {
  var lastSyncedAt = await this.configRepo.get('gdrive_last_synced_at');
  var fileId = await this.configRepo.get('gdrive_file_id');
  var hasToken = false;
  try {
    var t = await this.getAccessToken(user);
    hasToken = Boolean(t);
  } catch (e) {}

  return {
    enabled: hasToken,
    connected: hasToken,
    last_synced_at: lastSyncedAt,
    file_id: fileId,
    file_name: GDRIVE_FILE_NAME
  };
};

module.exports = GDriveSync;
