/**
 * Per-tool in-memory rate limiter.
 *
 * Two sliding windows ride alongside each tool name:
 *  - `minuteHits`: timestamps within the last 60s
 *  - `dayHits`:    timestamps within the last 24h
 *
 * Defaults are intentionally conservative because this server fronts a
 * paid upstream API and is also a way for a runaway agent to burn through
 * the operator's quota. Operators can override per call.
 *
 * Process-local — there's only one MCP stdio process per host, so a
 * shared in-memory map is sufficient. If we ever ship a non-stdio
 * transport we will need a distributed store; today we don't.
 */

const DEFAULT_PER_MINUTE = 30;
const DEFAULT_PER_DAY = 200;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Cap on per-tool hit arrays. Crosses ~10x the default day budget. */
const HIT_ARRAY_HARD_CAP = 1000;

export interface RateLimitResult {
  /** True when the call is allowed to proceed. */
  allowed: boolean;
  /** Suggested wait before retrying (only set when `allowed === false`). */
  retryAfterMs?: number;
  /** Which window tripped, for the audit log. */
  reason?: 'PER_MINUTE' | 'PER_DAY';
}

interface ToolBucket {
  minuteHits: number[];
  dayHits: number[];
}

const buckets: Map<string, ToolBucket> = new Map();
const overflowWarned: Set<string> = new Set();

function getBucket(toolName: string): ToolBucket {
  let b = buckets.get(toolName);
  if (!b) {
    b = { minuteHits: [], dayHits: [] };
    buckets.set(toolName, b);
  }
  return b;
}

function prune(arr: number[], windowMs: number, now: number): void {
  const cutoff = now - windowMs;
  // Hits are appended monotonically — drop from the front until we hit a
  // timestamp inside the window. Avoids re-allocating the array.
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) {
    i++;
  }
  if (i > 0) arr.splice(0, i);
}

function warnOnceIfOverflow(toolName: string, len: number): void {
  if (len <= HIT_ARRAY_HARD_CAP) return;
  if (overflowWarned.has(toolName)) return;
  overflowWarned.add(toolName);
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'rate_limit_overflow',
      tool: toolName,
      len,
      msg: 'rate-limit hit buffer is large; check perMinute/perDay overrides',
    }),
  );
}

/**
 * Check the rate-limit status for a tool call and record the attempt.
 *
 * IMPORTANT: this records the hit even when the call is denied. That is
 * intentional — a tight loop that keeps hammering the limiter should not
 * unlock just because each individual call was rejected. Treat the hit as
 * "this caller attempted N times in the last minute" rather than
 * "this caller successfully ran N times".
 */
export function checkRateLimit(
  toolName: string,
  opts?: { perMinute?: number; perDay?: number },
): RateLimitResult {
  const perMinute = opts?.perMinute ?? DEFAULT_PER_MINUTE;
  const perDay = opts?.perDay ?? DEFAULT_PER_DAY;
  const now = Date.now();
  const bucket = getBucket(toolName);

  prune(bucket.minuteHits, MINUTE_MS, now);
  prune(bucket.dayHits, DAY_MS, now);

  if (bucket.minuteHits.length >= perMinute) {
    // Oldest hit ages out of the minute window first.
    const retryAfterMs = Math.max(0, bucket.minuteHits[0] + MINUTE_MS - now);
    bucket.minuteHits.push(now);
    bucket.dayHits.push(now);
    warnOnceIfOverflow(toolName, bucket.dayHits.length);
    return { allowed: false, retryAfterMs, reason: 'PER_MINUTE' };
  }

  if (bucket.dayHits.length >= perDay) {
    const retryAfterMs = Math.max(0, bucket.dayHits[0] + DAY_MS - now);
    bucket.minuteHits.push(now);
    bucket.dayHits.push(now);
    warnOnceIfOverflow(toolName, bucket.dayHits.length);
    return { allowed: false, retryAfterMs, reason: 'PER_DAY' };
  }

  bucket.minuteHits.push(now);
  bucket.dayHits.push(now);
  warnOnceIfOverflow(toolName, bucket.dayHits.length);
  return { allowed: true };
}

/**
 * Clear all in-memory rate-limit state.
 *
 * @internal — exposed only for use by future tests. The `__` prefix is
 * meant to discourage accidental imports from production code. No public
 * API guarantees apply.
 */
export function __resetRateLimits(): void {
  buckets.clear();
  overflowWarned.clear();
}
