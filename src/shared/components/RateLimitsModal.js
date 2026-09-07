"use client";

import { useState, useRef, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";

const FIELDS = [
  { key: "rpm", label: "RPM", hint: "requests / min" },
  { key: "rpd", label: "RPD", hint: "requests / day" },
  { key: "tpm", label: "TPM", hint: "tokens / min" },
  { key: "tpd", label: "TPD", hint: "tokens / day" },
];

function emptyEntry() {
  return { rpm: "", rpd: "", tpm: "", tpd: "" };
}

function toLimitOrUndefined(v) {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Per-model rate-limit config — for one connection (key) or one group default,
// depending on the caller (see RateLimitsModal.forConnection/forGroup below).
// Default is unlimited — a model only gets a cap once explicitly given a number
// here; blank = no limit for that field. 9Router proactively skips a key once
// it's at/over any configured limit (its own, or its group's default), rather
// than waiting for the provider's own 429.
export default function RateLimitsModal({ isOpen, title, limits, modelOptions = [], copyOptions = [], onClose, onSave }) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    for (const [model, l] of Object.entries(limits || {})) {
      d[model] = {
        rpm: l?.rpm ?? "", rpd: l?.rpd ?? "",
        tpm: l?.tpm ?? "", tpd: l?.tpd ?? "",
      };
    }
    return d;
  });
  const [newModel, setNewModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const pickerRef = useRef(null);

  const models = Object.keys(draft);

  // Native <datalist> is unreliable across browsers (some show nothing at
  // all) — a plain filtered dropdown, same pattern as the Proxy picker in
  // ConnectionRow.js, is guaranteed to render.
  const query = newModel.trim().toLowerCase();
  const suggestions = modelOptions
    .filter((m) => !draft[m])
    .filter((m) => !query || m.toLowerCase().includes(query))
    .slice(0, 30);

  useEffect(() => {
    if (!showSuggestions) return;
    const handler = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSuggestions]);

  const handleAddModel = (modelOverride) => {
    const m = (modelOverride ?? newModel).trim();
    if (!m || draft[m]) return;
    setDraft((prev) => ({ ...prev, [m]: emptyEntry() }));
    setNewModel("");
    setShowSuggestions(false);
  };

  const handleRemoveModel = (model) => {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[model];
      return next;
    });
  };

  const handleFieldChange = (model, field, value) => {
    setDraft((prev) => ({ ...prev, [model]: { ...prev[model], [field]: value } }));
  };

  // Replaces the whole draft with another already-configured source's limits
  // (e.g. copying one group's defaults into another). A plain replace, not a
  // merge — predictable, and the source is by definition already valid config.
  const handleCopyFrom = (source) => {
    const found = copyOptions.find((o) => o.label === source);
    if (!found) return;
    const d = {};
    for (const [model, l] of Object.entries(found.limits || {})) {
      d[model] = {
        rpm: l?.rpm ?? "", rpd: l?.rpd ?? "",
        tpm: l?.tpm ?? "", tpd: l?.tpd ?? "",
      };
    }
    setDraft(d);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = {};
      for (const [model, limits] of Object.entries(draft)) {
        const entry = {
          rpm: toLimitOrUndefined(limits.rpm),
          rpd: toLimitOrUndefined(limits.rpd),
          tpm: toLimitOrUndefined(limits.tpm),
          tpd: toLimitOrUndefined(limits.tpd),
        };
        // A model with every field blank is unlimited already — drop it instead
        // of persisting a no-op entry.
        if (entry.rpm || entry.rpd || entry.tpm || entry.tpd) next[model] = entry;
      }
      await onSave(next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title || "Rate Limits"}
      size="xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          Optional per-model caps for this key. Leave a field blank for unlimited.
        </p>

        {copyOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-black/10 p-2.5 dark:border-white/10">
            <span className="material-symbols-outlined text-text-muted text-[16px]">content_copy</span>
            <span className="text-xs text-text-muted">Copy config from:</span>
            <div className="flex flex-wrap gap-1.5">
              {copyOptions.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => handleCopyFrom(o.label)}
                  className="rounded-full border border-black/10 px-2.5 py-0.5 text-xs text-text-muted hover:border-primary hover:text-primary dark:border-white/10"
                  title={`Replace the draft below with ${o.label}'s config`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add Model kept at the top (not near the bottom, past the model list)
            so its dropdown always has room to render without being clipped by
            the modal body's own overflow-y-auto scroll boundary. */}
        <div className="flex gap-2">
          <div className="relative flex-1" ref={pickerRef}>
            <Input
              placeholder="Search or type a model id…"
              value={newModel}
              onChange={(e) => { setNewModel(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleAddModel(); }
                if (e.key === "Escape") setShowSuggestions(false);
              }}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg">
                {suggestions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleAddModel(m)}
                    className="block w-full truncate px-3 py-1.5 text-left font-mono text-sm text-text-main hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button onClick={() => handleAddModel()} variant="secondary" disabled={!newModel.trim()}>
            Add Model
          </Button>
        </div>

        {models.length === 0 && (
          <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
            <p className="text-xs text-text-muted">No models configured — unlimited for everything</p>
          </div>
        )}

        {models.length > 0 && (
          <div className="flex flex-col gap-3">
            {models.map((model) => (
              <div key={model} className="rounded-lg border border-black/10 p-3 dark:border-white/10">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <code className="truncate font-mono text-sm font-medium">{model}</code>
                  <button
                    onClick={() => handleRemoveModel(model)}
                    className="shrink-0 rounded p-1 text-text-muted hover:bg-red-500/10 hover:text-red-500"
                    title="Remove"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {FIELDS.map((f) => (
                    <Input
                      key={f.key}
                      label={f.label}
                      type="number"
                      min="1"
                      placeholder="∞"
                      value={draft[model][f.key]}
                      onChange={(e) => handleFieldChange(model, f.key, e.target.value)}
                      hint={f.hint}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

RateLimitsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  title: PropTypes.string,
  limits: PropTypes.object,
  modelOptions: PropTypes.arrayOf(PropTypes.string),
  copyOptions: PropTypes.arrayOf(PropTypes.shape({
    label: PropTypes.string.isRequired,
    limits: PropTypes.object,
  })),
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
};
