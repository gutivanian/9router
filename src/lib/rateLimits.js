// Pure helpers for the per-(connection, model) rate-limit feature (RPM/RPD/TPM/TPD).
//
// Default is unlimited: a value only takes effect once explicitly configured,
// either on the key itself (connection.rateLimits[model]) or as a group default
// (settings.groupRateLimits[group][model]). Nothing here touches the database —
// callers read/write the actual counters via connectionsRepo's
// bumpRateLimitCounters, which does an atomic read-modify-write per (connection,
// model) so concurrent callers never lose an increment (see its doc comment).
//
// RPM/TPM are always rolling (reset 60s after the window's first request) —
// that matches how every provider's own per-minute limit actually behaves, so
// there's nothing to configure.
//
// RPD/TPD default to the same rolling behavior (resets exactly 24h after the
// window's first request) UNLESS the caller passes a `resetSchedule` —
// { timezone: "America/Los_Angeles", hour: 0 } — in which case the window
// instead resets at that wall-clock hour every day, matching how providers
// that publish a fixed daily reset actually behave (e.g. Gemini resets at
// midnight Pacific, not 24h after your first call). Each provider resets on
// its own clock, so this is resolved per-provider by the caller (from
// settings.providerResetSchedule, falling back to a provider's registry
// default) — rateLimits.js itself stays provider-agnostic. No scheduler is
// involved anywhere: every window is recomputed lazily, on read.
//
// RPM/RPD vs TPM/TPD is an important asymmetry:
// - RPM/RPD count REQUESTS, known the instant a connection is selected — bumped
//   optimistically via nextStateForRequest() right before dispatch.
// - TPM/TPD count TOKENS, only known after a response finishes — bumped via
//   nextStateForTokens() post-hoc, once actual usage is reported. Enforcement for
//   token limits is therefore always one request behind: a key already over its
//   TPM/TPD budget gets skipped for the NEXT request, not the one that pushed it
//   over. That's an inherent limit of the token model itself (providers work the
//   same way — they can't precheck a response's own token count either).

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function hasAnyLimit(l) {
  return !!(l && (l.rpm || l.rpd || l.tpm || l.tpd));
}

/**
 * Resolve the effective { rpm, rpd, tpm, tpd } for one (connection, model) pair.
 * The key's own override wins outright (even if only some fields are set —
 * no merging with the group default, to keep resolution simple to reason about);
 * otherwise fall back to the connection's group default. Returns null if neither
 * is configured (unlimited).
 */
export function resolveRateLimits(connection, model, groupRateLimits) {
  if (!model) return null;
  const own = connection?.rateLimits?.[model];
  if (hasAnyLimit(own)) return own;
  const group = (connection?.group || "").trim();
  if (!group) return null;
  const fallback = groupRateLimits?.[group]?.[model];
  return hasAnyLimit(fallback) ? fallback : null;
}

// Converts a wall-clock moment (y/mo/d h:mi, both 1-based month) in an IANA
// timezone to a UTC epoch ms, via the standard "format a guess, then correct
// by the observed offset" trick. Exact except right at a DST transition
// instant — an acceptable approximation for a soft, proactive-avoidance
// signal (see file header), not worth pulling in a timezone library for.
function zonedWallTimeToUtcMs(year, month, day, hour, minute, timeZone) {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(guessMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const seenAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return guessMs + (guessMs - seenAsUtcMs);
}

// Most recent occurrence (at or before `nowMs`) of `hour:00` in `timezone`.
function mostRecentDailyReset(nowMs, timezone, hour) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  let resetMs = zonedWallTimeToUtcMs(get("year"), get("month"), get("day"), hour, 0, timezone);
  // Today's reset hasn't happened yet in that timezone — the most recent one
  // was yesterday's.
  if (resetMs > nowMs) resetMs -= DAY_MS;
  return resetMs;
}

// Is a daily (RPD/TPD) window from before its most recent reset boundary?
// With no resetSchedule for this provider, falls back to the original
// rolling-24h behavior — see file header.
function isDailyWindowStale(windowStart, nowMs, resetSchedule) {
  if (!windowStart) return true;
  const startMs = new Date(windowStart).getTime();
  if (!resetSchedule?.timezone) return nowMs - startMs >= DAY_MS;
  try {
    return startMs < mostRecentDailyReset(nowMs, resetSchedule.timezone, resetSchedule.hour || 0);
  } catch {
    // Unknown/invalid IANA timezone string — don't let a bad setting break
    // enforcement, just fall back to rolling.
    return nowMs - startMs >= DAY_MS;
  }
}

// Roll a rolling window (RPM/TPM) forward by `incrementBy`. If the window has
// elapsed (or never started), it resets to a fresh window starting now
// instead of carrying over a stale count. Returns the next persisted shape —
// never mutates input.
function rollWindow(prevStart, prevCount, windowMs, incrementBy) {
  const now = Date.now();
  const elapsed = prevStart ? now - new Date(prevStart).getTime() : Infinity;
  if (elapsed >= windowMs) {
    return { windowStart: new Date(now).toISOString(), count: incrementBy };
  }
  return { windowStart: prevStart, count: (prevCount || 0) + incrementBy };
}

// Same as rollWindow, but for a daily (RPD/TPD) window — staleness is decided
// by isDailyWindowStale (calendar-aware when resetSchedule is given, rolling
// 24h otherwise) instead of a fixed windowMs.
function rollDailyWindow(prevStart, prevCount, incrementBy, resetSchedule) {
  const now = Date.now();
  if (isDailyWindowStale(prevStart, now, resetSchedule)) {
    return { windowStart: new Date(now).toISOString(), count: incrementBy };
  }
  return { windowStart: prevStart, count: (prevCount || 0) + incrementBy };
}

// Is this rolling (RPM/TPM) window already at/over its limit? An elapsed
// window always reads as "not over" (it would reset on the next actual bump)
// — never blocks on stale data.
function overLimit(windowStart, count, windowMs, limit) {
  if (!limit || !windowStart) return false;
  if (Date.now() - new Date(windowStart).getTime() >= windowMs) return false;
  return (count || 0) >= limit;
}

// Same as overLimit, but for a daily (RPD/TPD) window.
function overLimitDaily(windowStart, count, limit, resetSchedule) {
  if (!limit || !windowStart) return false;
  if (isDailyWindowStale(windowStart, Date.now(), resetSchedule)) return false;
  return (count || 0) >= limit;
}

/**
 * True if `connection` should be skipped for `model` right now because it's
 * already at/over any of its configured RPM/RPD/TPM/TPD. Meant to be checked
 * alongside isModelLockActive() when filtering candidates for selection.
 * `resetSchedule` ({ timezone, hour }) controls when RPD/TPD reset — omit it
 * to keep the rolling-24h default.
 */
export function isRateLimitBlocked(connection, model, groupRateLimits, resetSchedule) {
  const limits = resolveRateLimits(connection, model, groupRateLimits);
  if (!limits) return false;
  const state = connection?.rateLimitState?.[model] || {};
  return (
    overLimit(state.rpmWindowStart, state.rpmCount, MINUTE_MS, limits.rpm) ||
    overLimitDaily(state.rpdWindowStart, state.rpdCount, limits.rpd, resetSchedule) ||
    overLimit(state.tpmWindowStart, state.tpmCount, MINUTE_MS, limits.tpm) ||
    overLimitDaily(state.tpdWindowStart, state.tpdCount, limits.tpd, resetSchedule)
  );
}

/**
 * Effective { count, limit } for each of a (connection, model) pair's four
 * counters, for display only (e.g. a "10/15" usage bar in the UI). A metric
 * with no configured limit comes back null — the caller renders that as
 * "unlimited" rather than a bar. An elapsed window reads as already reset to
 * 0, matching overLimit()'s treatment of stale data: the stored count only
 * actually rolls over on the next real bump, but showing the stale number
 * would read as "still over" for a window that's actually long since reset.
 * Returns null entirely if the model has no limits configured at all.
 */
export function getRateLimitUsage(connection, model, groupRateLimits, resetSchedule) {
  const limits = resolveRateLimits(connection, model, groupRateLimits);
  if (!limits) return null;
  const state = connection?.rateLimitState?.[model] || {};
  const metric = (windowStart, count, windowMs, limit) => {
    if (!limit) return null;
    const elapsed = windowStart ? Date.now() - new Date(windowStart).getTime() : Infinity;
    return { count: elapsed >= windowMs ? 0 : (count || 0), limit };
  };
  const metricDaily = (windowStart, count, limit) => {
    if (!limit) return null;
    const stale = isDailyWindowStale(windowStart, Date.now(), resetSchedule);
    return { count: stale ? 0 : (count || 0), limit };
  };
  return {
    rpm: metric(state.rpmWindowStart, state.rpmCount, MINUTE_MS, limits.rpm),
    rpd: metricDaily(state.rpdWindowStart, state.rpdCount, limits.rpd),
    tpm: metric(state.tpmWindowStart, state.tpmCount, MINUTE_MS, limits.tpm),
    tpd: metricDaily(state.tpdWindowStart, state.tpdCount, limits.tpd),
  };
}

/**
 * When a daily (RPD/TPD) window that started at `windowStart` will next reset
 * — for display only (e.g. a "retry after" hint when every key is exhausted).
 * With no resetSchedule, that's windowStart + 24h, matching the rolling
 * default used everywhere else in this file.
 */
export function nextDailyReset(windowStart, resetSchedule) {
  if (!windowStart) return null;
  const startMs = new Date(windowStart).getTime();
  if (!resetSchedule?.timezone) return new Date(startMs + DAY_MS).toISOString();
  try {
    const mostRecentBoundary = mostRecentDailyReset(Date.now(), resetSchedule.timezone, resetSchedule.hour || 0);
    // windowStart is always at/after the current period's boundary (an
    // earlier one would already read as stale and have reset) — so the next
    // reset is exactly one day after that boundary.
    return new Date(mostRecentBoundary + DAY_MS).toISOString();
  } catch {
    return new Date(startMs + DAY_MS).toISOString();
  }
}

/**
 * Next rateLimitState[model] fields after one more request is about to be sent.
 * Call right when a connection is chosen, before dispatch (RPM/RPD only — token
 * count for THIS request isn't known yet). Returns null if neither RPM nor RPD
 * is configured, so callers can skip the write entirely for keys with no limit.
 */
export function nextStateForRequest(connection, model, groupRateLimits, resetSchedule) {
  const limits = resolveRateLimits(connection, model, groupRateLimits);
  if (!limits || (!limits.rpm && !limits.rpd)) return null;
  const state = connection?.rateLimitState?.[model] || {};
  const patch = {};
  if (limits.rpm) {
    const rpm = rollWindow(state.rpmWindowStart, state.rpmCount, MINUTE_MS, 1);
    patch.rpmWindowStart = rpm.windowStart;
    patch.rpmCount = rpm.count;
  }
  if (limits.rpd) {
    const rpd = rollDailyWindow(state.rpdWindowStart, state.rpdCount, 1, resetSchedule);
    patch.rpdWindowStart = rpd.windowStart;
    patch.rpdCount = rpd.count;
  }
  return patch;
}

/**
 * Next rateLimitState[model] fields once a request's actual token usage is
 * known. Call after the response finishes. Returns null if neither TPM nor TPD
 * is configured, or there were no tokens to add.
 */
export function nextStateForTokens(connection, model, groupRateLimits, tokensUsed, resetSchedule) {
  if (!tokensUsed) return null;
  const limits = resolveRateLimits(connection, model, groupRateLimits);
  if (!limits || (!limits.tpm && !limits.tpd)) return null;
  const state = connection?.rateLimitState?.[model] || {};
  const patch = {};
  if (limits.tpm) {
    const tpm = rollWindow(state.tpmWindowStart, state.tpmCount, MINUTE_MS, tokensUsed);
    patch.tpmWindowStart = tpm.windowStart;
    patch.tpmCount = tpm.count;
  }
  if (limits.tpd) {
    const tpd = rollDailyWindow(state.tpdWindowStart, state.tpdCount, tokensUsed, resetSchedule);
    patch.tpdWindowStart = tpd.windowStart;
    patch.tpdCount = tpd.count;
  }
  return patch;
}
