-- Failed admin logins, for the 5-per-hour-per-IP limit. ip_hash is a SHA-256, never the raw IP.
CREATE TABLE admin_login_failures (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash  TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX admin_login_failures_ip ON admin_login_failures (ip_hash, at);
