-- Wire contract: ../docs/WIRE.md section 7.
CREATE TABLE devices (
  key_id        TEXT PRIMARY KEY,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  env           TEXT NOT NULL CHECK (env IN ('production','development','simulator')),
  name          TEXT NOT NULL DEFAULT '',
  app_version   TEXT NOT NULL DEFAULT '',
  system        TEXT NOT NULL DEFAULT '',
  country       TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT
);

CREATE TABLE challenges (
  challenge   TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip_hash     TEXT
);
CREATE INDEX challenges_ip ON challenges (ip_hash, created_at);

CREATE TABLE attempts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  key_id    TEXT,
  endpoint  TEXT NOT NULL,
  kind      TEXT,
  outcome   TEXT NOT NULL,
  reason    TEXT,
  http      INTEGER NOT NULL,
  nonce     TEXT,
  country   TEXT,
  ms        INTEGER
);
CREATE UNIQUE INDEX attempts_nonce ON attempts (key_id, nonce) WHERE nonce IS NOT NULL AND outcome <> 'replay';
CREATE INDEX attempts_at ON attempts (at DESC);
CREATE INDEX attempts_key_at ON attempts (key_id, at DESC);

CREATE TABLE usage (
  key_id  TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);
