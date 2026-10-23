-- Intermediate certificates whose signature was already verified against the pinned Apple root (attest.ts ChainCache).
-- cert_sha256 = SHA-256 of the intermediate's whole DER, root_sha256 = SHA-256 of the pinned root DER it was verified
-- against, both base64. A hit skips one P-384 verification on a later enrolment; dates and the leaf are still checked.
CREATE TABLE verified_intermediates (
  cert_sha256 TEXT NOT NULL,
  root_sha256 TEXT NOT NULL,
  not_after   INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (cert_sha256, root_sha256)
) WITHOUT ROWID;
