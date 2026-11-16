import type Database from 'better-sqlite3';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window / sliding-reset SQLite rate limiter.
 * Backed by the active SQLite database so limits persist across restarts
 * and remain isolated per DATA_DIR without any public client override headers.
 */
export function checkRateLimit(
  db: Database.Database,
  key: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const tx = db.transaction((): RateLimitResult => {
    const existing = db
      .prepare('SELECT count, window_start, reset_at FROM rate_limits WHERE key = ?')
      .get(key) as { count: number; window_start: number; reset_at: number } | undefined;

    if (!existing || existing.reset_at <= now) {
      const resetAt = now + windowMs;
      db.prepare(
        `INSERT INTO rate_limits (key, count, window_start, reset_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start, reset_at = excluded.reset_at`
      ).run(key, now, resetAt);
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - 1),
        retryAfterSec: Math.ceil(windowMs / 1000),
      };
    }

    if (existing.count >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((existing.reset_at - now) / 1000)),
      };
    }

    const nextCount = existing.count + 1;
    db.prepare('UPDATE rate_limits SET count = ? WHERE key = ?').run(nextCount, key);
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - nextCount),
      retryAfterSec: Math.max(1, Math.ceil((existing.reset_at - now) / 1000)),
    };
  });

  return tx();
}

export function purgeExpiredRateLimits(db: Database.Database): void {
  db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(Date.now());
}
