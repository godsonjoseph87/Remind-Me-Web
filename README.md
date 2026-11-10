# RemindMe Web — Cloud-Ready Online Reminder Application

A modern, full-fledged Node.js web application for scheduling reminders with **Google Login**, **Google Drive Cloud Sync & Persistence**, **Google Calendar & Tasks synchronization**, **Browser Notifications**, **Interactive In-App Alert Popups**, and **Web Audio API Sound Synthesis**.

**Zero Installation Required**: Hosted online so anyone with the link can use it from any device or browser.

---

## Highlights & Features

### ☁️ Google Drive Auto-Sync (Cloud Persistence Across Logins)
- **Automatic Cloud Backup**: Events, tasks, and reminders created in the application (other than Google Calendar) are automatically backed up to the user's **Google Drive** as `remindme_data.json`.
- **Seamless Re-Sync on Login**: The next time a user logs in (from any device, mobile phone, browser, or if the server restarts), all reminders, intervals, active windows, tones, priorities, and settings are immediately re-synced from Google Drive without any issue.
- **Auto-Sync on Changes**: Every reminder creation, edit, snooze, dismissal, reactivate, or reorder automatically syncs to Google Drive.
- **Manual Sync**: Instant "Drive Sync" button in the top navigation bar.

### 🔐 Google Login & Multi-User Support
- **One-Click Google Sign-In**: Sign in using Google OAuth 2.0 / OpenID Connect.
- **User Profile in Navigation**: Displays Google avatar, account name, and email with one-click logout.
- **Session Persistence**: HTTP-only session cookies and SQLite session repository.
- **Calendar & Tasks Sync**: Automatically pulls Google Calendar events and Google Tasks into the reminder timeline.

### ⏰ Complete Interval & Schedule Functionality
- **Reminder Types**:
  - `ONE_TIME`: Set a specific date and time.
  - `DAILY`: Repeat daily at specified time (repeats until dismissed).
  - `HOURLY`: Repeat every hour on the hour.
  - `INTERVAL_MINUTES`: Custom interval (e.g. every 10 min, 30 min, 45 min).
  - `WEEKLY`: Repeat on selected days of the week (e.g. Mon, Wed, Fri) at given time.
- **Active Hours Window**: Option to restrict reminders to specific hours (e.g., *Only remind me between 08:00 and 18:00*). Outside this window, reminders stay silent until the next allowed window.
- **Urgent Nudges**: Timed urgent reminders emit repeated alert nudges every 10 minutes until explicitly marked addressed in the UI.
- **Action Controls**:
  - **Snooze**: Postpone by 5 min, 10 min, 30 min, or 1 hour.
  - **Dismiss**: Silence recurring reminders.
  - **Reactivate**: Reopen previously dismissed or triggered reminders.
  - **Test**: Trigger notification and sound immediately.
  - **Reorder**: Drag-and-drop cards to reorder priority.

### 🔊 8 Synthesized Notification Tones
All 8 original notification tones are supported:
1. `chime`: Soft ascending three-note chime (C5, E5, G5)
2. `bell`: Classic struck bell ring with harmonics
3. `gentle`: Soft repeating gentle pulses
4. `urgent`: Fast attention beeps
5. `digital`: Crisp digital tone
6. `zen`: Deep calming gong
7. `birds`: Cheerful morning chirps
8. `silent`: Visual notification only

**Audio Features**:
- **Web Audio API**: Client-side mathematical audio synthesis for zero-latency, cross-platform playback directly through browser speakers.
- **Audio Fallback Stream**: Server-side `/api/tones/:tone/wav` dynamically generates PCM 16-bit WAV streams.
- **Tone Preview**: Listen to any tone from the creation modal or the Google tone bar.
- **Audio Mute/Unmute**: Quick toggle button in the top navigation bar.

### 🔔 Notifications (Web & Mobile)
- **Browser Web Notifications**: Native HTML5 `Notification` alerts that appear on your screen even when the browser tab is minimized or in the background.
- **In-App Interactive Popups**: Top-right floating alert cards with live actions:
  - *Snooze (5m / 10m / 30m)*
  - *Dismiss*
  - *Mark Addressed* (for urgent reminders)
- **Real-Time Live Updates**: Server-Sent Events (SSE) `/api/events/stream` push reminder events to all open tabs instantaneously.

### 📅 Calendar View
- Interactive month calendar grid with day selector.
- Visual colored pills for scheduled reminders, Google Calendar events, and Tasks.
- Day inspection sidebar showing timed items.

---

## Project Structure

```
remind-me-web/
├── server.js                        # Express HTTP & SSE server with full REST API
├── package.json                     # Dependencies & npm scripts
├── README.md                        # Documentation & setup guide
├── data/                            # SQLite database storage (reminders.db)
├── test/
│   └── app.test.js                  # Comprehensive test suite (100% pass)
├── public/
│   ├── index.html                   # Modern Web UI
│   ├── styles.css                   # Responsive dark/light theme & animations
│   ├── app.js                       # Frontend app, Web Audio API, Web Notifications, SSE
│   └── icon.svg                     # Application icon
└── src/
    ├── db/
    │   ├── database.js              # SQLite repository & migrations
    │   └── schema.sql               # Database schema definition
    ├── utils/
    │   ├── time-utils.js            # Time math, 12h formatting, timezone helpers
    │   └── http-client.js           # Lightweight HTTP/HTTPS client
    ├── scheduler/
    │   ├── scheduler.js             # Scheduling calculations & interval logic
    │   ├── urgent-nudges.js         # Urgent repeated nudge calculations
    │   └── external-reminders.js    # Google & iCal reminder offsets (10m, 5m, 0m)
    ├── notifications/
    │   └── sound-generator.js       # 8-tone audio synthesizer & WAV encoder
    ├── integrations/
    │   ├── gdrive-sync.js           # Google Drive automatic backup & restore
    │   ├── google-auth.js           # Google OAuth 2.0 flow & tokens
    │   ├── google-calendar.js       # Complete Google Calendar API v3 client (8 resources)
    │   ├── google-sync.js           # Google Calendar & Tasks sync
    │   └── ical-sync.js             # iCal feed parser & sync
    └── daemon/
        └── reminder-daemon.js       # Background daemon polling loop & broadcaster
```

---

## Online Deployment (Zero Installation)

This application has zero system binary dependencies and runs anywhere Node.js runs.

### Deploying to Render, Railway, or any Cloud Host:
1. Set start command: `npm start`
2. Set Environment Variables:
   - `PORT`: provided by cloud host (defaults to `3000`)
   - `GOOGLE_CLIENT_ID`: Your Google OAuth Client ID
   - `GOOGLE_CLIENT_SECRET`: Your Google OAuth Client Secret
3. Add your public hosting domain to Google Cloud Console:
   - Authorized Redirect URI: `https://your-domain.com/api/google/oauth/callback`
   - Authorized JavaScript Origin: `https://your-domain.com`

Anyone visiting your app's link can now sign in with Google. Their reminders will automatically sync to their personal Google Drive!

---

## Resolving Google OAuth "Error 400: redirect_uri_mismatch"

Google OAuth 2.0 strictly verifies that the redirect URI sent by the app matches character-for-character with an entry in your Google Cloud Console credentials.

### Quick 60-Second Fix:
1. Open [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Click on your **OAuth 2.0 Client ID** (under "OAuth 2.0 Client IDs").
3. Scroll down to **Authorized redirect URIs**.
4. Click **+ ADD URI** and add:
   - `http://localhost:3000/api/google/oauth/callback`
   - `http://127.0.0.1:3000/api/google/oauth/callback`
   - `http://127.0.0.1:8765/api/google/oauth/callback` (if using port 8765)
   - `https://<your-cloud-domain>/api/google/oauth/callback` (when hosted online)
5. Under **Authorized JavaScript origins**, add:
   - `http://localhost:3000`
   - `http://127.0.0.1:3000`
   - `https://<your-cloud-domain>`
6. Click **Save** at the bottom.
7. Return to RemindMe Web and click **Sign in with Google** — it will now connect immediately!

---

## Google Calendar API v3 Full Suite

RemindMe Web includes full support for all 8 Google Calendar API v3 resource types:

| Resource | Endpoints Available | Description |
|---|---|---|
| **Events** | `GET/POST /api/google/calendar/events`<br>`GET/PATCH/PUT/DELETE /api/google/calendar/events/:id`<br>`POST /api/google/calendar/events/quickAdd`<br>`GET /api/google/calendar/events/:id/instances`<br>`POST /api/google/calendar/events/:id/move` | List, create, patch, full update, delete, quick-add via natural language, fetch recurring instances, and move events across calendars. |
| **CalendarList** | `GET/POST /api/google/calendar/list`<br>`GET/PATCH/DELETE /api/google/calendar/list/:calendarId` | Manage user's calendar list, change calendar colors, override names, and toggle notifications. |
| **Calendars** | `GET/PATCH/DELETE /api/google/calendar/meta/:calendarId`<br>`POST /api/google/calendar/secondary`<br>`POST /api/google/calendar/meta/:calendarId/clear` | Create secondary calendars, update metadata, clear all events from primary calendar, and delete secondary calendars. |
| **Colors** | `GET /api/google/calendar/colors` | Retrieve color definitions for calendars and events. |
| **Freebusy** | `POST /api/google/calendar/freebusy` | Query availability and busy slots across multiple calendars. |
| **Settings** | `GET /api/google/calendar/settings`<br>`GET /api/google/calendar/settings/:settingId` | Access user calendar settings (timezone, format, default duration). |
| **Acl** | `GET/POST /api/google/calendar/acl/:calendarId`<br>`GET/PATCH/DELETE /api/google/calendar/acl/:calendarId/:ruleId` | List, grant, modify, and delete calendar sharing and access control rules. |
| **Channels** | `POST /api/google/calendar/channels/stop` | Stop webhook notification push channels. |

---

## Running Locally

```bash
cd remind-me-web
npm start
```

Open your browser at:
👉 **http://127.0.0.1:3000** or **http://localhost:3000**

To run on a custom port (such as 8765):
```bash
PORT=8765 npm start
```

---

## Running Tests

Run the complete test suite:

```bash
cd remind-me-web
npm test
```

---

## License & Credits

Developed by **Godson Joseph**.
All rights reserved.

