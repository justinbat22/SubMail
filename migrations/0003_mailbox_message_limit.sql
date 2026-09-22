-- Atomically enforces MAX_MESSAGES_PER_MAILBOX at the database level, closing
-- a race condition in the application-level "COUNT then INSERT" pattern:
-- two concurrent email deliveries could both observe count=199 (< 200),
-- both proceed to INSERT, and the mailbox would end up with 201 messages.
--
-- A COUNT(*)-based trigger (rather than a separately-maintained counter
-- column) is used deliberately: it can never drift out of sync with the
-- actual row count, because it IS the actual row count, recomputed fresh on
-- every insert. A counter column would need every deletion path (message
-- delete, mailbox cascade delete, cron cleanup) to remember to decrement it
-- correctly, forever — one missed path and the counter silently drifts.
-- COUNT(*) here is bounded and cheap: it scans at most `max_messages`
-- matching rows via the existing idx_messages_mailbox_id index.
--
-- Atomicity relies on D1/SQLite's single-writer model: writes to a given
-- database are serialized, so two concurrent "INSERT INTO messages" calls
-- for the same mailbox_id cannot have their trigger evaluations interleave.
-- Whichever insert is processed second will see the first insert's row
-- already counted, and abort if that pushes the count to the configured max.

CREATE TABLE IF NOT EXISTS mailbox_limits (
    key    TEXT PRIMARY KEY,
    value  INTEGER NOT NULL
);

-- Seeded to match the MAX_MESSAGES_PER_MAILBOX default in wrangler.toml at
-- the time this migration was written. This is intentionally a database
-- value, not read from the Worker's environment variable at insert time —
-- SQLite triggers can't reach into Worker env vars, so the hard invariant
-- enforced here is a schema-level constant. Operators changing
-- MAX_MESSAGES_PER_MAILBOX in wrangler.toml (which still governs the fast
-- pre-check that avoids wasted parsing work for an already-full mailbox)
-- should also run:
--   UPDATE mailbox_limits SET value = <new_limit> WHERE key = 'max_messages_per_mailbox';
-- so the two stay in sync. See README "Operational notes" for the full
-- explanation of this trade-off.
INSERT OR IGNORE INTO mailbox_limits (key, value) VALUES ('max_messages_per_mailbox', 200);

CREATE TRIGGER IF NOT EXISTS enforce_mailbox_message_limit
BEFORE INSERT ON messages
FOR EACH ROW
WHEN (
    SELECT COUNT(*) FROM messages WHERE mailbox_id = NEW.mailbox_id
) >= (
    SELECT value FROM mailbox_limits WHERE key = 'max_messages_per_mailbox'
)
BEGIN
    SELECT RAISE(ABORT, 'MAILBOX_FULL');
END;
