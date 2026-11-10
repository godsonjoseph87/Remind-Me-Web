-- Full SQLite schema for RemindMe Web App

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS reminders (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    type            TEXT NOT NULL CHECK (type IN (
                        'ONE_TIME', 'DAILY', 'HOURLY',
                        'INTERVAL_MINUTES', 'WEEKLY'
                    )),
    trigger_time    TEXT,
    interval_minutes INTEGER,
    days_of_week    TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                        'PENDING', 'TRIGGERED', 'DISMISSED', 'SNOOZED'
                    )),
    snooze_until    TEXT,
    last_fired_at   TEXT,
    tone            TEXT NOT NULL DEFAULT 'chime',
    priority        TEXT NOT NULL DEFAULT 'normal',
    color           TEXT NOT NULL DEFAULT '#6366f1',
    all_day         INTEGER NOT NULL DEFAULT 0,
    active_from     TEXT,
    active_until    TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    user_id         TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id     TEXT NOT NULL,
    triggered_at    TEXT NOT NULL,
    action_taken    TEXT NOT NULL CHECK (action_taken IN (
                        'FIRED', 'SNOOZED', 'DISMISSED'
                    )),
    FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_reminder_settings (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    offsets_minutes TEXT NOT NULL DEFAULT '[10,5,0]',
    tone            TEXT NOT NULL DEFAULT 'chime',
    enabled         INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO external_reminder_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS external_event_prefs (
    event_id        TEXT PRIMARY KEY,
    silent          INTEGER NOT NULL DEFAULT 0,
    snooze_until    TEXT,
    addressed_at    TEXT,
    last_nudge_at   TEXT
);

CREATE TABLE IF NOT EXISTS external_event_fires (
    event_id        TEXT NOT NULL,
    offset_minutes  INTEGER NOT NULL,
    fired_at        TEXT NOT NULL,
    dismissed       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, offset_minutes)
);

CREATE TABLE IF NOT EXISTS reminder_urgent_acks (
    reminder_id     TEXT NOT NULL,
    occurrence_key  TEXT NOT NULL,
    addressed_at    TEXT,
    last_nudge_at   TEXT,
    PRIMARY KEY (reminder_id, occurrence_key),
    FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS google_sync_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_sync_at    TEXT,
    last_error      TEXT,
    account_email   TEXT,
    account_name    TEXT,
    account_picture TEXT
);

INSERT OR IGNORE INTO google_sync_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS external_events (
    id              TEXT PRIMARY KEY,
    source          TEXT NOT NULL CHECK (source IN ('google_calendar', 'google_tasks', 'ical')),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    start_time      TEXT,
    end_time        TEXT,
    all_day         INTEGER NOT NULL DEFAULT 0,
    status          TEXT,
    html_link       TEXT,
    calendar_id     TEXT,
    synced_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_feeds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    label           TEXT NOT NULL DEFAULT 'Google Calendar',
    url             TEXT NOT NULL UNIQUE,
    last_sync_at    TEXT,
    last_error      TEXT,
    etag            TEXT,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
    session_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    email           TEXT NOT NULL,
    name            TEXT,
    picture         TEXT,
    access_token    TEXT,
    refresh_token   TEXT,
    token_expiry    INTEGER,
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_reminders_snooze ON reminders(snooze_until);
CREATE INDEX IF NOT EXISTS idx_logs_reminder_id ON reminder_logs(reminder_id);
CREATE INDEX IF NOT EXISTS idx_logs_triggered_at ON reminder_logs(triggered_at);
CREATE INDEX IF NOT EXISTS idx_ext_fires_event ON external_event_fires(event_id);
CREATE INDEX IF NOT EXISTS idx_urgent_acks_reminder ON reminder_urgent_acks(reminder_id);
CREATE INDEX IF NOT EXISTS idx_external_start ON external_events(start_time);
CREATE INDEX IF NOT EXISTS idx_external_source ON external_events(source);
CREATE INDEX IF NOT EXISTS idx_user_sessions_email ON user_sessions(email);

