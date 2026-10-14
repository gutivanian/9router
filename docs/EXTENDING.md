# Extending 9Router — practical recipes

Three concrete how-tos for the app-layer (`src/`), written as the companion to
the two docs that already exist:

- `docs/ARCHITECTURE.md` — the full system explained (read this to understand
  *why* things are structured this way).
- `open-sse/AGENTS.md` — the routing/translation **engine**'s own conventions:
  adding a provider's registry entry, a non-standard executor, or a translator.
  **Read it before touching anything under `open-sse/`** — this doc doesn't
  repeat it, only covers the `src/` (Next.js app) side that AGENTS.md doesn't.

All three recipes below are written from real changes made in this codebase —
each one names the actual commit-worthy files so you can diff against a real
example instead of a toy one.

---

## 1. Adding a new API endpoint

Every `/v1/*` and `/api/*` route is a thin Next.js route handler that
delegates immediately to a handler function in `src/sse/handlers/*.js`. The
route file itself should stay boring — auth, CORS, and delegation only;
business logic lives in the handler.

### The pattern

```js
// src/app/api/v1/audio/transcriptions/route.js
import { handleStt } from "@/sse/handlers/stt.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  return await handleStt(request);
}
```

Steps for a brand new endpoint:

1. Create `src/app/api/v1/<your-path>/route.js` following the shape above.
   Next's file-based routing maps the folder path directly to the URL — no
   registration step.
2. Write the real logic in `src/sse/handlers/<yourKind>.js`: parse the
   request, enforce the API-key check if required
   (`extractApiKey`/`isValidApiKey` from `../services/auth.js`), resolve
   `model` via `getModelInfo()` (`../services/model.js`), run the
   provider-credential fallback loop (`getProviderCredentials` /
   `markAccountUnavailable`, same pattern in every handler under
   `src/sse/handlers/`), and return a `Response`.
3. **Auth is automatic, don't add it yourself.** `src/dashboardGuard.js`'s
   `proxy()` denies every `/api/*` path by default unless it's in
   `PUBLIC_API_PATHS` (the public LLM API itself, login, health, etc.) — so a
   new `/api/*` route is dashboard-session-gated the instant you create it,
   with zero extra code. Only touch `dashboardGuard.js` if your route should
   be **public** (add to `PUBLIC_API_PATHS`) or **local-machine-only**
   (`LOCAL_ONLY_PATHS`). (`PROTECTED_API_PATHS` in that file is dead code —
   declared, never read — don't bother adding to it.)
4. If the endpoint should support **combos** (a named group of models with
   fallback/round-robin/adaptive rotation), wire it the same way every other
   modality did — see the worked example below.

### Worked example: adding combo support to a modality handler

This is the exact diff shape used to add combo support to STT, embeddings,
and video generation (`src/sse/handlers/stt.js`, `embeddings.js`,
`videoGeneration.js`) — copy this pattern for any new modality handler that
takes a `model` field:

```js
import { getComboModels } from "../services/model.js";
import { handleComboChat } from "open-sse/services/combo.js";

export async function handleYourThing(request) {
  // ...parse request, validate, extract modelStr...

  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    return handleComboChat({
      body,                              // used for capability auto-switch detection; {} if not applicable
      models: comboModels,
      handleSingleModel: (b, m) => handleYourThingSingle(b, m),  // same signature, one concrete model
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit: settings.comboStickyRoundRobinLimit,
    });
  }

  return handleYourThingSingle(body, modelStr);
}
```

`handleComboChat` (in `open-sse/services/combo.js`) handles the rotation
strategy (`fallback` / `round-robin` / `adaptive`), per-model health tracking,
and falls through to the next model on a retryable error — your
`handleSingleModel` just needs to do one concrete model and return a
`Response`, success or failure, same as it already does standalone.

If the request body isn't plain JSON (multipart form, raw bytes), build a
fresh copy with the model substituted before re-invoking the single-model
path per combo attempt — see `cloneFormWithModel()` in `stt.js` or
`withModel()` in `videoGeneration.js` for the two existing shapes of this.

Once the backend accepts combo names for your modality, also add it to
`COMBO_KINDS` in
`src/app/(dashboard)/dashboard/media-providers/[kind]/page.js` so the
dashboard's "Create Combo" button appears for that kind — the UI and the
backend are two independent switches, both have to be on.

---

## 2. Connecting a new AI provider

`open-sse/AGENTS.md` covers the engine side (registry entry, executor,
translator) — do that first. This section is everything on top of that which
only matters to the dashboard app:

### Feature flags on the registry entry (`open-sse/providers/registry/{id}.js`)

These drive dashboard behavior and are read via `src/shared/constants/providers.js`:

| Field | Effect |
|---|---|
| `features: { usage: true }` | Provider gets a card on the **Quota Tracker** page, fetching live quota from the provider's own API (`src/app/api/usage/[connectionId]/route.js` → `open-sse/services/usage.js`). Only set this if the provider actually has a quota-reporting endpoint. |
| `features: { usageApikey: true }` | Combined with `usage`, also shows API-key-auth connections (not just OAuth) on Quota Tracker. |
| `quotaReset: { timezone, hour }` | Default daily reset time for that provider's RPM/RPD/TPM/TPD rate-limit tracker (`src/lib/rateLimits.js`) — e.g. Gemini resets at `{ timezone: "America/Los_Angeles", hour: 0 }`. Omit it and the tracker falls back to a rolling 24h window; users can still override it per-provider from the "Daily reset" button on that provider's page regardless of whether this default exists. |
| `serviceKinds: [...]` | Which media kinds this provider supports (`"llm"`, `"embedding"`, `"image"`, `"imageToText"`, `"tts"`, `"stt"`, `"webSearch"`). Drives whether it shows up on each `/dashboard/media-providers/<kind>` listing page. |
| `mediaPriority` | Sort order on media-provider listing pages (lower = earlier). |

Every provider with `features.usage` (or any rate limit configured) shows up
automatically on Quota Tracker and the provider detail page's connection
rows (`src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js` +
`src/shared/components/RateLimitUsageTable.js`) — nothing to wire by hand
there, it's all derived from the connection's own `rateLimits` and the
registry.

### OAuth connect flow

If the provider's `transport.auth.oauth` follows the standard flow (the
engine's own `OAuthModal` handles the redirect/callback/token-exchange), you
don't need to touch the dashboard at all — `OAuthModal` reads the registry's
`transport.clientId`/`clientSecret`/scopes generically.

Only add a bespoke modal if the provider's auth is genuinely non-standard
(device code, protobuf handshake, cookie-based, CLI-token import — see
`KiroOAuthWrapper`, `CursorAuthModal`, `GitLabAuthModal`, `IFlowCookieModal` in
`src/shared/components/`). Wire it into the provider detail page's modal
switch:

```js
// src/app/(dashboard)/dashboard/providers/[id]/page.js
{providerId === "kiro" ? (
  <KiroOAuthWrapper isOpen={showOAuthModal} providerInfo={providerInfo} onSuccess={handleOAuthSuccess} onClose={...} />
) : providerId === "your-new-provider" ? (
  <YourBespokeAuthModal isOpen={showOAuthModal} onSuccess={handleOAuthSuccess} onClose={...} />
) : (
  <OAuthModal isOpen={showOAuthModal} provider={providerId} providerInfo={providerInfo} onSuccess={handleOAuthSuccess} onClose={...} />
)}
```

It's a hardcoded `providerId === "..."` chain, not a registry — that's
intentional, since a bespoke flow is the exception, not the rule.

---

## 3. Reading/writing data (the DB repo layer)

`src/lib/db/` is a small SQLite layer: `schema.js` (table definitions) →
migrations (schema changes on existing installs) → `repos/*.js` (one file per
entity, the only code that writes SQL) → `src/lib/db/index.js` (re-exports
everything) → `src/lib/localDb.js` (backward-compat shim some older code
still imports from — new code should import from `@/lib/db/index.js`
directly).

### Adding a new table

1. Add it to `TABLES` in `src/lib/db/schema.js`:
   ```js
   myNewTable: {
     columns: {
       id: "INTEGER PRIMARY KEY AUTOINCREMENT",
       someField: "TEXT",
       createdAt: "TEXT NOT NULL",
     },
     indexes: ["CREATE INDEX IF NOT EXISTS idx_mnt_field ON myNewTable(someField)"],
   },
   ```
2. **That's it for a new table** — `migrate.js` does an "additive sync" at
   boot that creates any table/column/index declared in `TABLES` but missing
   from the DB. You only need a numbered migration in
   `src/lib/db/migrations/` for something additive sync can't express (e.g.
   backfilling data, dropping a column, changing a type) — see
   `001-initial.js` for the shape; append a new `{ version, name, up(db) }`
   entry to `MIGRATIONS` in `migrations/index.js`, never edit `001` itself.
3. Write a repo module, `src/lib/db/repos/myNewTableRepo.js`:
   ```js
   import { getAdapter } from "../driver.js";

   export async function listMyThings() {
     const db = await getAdapter();
     return db.all(`SELECT * FROM myNewTable ORDER BY createdAt DESC`);
   }

   export async function insertMyThing(entry) {
     const db = await getAdapter();
     db.run(`INSERT INTO myNewTable(someField, createdAt) VALUES(?, ?)`, [entry.someField, new Date().toISOString()]);
   }
   ```
   `db.all` / `db.get` / `db.run` / `db.transaction` is the whole surface —
   same adapter API regardless of which SQLite driver resolved
   (`better-sqlite3` / `node:sqlite` / `bun:sqlite` / `sql.js`, see
   `driver.js`'s fallback chain). Never reach for a driver-specific API.
4. Re-export what the rest of the app needs from `src/lib/db/index.js`
   (follow the existing `export { ... } from "./repos/xRepo.js"` blocks).

### The two row shapes already in use

Most existing tables use one of two shapes — match whichever fits:

- **Narrow table, typed columns** (e.g. `apiKeys`, `combos`): every field is
  its own column. Simple, but any new field needs a schema change.
- **Indexed-column + JSON blob** (e.g. `providerConnections`,
  `providerNodes`, `proxyPools`): a few columns that need to be queried/
  indexed (`provider`, `isActive`, …) are real columns, everything else lives
  JSON-stringified in a `data TEXT` column
  (`src/lib/db/helpers/jsonCol.js`'s `parseJson`/`stringifyJson`). This is
  why `connection.rateLimits`, `connection.providerSpecificData`, etc. can
  grow new nested fields freely without ever touching `schema.js` — they're
  just keys inside `data`.

### Settings (the one true global config object)

`settings` is a single-row key-value table (`id = 1`, one `data` JSON blob).
`src/lib/db/repos/settingsRepo.js`:
- `DEFAULT_SETTINGS` — add your new key's default here so `getSettings()`
  always returns it even on an old install that never set it explicitly.
- `getSettings()` — `{ ...DEFAULT_SETTINGS, ...stored }`, read-only.
- `updateSettings(patch)` — atomic read-modify-write inside a transaction,
  shallow-merges `patch` over the current stored object (one key at a time,
  not deep-merged) — matches what `PATCH /api/settings` does.

A new per-provider or per-group setting almost always ends up as
`settings.someMap[providerId]` or `settings.someMap[providerId][group]` (see
`groupRateLimits`, `providerResetSchedule`, `providerStrategies` for the
existing examples) rather than a new top-level key per provider.
