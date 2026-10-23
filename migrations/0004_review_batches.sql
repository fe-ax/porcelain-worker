-- Day reviews: one row per review batch at Anthropic's Message Batches API (docs/WIRE.md "Day review").
-- id is the opaque handle the app holds (128 random bits, base64url). status: waiting | done | failed | canceled.
CREATE TABLE review_batches (
  id          TEXT PRIMARY KEY,
  key_id      TEXT NOT NULL,
  batch_id    TEXT NOT NULL,           -- Anthropic's batch id (changes on every pause_turn continuation)
  params_json TEXT NOT NULL,           -- the request params, with paused assistant turns appended
  resumes     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','done','failed','canceled')),
  result_text TEXT,                    -- the answer when done
  error       TEXT,                    -- upstream | expired | canceled | refused | incomplete | unreadable when failed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX review_batches_key ON review_batches (key_id);
