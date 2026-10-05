"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import { Card, Badge, Button, Modal, Select, Toggle, EditConnectionModal, ConfirmModal, RateLimitsModal } from "@/shared/components";
import ConnectionRow from "@/app/(dashboard)/dashboard/providers/[id]/ConnectionRow";
import { resolveProviderResetSchedule } from "@/shared/constants/providers";

// ── AddApiKeyModal ─────────────────────────────────────────────
function AddApiKeyModal({ isOpen, provider, providerName, proxyPools, onSave, onClose }) {
  const NONE = "__none__";
  const [formData, setFormData] = useState({ name: "", apiKey: "", priority: 1, proxyPoolId: NONE });
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: formData.apiKey }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch { setValidationResult("failed"); }
    finally { setValidating(false); }
  };

  const handleSubmit = async () => {
    if (!provider || !formData.apiKey) return;
    setSaving(true);
    try {
      let isValid = false;
      try {
        setValidating(true); setValidationResult(null);
        const res = await fetch("/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, apiKey: formData.apiKey }),
        });
        const data = await res.json();
        isValid = !!data.valid;
        setValidationResult(isValid ? "success" : "failed");
      } catch { setValidationResult("failed"); }
      finally { setValidating(false); }
      await onSave({
        name: formData.name,
        apiKey: formData.apiKey,
        priority: formData.priority,
        proxyPoolId: formData.proxyPoolId === NONE ? null : formData.proxyPoolId,
        testStatus: isValid ? "active" : "unknown",
      });
    } finally { setSaving(false); }
  };

  if (!provider) return null;

  return (
    <Modal
      isOpen={isOpen}
      title={`Add ${providerName || provider} API Key`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name || !formData.apiKey || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs text-text-muted mb-1 block">Name</label>
          <input className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Production Key" />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-text-muted mb-1 block">API Key</label>
            <input type="password" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" value={formData.apiKey} onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })} />
          </div>
          <div className="pt-6">
            <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
              {validating ? "Checking..." : "Check"}
            </Button>
          </div>
        </div>
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? "Valid" : "Invalid"}
          </Badge>
        )}
        <div>
          <label className="text-xs text-text-muted mb-1 block">Priority</label>
          <input type="number" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value) || 1 })} />
        </div>
        <Select label="Proxy Pool" value={formData.proxyPoolId} onChange={(e) => setFormData({ ...formData, proxyPoolId: e.target.value })}
          options={[{ value: NONE, label: "None" }, ...(proxyPools || []).map((p) => ({ value: p.id, label: p.name }))]} />
      </div>
    </Modal>
  );
}

AddApiKeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerName: PropTypes.string,
  proxyPools: PropTypes.array,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ConnectionsCard ────────────────────────────────────────────
// Self-contained card: fetches, displays and manages all connections for a provider.
export default function ConnectionsCard({ providerId, isOAuth }) {
  const [connections, setConnections] = useState([]);
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [providerStrategy, setProviderStrategy] = useState(null);
  const [providerStickyLimit, setProviderStickyLimit] = useState("1");
  const [confirmState, setConfirmState] = useState(null);
  const [groupRateLimits, setGroupRateLimits] = useState({}); // this provider's slice of settings.groupRateLimits
  const [resetScheduleOverride, setResetScheduleOverride] = useState(null);
  const [connGroupFilter, setConnGroupFilter] = useState(""); // "" all, "__ungrouped__", or a group name
  const [connSearch, setConnSearch] = useState("");
  const [rateLimitsConnection, setRateLimitsConnection] = useState(null);
  const [editingGroupLimits, setEditingGroupLimits] = useState(null);

  const fetch_ = useCallback(async () => {
    try {
      const [connRes, proxyRes, settingsRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const connData = await connRes.json();
      const proxyData = await proxyRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      if (connRes.ok) setConnections((connData.connections || []).filter((c) => c.provider === providerId));
      if (proxyRes.ok) setProxyPools(proxyData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProviderStrategy(override.fallbackStrategy || null);
      setProviderStickyLimit(override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "1");
      setGroupRateLimits((settingsData.groupRateLimits || {})[providerId] || {});
      setResetScheduleOverride((settingsData.providerResetSchedule || {})[providerId] || null);
    } catch (e) { console.log("ConnectionsCard fetch error:", e); }
    finally { setLoading(false); }
  }, [providerId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  // Same effective reset schedule the provider page uses: override > registry default > rolling 24h.
  const resetSchedule = resolveProviderResetSchedule(providerId, resetScheduleOverride ? { [providerId]: resetScheduleOverride } : {});

  // Group filter + search, same behaviour as the provider page.
  const connectionGroups = useMemo(
    () => [...new Set(connections.map((c) => (c.group || "").trim()).filter(Boolean))].sort(),
    [connections],
  );
  const hasUngrouped = connections.some((c) => !(c.group || "").trim());
  const query = connSearch.trim().toLowerCase();
  const visibleConnections = connections.filter((c) => {
    const g = (c.group || "").trim();
    if (connGroupFilter === "__ungrouped__" ? g : connGroupFilter && g !== connGroupFilter) return false;
    if (query) {
      const hay = [c.name, c.email, c.displayName, c.group].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const saveStrategy = async (strategy, stickyLimit) => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = {};
      if (strategy) override.fallbackStrategy = strategy;
      if (strategy === "round-robin" && stickyLimit !== "") override.stickyRoundRobinLimit = Number(stickyLimit) || 3;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerStrategies: updated }) });
    } catch (e) { console.log("saveStrategy error:", e); }
  };

  const handleSwapPriority = async (i1, i2) => {
    const next = [...connections];
    [next[i1], next[i2]] = [next[i2], next[i1]];
    setConnections(next);
    try {
      await Promise.all([
        fetch(`/api/providers/${next[i1].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: i1 }) }),
        fetch(`/api/providers/${next[i2].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: i2 }) }),
      ]);
    } catch { await fetch_(); }
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Connection",
      message: "Delete this connection?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
          if (res.ok) setConnections((prev) => prev.filter((c) => c.id !== id));
        } catch (e) { console.log("delete error:", e); }
      }
    });
  };

  const handleToggleActive = async (id, isActive) => {
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
      if (res.ok) setConnections((prev) => prev.map((c) => c.id === id ? { ...c, isActive } : c));
    } catch (e) { console.log("toggle error:", e); }
  };

  const handleUpdateProxy = async (connId, proxyPoolId) => {
    try {
      const res = await fetch(`/api/providers/${connId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proxyPoolId: proxyPoolId || null }) });
      if (res.ok) setConnections((prev) => prev.map((c) => c.id === connId ? { ...c, providerSpecificData: { ...c.providerSpecificData, proxyPoolId: proxyPoolId || null } } : c));
    } catch (e) { console.log("proxy error:", e); }
  };

  // Per-key caps: saved on the connection itself.
  const handleUpdateKeyRateLimits = async (rateLimits) => {
    if (!rateLimitsConnection) return;
    try {
      const res = await fetch(`/api/providers/${rateLimitsConnection.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rateLimits }) });
      if (res.ok) {
        setConnections((prev) => prev.map((c) => c.id === rateLimitsConnection.id ? { ...c, rateLimits } : c));
        setRateLimitsConnection(null);
      }
    } catch (e) { console.log("rate limits error:", e); }
  };

  // Writes this provider's slice of settings.groupRateLimits. Re-reads the full
  // settings first so other providers' group defaults are never clobbered.
  const writeGroupRateLimits = async (nextProviderGroups) => {
    const res = await fetch("/api/settings", { cache: "no-store" });
    const settingsData = res.ok ? await res.json() : {};
    const all = { ...(settingsData.groupRateLimits || {}) };
    if (Object.keys(nextProviderGroups).length > 0) all[providerId] = nextProviderGroups;
    else delete all[providerId];
    const patch = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupRateLimits: all }) });
    return patch.ok;
  };

  const handleSaveGroupRateLimits = async (group, limits) => {
    const next = { ...groupRateLimits };
    if (limits && Object.keys(limits).length > 0) next[group] = limits;
    else delete next[group];
    if (await writeGroupRateLimits(next)) {
      setGroupRateLimits(next);
      setEditingGroupLimits(null);
    }
  };

  // Copy one config onto several group defaults at once (from a group or a key).
  const handleApplyRateLimitsToGroups = async (targetGroups, limitsObj) => {
    if (!limitsObj || targetGroups.length === 0) return;
    const next = { ...groupRateLimits };
    for (const g of targetGroups) next[g] = structuredClone(limitsObj);
    if (await writeGroupRateLimits(next)) setGroupRateLimits(next);
  };

  const handleSaveApiKey = async (formData) => {
    try {
      const res = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, ...formData }) });
      if (res.ok) { await fetch_(); setShowAddModal(false); }
    } catch (e) { console.log("save apikey error:", e); }
  };

  const handleUpdateConnection = async (formData) => {
    try {
      const res = await fetch(`/api/providers/${selectedConnection.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(formData) });
      if (res.ok) { await fetch_(); setShowEditModal(false); }
    } catch (e) { console.log("update connection error:", e); }
  };

  if (loading) return <Card><div className="h-20 animate-pulse bg-black/5 rounded-lg" /></Card>;

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 className="text-lg font-semibold">Connections</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted font-medium">Round Robin</span>
            <Toggle
              checked={providerStrategy === "round-robin"}
              onChange={(enabled) => {
                const strategy = enabled ? "round-robin" : null;
                setProviderStrategy(strategy);
                if (enabled && !providerStickyLimit) setProviderStickyLimit("1");
                saveStrategy(strategy, enabled ? (providerStickyLimit || "1") : providerStickyLimit);
              }}
            />
            {providerStrategy === "round-robin" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-text-muted">Sticky:</span>
                <input
                  type="number" min={1} value={providerStickyLimit}
                  onChange={(e) => { setProviderStickyLimit(e.target.value); saveStrategy("round-robin", e.target.value); }}
                  className="w-16 px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:border-primary"
                />
              </div>
            )}
          </div>
        </div>

        {connections.length === 0 ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-muted">No connections yet</p>
            <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Add Connection</Button>
          </div>
        ) : (
          <>
            {/* Search + group filter. Group options show how many keys each group has. */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={connSearch}
                onChange={(e) => setConnSearch(e.target.value)}
                placeholder="Search by name, email or group…"
                className="min-w-[180px] flex-1 rounded-lg border border-black/10 bg-transparent px-3 py-1.5 text-sm placeholder-text-muted/70 focus:border-primary/40 focus:outline-none dark:border-white/10"
              />
              <select
                value={connGroupFilter}
                onChange={(e) => setConnGroupFilter(e.target.value)}
                className={`min-w-[220px] rounded-lg border px-3 py-1.5 text-sm ${connGroupFilter ? "border-primary text-primary" : "border-black/10 text-text-muted dark:border-white/10"}`}
                title="Filter connections by group"
              >
                <option value="">All groups ({connections.length})</option>
                {connectionGroups.map((g) => (
                  <option key={g} value={g}>{g} ({connections.filter((c) => (c.group || "").trim() === g).length})</option>
                ))}
                {hasUngrouped && (
                  <option value="__ungrouped__">Ungrouped ({connections.filter((c) => !(c.group || "").trim()).length})</option>
                )}
              </select>
              {connGroupFilter && connGroupFilter !== "__ungrouped__" && (
                <button
                  type="button"
                  onClick={() => setEditingGroupLimits(connGroupFilter)}
                  className={`rounded-full p-1.5 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${groupRateLimits[connGroupFilter] ? "text-primary" : "text-text-muted hover:text-primary"}`}
                  title={`Default rate limits for group "${connGroupFilter}"`}
                >
                  <span className="material-symbols-outlined text-[16px]">speed</span>
                </button>
              )}
            </div>

            <div className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03] max-h-[500px] overflow-y-auto pr-1">
              {visibleConnections.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-text-muted">No connections match.</p>
              )}
              {visibleConnections.map((conn) => {
                const idx = connections.indexOf(conn);
                const filtered = connGroupFilter !== "" || query !== "";
                return (
                  <ConnectionRow
                    key={conn.id}
                    connection={conn}
                    proxyPools={proxyPools}
                    isOAuth={isOAuth}
                    isFirst={idx === 0}
                    isLast={idx === connections.length - 1}
                    onMoveUp={filtered ? undefined : () => handleSwapPriority(idx, idx - 1)}
                    onMoveDown={filtered ? undefined : () => handleSwapPriority(idx, idx + 1)}
                    onToggleActive={(isActive) => handleToggleActive(conn.id, isActive)}
                    onUpdateProxy={(poolId) => handleUpdateProxy(conn.id, poolId)}
                    onEdit={() => { setSelectedConnection(conn); setShowEditModal(true); }}
                    onEditRateLimits={() => setRateLimitsConnection(conn)}
                    groupRateLimits={groupRateLimits}
                    resetSchedule={resetSchedule}
                    onDelete={() => handleDelete(conn.id)}
                  />
                );
              })}
            </div>
            <div className="mt-4 flex justify-stretch sm:justify-start">
              <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Add</Button>
            </div>
          </>
        )}
      </Card>

      <AddApiKeyModal
        isOpen={showAddModal}
        provider={providerId}
        proxyPools={proxyPools}
        onSave={handleSaveApiKey}
        onClose={() => setShowAddModal(false)}
      />
      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => setShowEditModal(false)}
      />

      {rateLimitsConnection && (
        <RateLimitsModal
          key={rateLimitsConnection.id}
          isOpen={true}
          title={`Rate Limits — ${rateLimitsConnection.name || rateLimitsConnection.email || rateLimitsConnection.id?.slice(0, 8)}`}
          limits={rateLimitsConnection.rateLimits}
          groupDefaults={groupRateLimits[(rateLimitsConnection.group || "").trim()] || {}}
          copyTargets={connectionGroups}
          onCopyTo={handleApplyRateLimitsToGroups}
          onSave={handleUpdateKeyRateLimits}
          onClose={() => setRateLimitsConnection(null)}
        />
      )}
      {editingGroupLimits && (
        <RateLimitsModal
          key={`group-${editingGroupLimits}`}
          isOpen={true}
          title={`Rate Limits — group "${editingGroupLimits}" (default)`}
          limits={groupRateLimits[editingGroupLimits]}
          copyOptions={Object.entries(groupRateLimits)
            .filter(([g, l]) => g !== editingGroupLimits && l && Object.keys(l).length > 0)
            .map(([g, l]) => ({ label: g, limits: l }))}
          copyTargets={connectionGroups.filter((g) => g !== editingGroupLimits)}
          onCopyTo={handleApplyRateLimitsToGroups}
          onSave={(limits) => handleSaveGroupRateLimits(editingGroupLimits, limits)}
          onClose={() => setEditingGroupLimits(null)}
        />
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </>
  );
}

ConnectionsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  isOAuth: PropTypes.bool,
};
