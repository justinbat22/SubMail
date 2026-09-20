-- Fixed-window rate limiting, backed by D1 (no external KV/Redis dependency).
-- `key` identifies the (route, actor) pair being limited; `window_start` is
-- the epoch-ms start of the current fixed window for that key.

CREATE TABLE IF NOT EXISTS rate_limits (
    key           TEXT NOT NULL,
    window_start  INTEGER NOT NULL,
    count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
);

-- Enables efficient sweeping of stale windows during cleanup.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start);
