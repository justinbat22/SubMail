-- Makes redelivery of the same email idempotent. If Cloudflare retries a
-- message delivery after a transient failure (e.g. an R2 upload error) on a
-- previous attempt, this constraint lets the application detect "this exact
-- message was already stored for this mailbox" and treat the retry as a
-- successful no-op instead of creating a duplicate message.
--
-- SQLite's UNIQUE index treats each NULL as distinct from every other NULL,
-- so messages with no Message-ID header (never generated, or stripped by a
-- misbehaving sender) are correctly never deduplicated against each other —
-- only an exact (mailbox_id, message_id) match with a non-null message_id
-- collides, which is exactly the "this is genuinely the same email" case.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_mailbox_id_message_id
ON messages (mailbox_id, message_id)
WHERE message_id IS NOT NULL;
