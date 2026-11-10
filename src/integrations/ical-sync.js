/**
 * iCal Calendar Feed Synchronization for RemindMe Web App.
 * Compatible with Node.js 12+.
 */

'use strict';

var httpClient = require('../utils/http-client');
var timeUtils = require('../utils/time-utils');

function validateFeedUrl(inputUrl) {
  if (!inputUrl) throw new Error('URL is required');
  var trimmed = String(inputUrl).trim();
  if (trimmed.indexOf('webcal://') === 0) {
    trimmed = 'https://' + trimmed.slice(9);
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Feed URL must start with http:// or https://');
  }
  return trimmed;
}

function unfoldIcal(rawText) {
  var lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var unfolded = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if ((line.charAt(0) === ' ' || line.charAt(0) === '\t') && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function parseIcalDateTime(val) {
  if (!val) return { dt: null, allDay: false };
  // Value might have parameters e.g. DTSTART;VALUE=DATE:20260615 or DTSTART;TZID=...:20260615T143000
  var clean = val;
  if (clean.indexOf(':') !== -1) {
    clean = clean.split(':').slice(1).join(':');
  }
  clean = clean.trim();

  // All-day: YYYYMMDD
  if (/^\d{8}$/.test(clean)) {
    var y = parseInt(clean.slice(0, 4), 10);
    var m = parseInt(clean.slice(4, 6), 10) - 1;
    var d = parseInt(clean.slice(6, 8), 10);
    return { dt: new Date(y, m, d, 9, 0, 0), allDay: true };
  }

  // Date-Time: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  var isUtc = /Z$/i.test(clean);
  var numStr = clean.replace(/[^0-9]/g, '');
  if (numStr.length >= 14) {
    var yr = parseInt(numStr.slice(0, 4), 10);
    var mo = parseInt(numStr.slice(4, 6), 10) - 1;
    var dy = parseInt(numStr.slice(6, 8), 10);
    var hr = parseInt(numStr.slice(8, 10), 10);
    var mi = parseInt(numStr.slice(10, 12), 10);
    var se = parseInt(numStr.slice(12, 14), 10);

    if (isUtc) {
      return { dt: new Date(Date.UTC(yr, mo, dy, hr, mi, se)), allDay: false };
    }
    return { dt: new Date(yr, mo, dy, hr, mi, se), allDay: false };
  }

  return { dt: timeUtils.strToDt(clean), allDay: false };
}

function parseIcalEvents(rawText, feedId) {
  var lines = unfoldIcal(rawText);
  var events = [];
  var inEvent = false;
  var current = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current && current.uid && current.start_time) {
        events.push(current);
      }
      inEvent = false;
      current = null;
      continue;
    }
    if (!inEvent || !current) continue;

    var colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    var keyPart = line.slice(0, colonIdx).toUpperCase();
    var val = line.slice(colonIdx + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');

    var keyName = keyPart.split(';')[0];

    if (keyName === 'UID') {
      current.uid = 'ical:' + feedId + ':' + val;
    } else if (keyName === 'SUMMARY') {
      current.title = val;
    } else if (keyName === 'DESCRIPTION') {
      current.description = val;
    } else if (keyName === 'DTSTART') {
      var parsedStart = parseIcalDateTime(line);
      current.start_time = parsedStart.dt;
      current.all_day = parsedStart.allDay;
    } else if (keyName === 'DTEND') {
      var parsedEnd = parseIcalDateTime(line);
      current.end_time = parsedEnd.dt;
    } else if (keyName === 'STATUS') {
      current.status = val;
    } else if (keyName === 'URL') {
      current.html_link = val;
    }
  }

  return events;
}

async function syncIcalFeed(feedId, feedUrl, googleRepo) {
  var validUrl = validateFeedUrl(feedUrl);
  var icalText;
  try {
    icalText = await httpClient.getText(validUrl);
  } catch (err) {
    await googleRepo.updateFeed(feedId, { last_error: err.message });
    throw new Error('Failed to fetch calendar link: ' + err.message);
  }

  var events = parseIcalEvents(icalText, feedId);
  var syncedAt = timeUtils.localNow();
  var keepIds = [];

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    keepIds.push(ev.uid);
    await googleRepo.upsertEvent({
      id: ev.uid,
      source: 'ical',
      title: ev.title || '(No title)',
      description: ev.description || '',
      start_time: ev.start_time,
      end_time: ev.end_time,
      all_day: ev.all_day,
      status: ev.status || 'CONFIRMED',
      html_link: ev.html_link || null,
      calendar_id: String(feedId),
      synced_at: syncedAt
    });
  }

  // Remove stale ical events for this feed
  await googleRepo.deleteEventsNotIn('ical', keepIds);

  await googleRepo.updateFeed(feedId, {
    last_sync_at: syncedAt,
    last_error: null
  });

  return {
    synced: true,
    feed_id: feedId,
    events_count: events.length
  };
}

async function syncAllFeeds(googleRepo) {
  var feeds = await googleRepo.listFeeds();
  var results = [];
  for (var i = 0; i < feeds.length; i++) {
    var f = feeds[i];
    try {
      var res = await syncIcalFeed(f.id, f.url, googleRepo);
      results.push(res);
    } catch (e) {
      results.push({ feed_id: f.id, error: e.message });
    }
  }
  return results;
}

module.exports = {
  validateFeedUrl: validateFeedUrl,
  syncIcalFeed: syncIcalFeed,
  syncAllFeeds: syncAllFeeds
};

