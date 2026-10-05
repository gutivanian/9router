"use client";

import PropTypes from "prop-types";
import { getRateLimitUsage } from "@/lib/rateLimits";

// One RPM/RPD/TPM/TPD cell: "count/limit" + a small bar, or "∞" for a metric
// this model has no configured limit for.
export function UsageCell({ usage }) {
  if (!usage) return <span className="text-text-muted/40">∞</span>;
  const ratio = usage.limit ? usage.count / usage.limit : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const barColor = ratio >= 1 ? "bg-red-500" : ratio >= 0.8 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="flex min-w-[52px] flex-col gap-0.5">
      <span className={ratio >= 1 ? "font-medium text-red-500" : "text-text-main"}>{usage.count}/{usage.limit}</span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

UsageCell.propTypes = {
  usage: PropTypes.shape({ count: PropTypes.number, limit: PropTypes.number }),
};

/**
 * Table of per-model RPM/RPD/TPM/TPD usage for one connection, driven entirely
 * by the user's own configured caps (rateLimitState), not a provider's native
 * quota API — so it works for any provider, including ones (like Gemini) with
 * no usage-reporting endpoint of their own. Renders nothing if this connection
 * (and its group default) has no model with a limit configured.
 *
 * `groupRateLimits` is this connection's PROVIDER's slice of
 * settings.groupRateLimits, i.e. { [group]: { [model]: {rpm,rpd,tpm,tpd} } } —
 * callers with the full multi-provider map must narrow it first.
 */
export default function RateLimitUsageTable({ connection, groupRateLimits = {}, resetSchedule = null }) {
  const groupDefaultsForConn = groupRateLimits[(connection.group || "").trim()] || {};
  const models = [...new Set([...Object.keys(connection.rateLimits || {}), ...Object.keys(groupDefaultsForConn)])].sort();
  if (models.length === 0) return null;

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
      <table className="w-full min-w-[420px] text-xs">
        <thead>
          <tr className="border-b border-black/10 text-left text-text-muted dark:border-white/10">
            <th className="px-2 py-1 font-normal">Model</th>
            <th className="px-2 py-1 font-normal">RPM</th>
            <th className="px-2 py-1 font-normal">RPD</th>
            <th className="px-2 py-1 font-normal">TPM</th>
            <th className="px-2 py-1 font-normal">TPD</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            const usage = getRateLimitUsage(connection, model, groupRateLimits, resetSchedule);
            if (!usage) return null;
            return (
              <tr key={model} className="border-b border-black/[0.04] last:border-0 dark:border-white/[0.04]">
                <td className="max-w-[200px] truncate px-2 py-1 font-mono" title={model}>{model}</td>
                <td className="px-2 py-1"><UsageCell usage={usage.rpm} /></td>
                <td className="px-2 py-1"><UsageCell usage={usage.rpd} /></td>
                <td className="px-2 py-1"><UsageCell usage={usage.tpm} /></td>
                <td className="px-2 py-1"><UsageCell usage={usage.tpd} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

RateLimitUsageTable.propTypes = {
  connection: PropTypes.shape({
    group: PropTypes.string,
    rateLimits: PropTypes.object,
    rateLimitState: PropTypes.object,
  }).isRequired,
  groupRateLimits: PropTypes.object,
  resetSchedule: PropTypes.shape({ timezone: PropTypes.string, hour: PropTypes.number }),
};
