# CPQ to RCA: Migration Assessment

A Node.js + React web app for planning a move from **Salesforce CPQ** (`SBQQ__` managed package) to
**Revenue Cloud Advanced (RCA)**.

- **Step 1: accounts & secure org connections.** Sign up / sign in / password reset. Salesforce
  credentials are encrypted with AES-256-GCM before they reach PostgreSQL.
- **Step 2: CPQ assessment.**
  - **Multi-org:** store several orgs (Sandbox, UAT, Production…) and switch between them from the header.
  - **Catalog extraction:** discovers the CPQ schema in the org and extracts the full configuration
    catalog as a hierarchical JSON tree, with paginated, memory-bounded queries.
  - **Architecture dashboard:** catalog KPIs, a bundle explorer, and migration complexity flags.
  - **JSON export:** one click downloads the extracted catalog.
  - **AI assessment:** Google Gemini writes an RCA Migration Assessment, downloadable as a branded
    DOCX or PDF.

Transactional data (quotes, quote lines, subscriptions, orders) is **never** extracted.

| Layer | Choice |
| --- | --- |
| API | Node.js 22.18+, Express 5 (ESM). Step 2 services are TypeScript, run directly by Node's built-in type stripping (no build step) |
| UI | React 19, React Router 7, Tailwind CSS 4 (+ typography), react-markdown, built with Vite 7 |
| Data | PostgreSQL 16 + Prisma 6 |
| Salesforce | `jsforce` 3 (login, describe, query/queryMore, Tooling API), native `fetch` for OAuth Client Credentials |
| AI | `@google/genai`, `gemini-3.5-flash` by default with automatic fallback to other Gemini models |
| Documents | `docx` (Word) and `pdfkit` + DejaVu fonts (PDF), Markdown parsed with `marked` |
| Security | `bcrypt`, JWT in an `httpOnly` cookie, AES-256-GCM secrets, `helmet`, rate limiting, SSRF host allow-list, per-user ownership checks on every resource |

---

## Project structure

```
.
├── client/                          React SPA (served by Express in production)
│   ├── public/                      StreamForce logo.png + favicon
│   └── src/
│       ├── api.js                   fetch wrapper (cookie session, error/field mapping)
│       ├── auth.jsx                 AuthProvider + RequireAuth / GuestOnly route guards
│       ├── org.jsx                  OrgProvider: connections + active org (multi-org state)
│       ├── components/
│       │   ├── AppShell.jsx         Header with logo + Org Switcher dropdown
│       │   ├── ConnectionForm.jsx   Add/edit org (alias, environment, Option A/B credentials)
│       │   └── cpq/                 ExtractionProgress, KpiGrid, ComplexityPanel, Distributions,
│       │                            InventoryTable (Overview.jsx), BundleExplorer, AssessmentPanel
│       └── pages/                   Login, Register, ForgotPassword, ResetPassword,
│                                    Dashboard (assessment workspace), Connections
├── prisma/
│   ├── schema.prisma                User 1:N SalesforceConnection, CatalogExtraction,
│   │                                AssessmentReport, PasswordResetToken
│   └── migrations/                  SQL migrations (applied with `prisma migrate deploy`)
├── server/
│   ├── index.js / app.js            Entry point, Express app, stale-job janitor
│   ├── config.js / db.js / validators.js
│   ├── lib/                         crypto (AES-256-GCM), salesforce (connect/test + SSRF guard), mailer
│   ├── middleware/                  requireAuth, error handler
│   ├── routes/                      auth, salesforce (connections), cpq, branding
│   └── services/
│       ├── connection.service.js    Multi-org CRUD, encryption, active org
│       ├── cpqSchema.ts             CPQ setup-object registry (what to extract and why)
│       ├── cpqCatalogExtractor.ts   Schema inspection, paginated extraction, hierarchy builder, gzip serializer
│       ├── cpqAnalysis.ts           KPIs, distributions, migration complexity flags
│       ├── cpqJobs.ts               Background jobs (extraction, AI), progress, heartbeat, catalog cache
│       ├── geminiService.ts         Catalog digest, RCA prompt, streaming generation
│       ├── docGenerator.ts          Markdown → branded DOCX / PDF
│       ├── branding.js              Document logo (custom upload or company default)
│       └── testing/                 Synthetic CPQ org + sample report (tests, demo mode)
├── scripts/                         gen-secrets.js, seed-demo.js, bench-extractor.ts
├── tsconfig.json                    Type-checking only (`npm run typecheck`)
├── Dockerfile / docker-entrypoint.sh / docker-compose.yml
```

---

## How the CPQ assessment works

### 1. Multi-org connections

`User 1 ── N SalesforceConnection` (`name`, `environmentType`, `orgId`, `encryptedCredentials`,
`lastVerified`, plus non-secret metadata). Each connection is tested against Salesforce before it is
saved. The active org is stored on the user (`activeConnectionId`), so the org switcher choice
survives logout. Upgrading from Step 1 keeps existing credentials: the migration turns each user's
saved credential into their first connection and makes it active.

### 2. Schema discovery & extraction (`cpqCatalogExtractor.ts`)

1. **Inspect:** `describeGlobal()` lists the org's objects. Each CPQ setup object in the registry
   (`cpqSchema.ts`) is matched, other non-transactional `SBQQ__*` objects are counted, and missing
   ones are reported (older package versions).
2. **Pick fields:** `describe()` per object. All fields are read, including custom fields like
   `Product2.Custom_Attribute__c`, because RCA attribute mapping needs them. The exceptions:
   - Omitted: system/audit fields (`CreatedDate`, `LastModifiedById`, `SystemModstamp`, `OwnerId`…),
     binary and compound fields, and QCP's `SBQQ__TranspiledCode__c`.
   - Relationship fields are resolved per org from candidate names, falling back to a unique lookup
     to the expected target object, so package-version differences don't break the SOQL.
3. **Extract:** `SELECT COUNT()` first (for progress), then cursor pagination (`query` +
   `queryMore`) consumed as an async generator. The next page is only requested after the current
   page is processed, so there is **one page in flight**: backpressure without unbounded buffers.
   Records are slimmed on arrival (no `attributes`, no null fields). Transient errors are retried
   with backoff. A per-object cap (`CPQ_MAX_RECORDS_PER_OBJECT`) is a final safety net, and capped
   objects are flagged.
4. **Assemble** a normalized hierarchy: `Product → Features → Options → Child Products (→ nested
   bundles)`, with option constraints, configuration attributes and rules attached. Every record
   appears once (no duplication for shared sub-bundles); `links` holds resolved parent Ids. Bundle
   depth uses a memoized DFS with **cycle detection**.
5. **Serialize** the tree straight into gzip, element by element, honouring stream backpressure.
   It is never built as one giant JSON string. The gzip blob is stored on the extraction row, which
   works across instances with no shared disk.

**Measured** with the synthetic org under `node --max-old-space-size=512` (`npm run bench:extractor`):

| Catalog | Peak heap | JSON | Stored (gzip) | Extract + serialize |
| --- | --- | --- | --- | --- |
| 15,000 products · 3,000 bundles · 18,000 options · 30,000 PBEs | 86 MB | 23.8 MB | 1.3 MB | ~1 s |
| 60,000 products · 10,000 bundles · 60,000 options · 120,000 PBEs | 212 MB | 85.8 MB | 4.5 MB | ~3 s |

Against a real org, Salesforce API round-trips dominate (≈2,000 records per page).

**Objects extracted**

| Category | Objects |
| --- | --- |
| Catalog & Products | `Product2`, `Pricebook2`, `PricebookEntry` |
| Bundle & Configuration | `SBQQ__ProductFeature__c`, `SBQQ__ProductOption__c`, `SBQQ__OptionConstraint__c`, `SBQQ__ConfigurationAttribute__c`, `SBQQ__Dimension__c` (MDQ) |
| Rules & Constraints | `SBQQ__ProductRule__c`, `SBQQ__ErrorCondition__c`, `SBQQ__ProductAction__c`, `SBQQ__ConfigurationRule__c`, `SBQQ__LookupQuery__c`, `SBQQ__SummaryVariable__c` |
| Pricing Engine & Schedules | `SBQQ__PriceRule__c`, `SBQQ__PriceCondition__c`, `SBQQ__PriceAction__c`, `SBQQ__DiscountSchedule__c`, `SBQQ__DiscountTier__c`, `SBQQ__BlockPrice__c`, `SBQQ__Cost__c`, `SBQQ__ContractedPrice__c` (count only) |
| Custom Options & QCP | `SBQQ__CustomScript__c` (QCP source), `SBQQ__Plugins__c` (active plugin settings), `SBQQ__CustomAction__c`, `SBQQ__CustomActionCondition__c`, `SBQQ__SearchFilter__c`, `SBQQ__QuoteProcess__c`, `SBQQ__ProcessInput__c` (guided selling) |
| **Excluded** | `SBQQ__Quote__c`, `SBQQ__QuoteLine__c`, `SBQQ__QuoteLineGroup__c`, `SBQQ__QuoteDocument__c`, `SBQQ__Subscription__c`, … (transactional) |

The CPQ package version is read from the Tooling API (`InstalledSubscriberPackage`) when the
integration user can view setup.

**Catalog JSON** (`schemaVersion: "cpq-rca-catalog/1"`), as downloaded:

```jsonc
{
  "source":    { "connectionName", "environmentType", "orgId", "instanceUrl", "cpqPackageVersion", "cpqInstalled" },
  "discovery": { "objects": [/* per object: present, recordCount, fields, relationFields, rcaTarget */],
                 "otherCpqObjects": [], "excludedTransactionalObjects": [], "notes": [] },
  "summary":   { "kpis": {}, "distributions": {}, "complexity": { "score", "level", "flags": [] } },
  "catalog": {
    "pricebooks": [],
    "products": [{ "Id", "Name", "...fields", "pricing": { "pricebookEntries", "costs", "blockPrices" },
                   "bundle": { "levels", "features": [{ "...", "optionIds": [] }], "options": [],
                               "optionConstraints": [], "configurationAttributes": [], "configurationRules": [] } }],
    "bundleHierarchies": [/* nested Product → Feature → Option → Product trees, roots first */]
  },
  "rules":   { "productRules": [/* + errorConditions, actions, lookupQueries */],
               "priceRules":   [/* + conditions, actions, lookupQueries */], "summaryVariables": [] },
  "pricing": { "discountSchedules": [/* + tiers */], "contractedPriceCount": 0 },
  "customizations": { "customScripts": [], "pluginSettings": [], "customActions": [], "searchFilters": [], "guidedSelling": [] }
}
```

### 3. Dashboard & complexity indicators

- **KPIs:** Total Products, Active Bundles, Standalone SKUs, Pricing Rules, Product Rules, Discount
  Schedules (plus features, options, constraints, attributes, price book entries, summary variables,
  QCP scripts).
- **Bundle Architecture Explorer:** searchable/sortable bundle list. The collapsible tree shows
  features (selection method, min/max), options (type, required, default, quantity), nested child
  bundles, option constraints, applied product rules and configuration attributes.
- **Complexity indicators** (21 checks, each with RCA guidance and examples):
  - Bundle structure: deeply nested bundles (3+ tiers), circular bundle references, external
    configurator.
  - Custom logic: QCP / custom scripts (with the active plugin).
  - Rule complexity: lookup-driven rules, custom condition logic, rules with more than 5
    conditions or actions, price-action formulas, summary variables, selection and filter rules.
  - Pricing patterns: MDQ, percent-of-total, block, cost-plus, and account-specific pricing.
  - Also flagged: option constraints, dynamic features, inactive-rule clean-up, catalog volume,
    and unreadable objects.
  - A severity-weighted score (0–100) gives the overall level: Low, Medium, High or Very High.

### 4. AI assessment (`geminiService.ts`, `docGenerator.ts`)

- The full catalog can be far larger than any prompt. Gemini gets a **bounded digest** (≤ ~600k
  characters, shrunk automatically when needed) containing:
  - all KPIs, distributions, flags and the object inventory
  - the most complex bundles (with options)
  - price and product rules with their conditions and actions
  - summary variables, discount tiers, and QCP excerpts with the methods they implement
- Tokens are counted (`countTokens`) before sending, then the report is **streamed**
  (`generateContentStream`) with live progress.
- The prompt enforces these sections:
  - Executive Overview & Catalog Footprint
  - RCA Mapping Matrix: CPQ construct → RCA equivalent, e.g. bundles → Product Structures / dynamic
    bundles, price rules → Pricing Procedures + Expression Sets, lookups → Decision Tables
  - Modernization & Gap Analysis
  - Phased Migration Strategy
  - Risks / Assumptions / Open Questions
- Gemini is told to use only the numbers provided.
- **Documents:**
  - Markdown → DOCX (`docx`) or PDF (`pdfkit`) with:
    - a cover page and a logo + title header on every page
    - "Page X of Y" footers and styled tables that repeat their header row across page breaks
  - A deterministic **appendix** (KPIs, complexity flags, object inventory) generated from the
    extraction itself, so the key numbers never depend on the model.
- **Logo:** `client/public/logo.png` (StreamForce) by default. Each user can upload their own
  PNG/JPEG (≤ 2 MB, validated by file signature) in the assessment panel.
- Only the digest is sent to Google, never credentials.

Extractions and AI generation run as **background jobs**: the API returns `202` and the UI polls.
This sidesteps load-balancer / App Runner request timeouts. Workers refresh a heartbeat every 15 s;
a janitor marks jobs with a stale heartbeat as failed. That is safe with several app instances.

---

## API

All responses are JSON. Errors look like `{ "error": "message", "fields": { "fieldName": "message" } }`.
Every resource is scoped to the signed-in user (other users' ids return 404).

**Auth**

| Method & path | Purpose |
| --- | --- |
| `POST /api/auth/register` | `{ email, username, password }` → creates user, sets session cookie |
| `POST /api/auth/login` | `{ identifier, password }` (email **or** username) |
| `POST /api/auth/logout` · `GET /api/auth/me` | Sign out · current user |
| `POST /api/auth/forgot-password` | `{ email }` → single-use reset link (always 200) |
| `POST /api/auth/reset-password` | `{ token, password }` → new password, signs out all sessions |

**Salesforce connections (multi-org)**

| Method & path | Purpose |
| --- | --- |
| `GET  /api/salesforce/connections` | All connections (metadata + `hasPassword`-style flags, never secrets) and `activeConnectionId` |
| `POST /api/salesforce/connections` | `{ name, environmentType, ...credentials }` → tested, then encrypted + saved. First one becomes active |
| `PUT  /api/salesforce/connections/:id` | Update; blank secret fields keep the saved values; re-tested before saving |
| `DELETE /api/salesforce/connections/:id` | Delete (cascades to its extractions and reports) |
| `POST /api/salesforce/connections/:id/activate` | Org switcher |
| `POST /api/salesforce/connections/:id/test` | Re-test saved credentials and record the status |
| `POST /api/salesforce/test` | Test form credentials without saving (`connectionId` optional, to reuse saved secrets) |

`environmentType`: `PRODUCTION`, `SANDBOX`, `UAT`, `DEVELOPER`, `OTHER`. Credentials:

```jsonc
// Option A – Username + Password + Security Token
{ "authType": "USERNAME_PASSWORD", "loginUrl": "https://login.salesforce.com",
  "username": "admin@acme.com", "password": "…", "securityToken": "…" }

// Option B – Connected App, OAuth 2.0 Client Credentials flow
{ "authType": "OAUTH_CLIENT_CREDENTIALS", "tokenUrl": "https://acme.my.salesforce.com",
  "clientId": "3MVG…", "clientSecret": "…" }
```

**CPQ assessment**

| Method & path | Purpose |
| --- | --- |
| `POST /api/cpq/extract-catalog` | `{ connectionId?, includeInactive? }` → `202` job (defaults to the active org). `409` if one is already running for that org |
| `GET  /api/cpq/extractions?connectionId=` | Extraction history |
| `GET  /api/cpq/extractions/:id` | Status, live per-object progress, and summary (KPIs, flags, inventory) |
| `DELETE /api/cpq/extractions/:id` | Delete a finished extraction |
| `GET  /api/cpq/extractions/:id/bundles?q=&sort=levels\|options\|name&offset=&limit=` | Bundle list for the explorer |
| `GET  /api/cpq/extractions/:id/bundles/:productId` | Nested bundle tree |
| `GET  /api/cpq/download-catalog-json?extractionId=` | Download the hierarchical catalog JSON (sent gzip-encoded) |
| `GET  /api/cpq/status` | `{ geminiConfigured, geminiModel }` |
| `POST /api/cpq/generate-assessment` | `{ extractionId }` → `202` job. `503` if `GEMINI_API_KEY` is not set |
| `GET  /api/cpq/assessments?extractionId=` · `GET /api/cpq/assessments/:id` | Report history · status, progress, Markdown |
| `GET  /api/cpq/assessments/:id/document?format=docx\|pdf` | Download the branded document |
| `GET/PUT/DELETE /api/branding/logo` · `GET /api/branding/logo/info` | Document logo (`PUT` body: raw `image/png` or `image/jpeg`) |
| `GET  /healthz` | Liveness + DB check |

### Security design

- **Passwords:** bcrypt (12 rounds); login runs a dummy compare for unknown users to avoid timing-based user enumeration.
- **Sessions:** HS256 JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` when `APP_URL` is https). Each user has a `tokenVersion`; a password reset increments it, which invalidates every existing session.
- **Reset tokens:** 32 random bytes, only the SHA-256 hash is stored, 30-minute expiry, single use (redeemed in a transaction), older tokens are deleted when a new one is issued.
- **Salesforce secrets:** password/security token/client secret are serialized and encrypted with AES-256-GCM (random 12-byte IV, auth tag, `userId` as AAD so a ciphertext can't be moved to another user). Format `v1:<iv>:<tag>:<ciphertext>`. Secrets are **never** returned to the browser; the API only returns `hasPassword`-style flags.
- **SSRF guard:** user-supplied Login/Token URLs, and the instance URL Salesforce returns, must be `https` and on a Salesforce domain (`*.salesforce.com`, `*.force.com`, …; configurable via `SF_ALLOWED_HOST_SUFFIXES`).
- **Read-only org access:** extraction only runs `describe`, `SELECT` and a Tooling API `SELECT`; nothing is written to Salesforce.
- **Rate limits:** 20 auth requests / 15 min per IP; 15 Salesforce tests / min per user; 20 jobs / 10 min per user; max 2 concurrent extractions per instance.

> **Keep `ENCRYPTION_KEY` stable.** Store it in Secrets Manager and back it up. If it changes, secrets
> saved under the old key can't be decrypted. The app then flags those connections at startup, blocks
> extraction with *"Stored credentials could not be decrypted. Please re-enter and save your Salesforce
> connection."*, and shows a **Re-enter credentials** button.

**Ciphertext format:** `v2:<keyId>:<iv>:<authTag>:<data>` (base64 parts; `keyId` = first 8 hex chars of
SHA-256(key), not secret). Legacy `v1:<iv>:<authTag>:<data>` values from Step 1 are still read and
upgraded on use. IV (12 bytes) and tag (16 bytes) lengths are validated before decrypting.

**Rotating the key without re-entering credentials:**

1. Generate a new key (`npm run gen:secrets`).
2. Set the new value as `ENCRYPTION_KEY` and the old one as `ENCRYPTION_KEY_PREVIOUS` (comma-separate
   several old keys if needed).
3. Restart. Secrets are decrypted with the old key and re-encrypted with the new one when next used.
   The startup scan touches every connection, so most are upgraded immediately.
4. Remove `ENCRYPTION_KEY_PREVIOUS` once the startup log no longer reports undecryptable connections.

---

## Prerequisites

Install these before running the app locally.

| Requirement | Version | Needed for | Get it | Check it |
| --- | --- | --- | --- | --- |
| **Node.js** (includes npm) | **22.18** or newer (24 LTS recommended) | Running the app; 22.18+ runs the TypeScript services natively | <https://nodejs.org> (LTS installer) | `node -v` and `npm -v` |
| **Git** | any recent | Cloning the repo | <https://git-scm.com> | `git --version` |
| **Docker Desktop** | 4.x (Docker Engine 24+) | The local PostgreSQL database (and optionally running the whole app in containers) | <https://www.docker.com/products/docker-desktop> | `docker info` |
| **WSL 2** (Windows only) | WSL 2 | Docker Desktop needs it to run Linux containers on Windows | Admin PowerShell: `wsl --install`, then restart | `wsl -l -v` (shows `docker-desktop` with VERSION 2) |
| **PostgreSQL** | 14 or newer | The database. Docker provides PostgreSQL 16 automatically; a native install is only needed if you don't use Docker | Included via Docker, or <https://www.postgresql.org/download/> | `docker compose ps` (Docker) or `psql --version` (native) |
| **Salesforce org** with CPQ | any edition with API access + the Salesforce CPQ (SBQQ) package | Connecting orgs and extracting the CPQ catalog. Not needed to try the UI: see *Try it without Salesforce* | A CPQ sandbox, or a CPQ trial org | Log in to the org in a browser |
| **Gemini API key** (optional) | Gemini Developer API key from AI Studio | The AI migration assessment document. Everything else works without it | <https://aistudio.google.com/apikey> | Generate a report in the dashboard |
| AWS CLI v2 (optional) | 2.x | Only for the AWS deployment section | <https://aws.amazon.com/cli/> | `aws --version` |

No global npm packages are needed. Prisma, Vite and the rest are installed into `node_modules` by `npm install`.

> **Windows shells:** the commands below work in **Git Bash** and **PowerShell** unless a PowerShell
> alternative is shown.

---

## Run locally

Quick version, once the prerequisites are installed:

```bash
npm install
```
```bash
cp .env.example .env
```
```bash
npm run gen:secrets
```

Paste the two printed lines into `.env`, then:

```bash
docker compose up -d db
```
```bash
npx prisma generate
```
```bash
npx prisma migrate deploy
```
```bash
npm run dev
```

Open <http://localhost:3000>. Each step is explained below.

### 1. Get the code and install packages

```bash
git clone <repo-url> SF-CPQ-DOC_Extraction
```
```bash
cd SF-CPQ-DOC_Extraction
```
```bash
npm install
```

### 2. Create your `.env` file

Copy the template (Git Bash / macOS / Linux):

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Generate the two secrets:

```bash
npm run gen:secrets
```

This prints a `JWT_SECRET=…` line and an `ENCRYPTION_KEY=…` line. Replace the placeholder lines in
`.env` with them. Everything else already matches the Docker database, so a local `.env` looks like this:

```dotenv
PORT=3000
NODE_ENV=development
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://user:password@localhost:5433/cpq_rca
JWT_SECRET=<printed value>
ENCRYPTION_KEY=<printed value>
SMTP_HOST=
GEMINI_API_KEY=<your key, optional>
GEMINI_MODEL=gemini-3.5-flash
```

`GEMINI_API_KEY` enables the AI assessment document. Without it, the app works fully but the
"Generate Assessment Document" button stays disabled with a hint.

> `.env` is git-ignored. Keep your `ENCRYPTION_KEY`: if it changes, Salesforce credentials already
> saved in your local database can no longer be decrypted and have to be re-entered.

### 3. Start PostgreSQL

**Option A: Docker (recommended).** Make sure Docker Desktop is running (whale icon in the system
tray), then:

```bash
docker compose up -d db
```

This starts `postgres:16-alpine` with user `user`, password `password` and database `cpq_rca`. Data
is kept in the `pgdata` Docker volume between restarts. Check that it's healthy:

```bash
docker compose ps
```

> **Why port 5433?** Inside the container PostgreSQL listens on 5432, but it's published on host port
> **5433** so it doesn't clash with a natively installed PostgreSQL (which usually owns 5432 on
> Windows). If both used 5432, the app could connect to the wrong server and fail with
> `password authentication failed for user "user"`.

**Option B: a native PostgreSQL install (no Docker).** Open `psql` as the `postgres` superuser
(Windows: *SQL Shell (psql)* from the Start menu), then run:

```sql
CREATE USER "user" WITH PASSWORD 'password';
CREATE DATABASE cpq_rca OWNER "user";
```

Then change the port in `DATABASE_URL` in `.env` to `5432`:

```dotenv
DATABASE_URL=postgresql://user:password@localhost:5432/cpq_rca
```

### 4. Create the database tables

```bash
npx prisma generate
```
```bash
npx prisma migrate deploy
```

`prisma generate` builds the database client into `node_modules`. `npm install` normally does this
automatically, but newer npm versions (11+) can skip install scripts, so run it yourself to be safe.
`prisma migrate deploy` applies the SQL in `prisma/migrations/` and is safe to re-run.

### 5. Start the app

```bash
npm run dev
```

Open <http://localhost:3000>, create an account, and you land on the Salesforce connection dashboard.

In development, Vite runs inside Express, so the UI and API share port 3000. UI changes show up in the
browser instantly, and the server restarts automatically when files in `server/` change.

**Password-reset emails locally:** leave `SMTP_HOST` empty and the reset link is printed in the
terminal running `npm run dev`; copy it into the browser. To send real emails, fill in the `SMTP_*`
values (Mailtrap, MailHog or Amazon SES all work).

### Day-to-day

| Task | Command |
| --- | --- |
| Start the database | `docker compose up -d db` |
| Start the app | `npm run dev` |
| Stop the app | `Ctrl+C` in its terminal |
| Stop the database (data is kept) | `docker compose stop db` |
| Delete the database **and all its data** | `docker compose down -v` |
| Browse the data in a web UI | `npm run db:studio` (Salesforce secrets appear encrypted) |
| Create a migration after editing `prisma/schema.prisma` | `npm run db:migrate -- --name <change>` |
| Run the unit tests | `npm test` |
| Type-check the TypeScript services | `npm run typecheck` |
| Benchmark the extractor at scale | `npm run bench:extractor -- 60000 10000` (products, bundles) |
| Create the demo user | `npm run seed:demo` |

### Try it without Salesforce (demo mode)

To explore the dashboard without a CPQ org, use the built-in synthetic CPQ org. It has 3,000
products and 300 bundles, including nested bundles, a circular reference, rules, discount
schedules and a QCP script.

1. Add `CPQ_DEMO_ORG=true` to `.env`, then restart `npm run dev`.
2. Create the demo user with two connections (Acme UAT and Acme Production):

```bash
npm run seed:demo
```

3. Sign in as `demo`; the password is in `scripts/seed-demo.js`. Then click **Extract CPQ catalog**.

Demo mode is ignored when `NODE_ENV=production`. Remove the line from `.env` before connecting real
orgs: while it's on, *every* extraction uses the synthetic org.

### Other ways to run

**Production build without Docker:**

```bash
npm run build
```

Then set `NODE_ENV=production` in `.env` and run:

```bash
npm start
```

The UI is served from `client/dist`. Set `NODE_ENV` back to `development` before using `npm run dev` again.

**Everything in Docker** (database + production image of the app):

```bash
docker compose --profile app up --build
```

This builds the image, waits for the database, applies migrations and serves on
<http://localhost:3000>. `JWT_SECRET` and `ENCRYPTION_KEY` come from `.env`. Stop `npm run dev` first,
since both use port 3000. Stop the containers with `Ctrl+C` or `docker compose --profile app down`.

### Tests

```bash
npm test
```

25 tests, no database or network needed:

- **Crypto and URLs:** the AES-256-GCM utility (round-trip, tamper detection, AAD binding) and the
  Salesforce URL allow-list.
- **Catalog extractor, run against the synthetic CPQ org:**
  - pagination with one page in flight, and system-field omission
  - the Product → Feature → Option → nested bundle hierarchy, tier counting and cycle detection
  - rules, conditions and discount tiers attached to their parents
  - KPIs and complexity flags, active-only filtering and the per-object record cap
  - a gzip round-trip, and relationship-field fallback
- **Document generator:** Markdown parsing, DOCX/PDF rendering with the logo, and tables breaking
  across PDF pages.

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `failed to connect to the docker API … dockerDesktopLinuxEngine` | Docker Desktop isn't running. Start it and wait until it shows *Engine running*. On Windows, WSL 2 must be installed (`wsl --install`). |
| `password authentication failed for user "user"` | The app reached a different PostgreSQL than you expect, usually a native install on 5432. Make sure the port in `DATABASE_URL` matches the database you started (5433 for Docker). |
| `Can't reach database server at localhost:5433` | The database container isn't running: `docker compose up -d db`, then `docker compose ps`. |
| `The requested module '@prisma/client' does not provide an export named 'PrismaClient'` | The Prisma client wasn't generated: `npx prisma generate`. |
| `Missing required environment variable` or `ENCRYPTION_KEY must be 64 hex characters` on startup | `.env` is missing or still has placeholders: run `npm run gen:secrets` and paste the values. |
| `EADDRINUSE: address already in use :::3000` | Something else is on port 3000 (often a second `npm run dev` or the Docker `app` container). Stop it, or set `PORT` and `APP_URL` to another port. |
| `Bind for 0.0.0.0:5433 failed: port is already allocated` | Another program uses 5433. Change the host port in `docker-compose.yml` (for example `"5434:5432"`) and in `DATABASE_URL`. |
| `client/dist not found` warning in production mode | Run `npm run build` first, or use `npm run dev`. |
| Salesforce test fails with *Invalid username, password, security token* | Check the Login URL (production vs sandbox). Enter the security token in its own field; don't append it to the password. |
| Inventory shows `SBQQ__…` objects as *Not in org* | The CPQ package isn't installed, or the integration user lacks the CPQ permission set / license. See *Salesforce setup notes*. |
| An object shows an `error` badge in the inventory | The integration user can't read that object. Grant read access and run the extraction again; the error text is in the tooltip and in the *Objects that could not be read* flag. |
| "AI assessment is not configured" | Set `GEMINI_API_KEY` in `.env` and restart the server. |
| *Gemini rejected the API key* / *quota exceeded* | Check the key in Google AI Studio and your quota. |
| *…is no longer available to new users* / *No Gemini model could generate the report* | Google retires model versions for new keys (all `gemini-2.x` models return 404 for new keys as of Nov 2026). The app falls back automatically; if every model fails, the error lists each one tried with Google's reason. Set `GEMINI_MODEL` to a current model (see the Models page in AI Studio). |
| Report generation takes over 2 minutes | A model is overloaded (`503`) or stuck. It is abandoned after `GEMINI_FIRST_CHUNK_TIMEOUT_MS` and the next model is tried; the one that worked is reused for later reports. |
| Extraction fails with *Stored credentials could not be decrypted…* (formerly *Unsupported state or unable to authenticate data*) | `ENCRYPTION_KEY` changed after the credentials were saved. The startup log shows `[crypto] N of M Salesforce connection(s) cannot be decrypted`. **Fix:** Connections → **Re-enter credentials** (or Edit) → type the password + security token (or client secret) → **Save & Test Connection**. If you still have the old key, set it as `ENCRYPTION_KEY_PREVIOUS` instead and restart: everything is recovered automatically. Demo rows: `npm run seed:demo`. |
| `SyntaxError` / `Unknown file extension ".ts"` on startup | Node is older than 22.18. Upgrade Node (`node -v`). |
| An extraction stays *running* after a crash | Jobs with no heartbeat for 2 minutes are marked failed automatically within a minute; run it again. |

### Salesforce setup notes

**Integration user for extraction (read-only):** *API Enabled*, the *Salesforce CPQ* license/permission
set (or read access to all `SBQQ__*` objects listed above), read on Product2/Pricebook2/PricebookEntry,
and *View Setup and Configuration* (optional, lets the app read the CPQ package version). Use a
dedicated integration user; the app never writes to Salesforce.


- **Option A (Username/Password):** use `https://login.salesforce.com` (production), `https://test.salesforce.com` (sandbox) or your My Domain. The security token comes from *Settings → Reset My Security Token*; it can be blank if your IP range is trusted. SOAP API login must be enabled for the org/user.
- **Option B (Connected App):** create a Connected App (or External Client App) with OAuth enabled, tick **Enable Client Credentials Flow**, and set a **Run As** user under *Manage → Edit Policies*. Use the org's **My Domain** URL as the Token URL (`login.salesforce.com` doesn't support this flow). `/services/oauth2/token` is appended automatically.

---

## AWS deployment

The image is a standard stateless HTTP container listening on `$PORT` (3000). It needs a PostgreSQL
database and four secrets. Two supported targets are below; both use **Amazon RDS for PostgreSQL**
(Aurora Serverless v2 or Neon work the same way, only `DATABASE_URL` changes).

### 1. Build and push the image to ECR

```bash
aws ecr create-repository --repository-name cpq-to-rca
```

```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
```

```bash
docker build --platform linux/amd64 -t <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cpq-to-rca:v1 .
```

```bash
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cpq-to-rca:v1
```

### 2. Create the database (RDS PostgreSQL)

1. Create a VPC (or use an existing one) with **private subnets** for RDS.
2. RDS → *Create database* → PostgreSQL 16, `db.t4g.micro` (dev) or larger, **not publicly accessible**, storage encryption on, automated backups on. Initial database name: `cpq_rca`.
3. Security group `rds-sg`: allow inbound **5432 only from the app's security group** (ECS tasks, or the App Runner VPC connector).
4. Connection string (RDS enforces TLS by default):
   `postgresql://<user>:<password>@<endpoint>:5432/cpq_rca?sslmode=require&connection_limit=5`

### 3. Store secrets

Use **Secrets Manager** for the sensitive values (or SSM Parameter Store `SecureString`, which also works with both App Runner and ECS):

```bash
aws secretsmanager create-secret --name cpq-rca/DATABASE_URL --secret-string "postgresql://...?...sslmode=require"
```

```bash
aws secretsmanager create-secret --name cpq-rca/JWT_SECRET --secret-string "$(openssl rand -base64 48)"
```

```bash
aws secretsmanager create-secret --name cpq-rca/ENCRYPTION_KEY --secret-string "$(openssl rand -hex 32)"
```

```bash
aws secretsmanager create-secret --name cpq-rca/SMTP_PASS --secret-string "<smtp password>"
```

```bash
aws secretsmanager create-secret --name cpq-rca/GEMINI_API_KEY --secret-string "<gemini api key>"
```

> Back up `ENCRYPTION_KEY`; losing it means users must re-enter Salesforce credentials. Optionally
> enable Secrets Manager replication to a second region.

Plain (non-secret) environment variables: `NODE_ENV=production`, `PORT=3000`,
`APP_URL=https://<your-domain>`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`.
For Amazon SES SMTP: `SMTP_HOST=email-smtp.<region>.amazonaws.com`, `SMTP_PORT=587`, and SES SMTP credentials.

### Option A: AWS App Runner (simplest)

1. **IAM:**
   - *ECR access role* (`AWSAppRunnerServicePolicyForECRAccess`) so App Runner can pull the image.
   - *Instance role* with `secretsmanager:GetSecretValue` (and `kms:Decrypt` if you use a CMK) on `arn:aws:secretsmanager:<region>:<acct>:secret:cpq-rca/*`. For SSM, use `ssm:GetParameters`.
2. **VPC connector:** App Runner → *Networking* → create a VPC connector in the RDS VPC's private subnets with security group `app-sg` (allowed by `rds-sg`). Outbound traffic then goes through the VPC, so those subnets need a **NAT gateway** to reach Salesforce and SMTP.
3. **Create service:** Source = ECR image `cpq-to-rca:v1`, port `3000`, 1 vCPU / 2 GB.
   - Environment variables: the plain values above.
   - Secrets: reference each Secrets Manager ARN as `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `SMTP_PASS`, `GEMINI_API_KEY`.
   - Size: **1 vCPU / 2 GB** handles catalogs up to ~60k products (peak heap ≈ 210 MB per extraction, max 2 concurrent). Use 2 vCPU / 4 GB for larger orgs.
   - Health check: HTTP, path `/healthz`.
   - Outgoing network traffic: *Custom VPC* → the connector from step 2.
4. Migrations run automatically on container start (`docker-entrypoint.sh` → `prisma migrate deploy`; safe with multiple instances because Prisma takes an advisory lock).
5. Set a custom domain, then update `APP_URL` to it. Cookies become `Secure` automatically when `APP_URL` is https.

### Option B: Amazon ECS on Fargate + ALB

1. **Cluster:** ECS → create a Fargate cluster.
2. **Task execution role:** `AmazonECSTaskExecutionRolePolicy` + `secretsmanager:GetSecretValue` on `cpq-rca/*` (needed to inject secrets).
3. **Task definition** (excerpt):

   ```json
   {
     "family": "cpq-to-rca",
     "networkMode": "awsvpc",
     "requiresCompatibilities": ["FARGATE"],
     "cpu": "1024", "memory": "2048",
     "executionRoleArn": "arn:aws:iam::<acct>:role/cpqRcaTaskExecutionRole",
     "containerDefinitions": [{
       "name": "app",
       "image": "<acct>.dkr.ecr.<region>.amazonaws.com/cpq-to-rca:v1",
       "portMappings": [{ "containerPort": 3000 }],
       "environment": [
         { "name": "NODE_ENV", "value": "production" },
         { "name": "APP_URL", "value": "https://cpq.example.com" },
         { "name": "SMTP_HOST", "value": "email-smtp.us-east-1.amazonaws.com" },
         { "name": "SMTP_PORT", "value": "587" }
       ],
       "secrets": [
         { "name": "DATABASE_URL",   "valueFrom": "arn:aws:secretsmanager:<region>:<acct>:secret:cpq-rca/DATABASE_URL" },
         { "name": "JWT_SECRET",     "valueFrom": "arn:aws:secretsmanager:<region>:<acct>:secret:cpq-rca/JWT_SECRET" },
         { "name": "ENCRYPTION_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<acct>:secret:cpq-rca/ENCRYPTION_KEY" },
         { "name": "SMTP_PASS",      "valueFrom": "arn:aws:secretsmanager:<region>:<acct>:secret:cpq-rca/SMTP_PASS" },
         { "name": "GEMINI_API_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<acct>:secret:cpq-rca/GEMINI_API_KEY" }
       ],
       "logConfiguration": { "logDriver": "awslogs", "options": {
         "awslogs-group": "/ecs/cpq-to-rca", "awslogs-region": "<region>", "awslogs-stream-prefix": "app" } }
     }]
   }
   ```

   SSM parameters work the same way: `"valueFrom": "arn:aws:ssm:<region>:<acct>:parameter/cpq-rca/JWT_SECRET"`.
4. **Load balancer:** an internet-facing ALB in public subnets, HTTPS listener (ACM certificate), target group type `ip`, port 3000, health check path `/healthz`.
5. **Service:** Fargate service in **private subnets** (NAT gateway for outbound Salesforce/SMTP), security group `app-sg` allowing 3000 from the ALB only, desired count ≥ 2.
6. **Migrations:** the entrypoint runs them on start by default. To run them as a separate step instead, set `RUN_MIGRATIONS=false` on the service and run a one-off task before each deploy:

   ```bash
   aws ecs run-task --cluster cpq --launch-type FARGATE --task-definition cpq-to-rca --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-app]}" --overrides '{"containerOverrides":[{"name":"app","command":["npx","prisma","migrate","deploy"]}]}'
   ```

### Production checklist

- [ ] `APP_URL` is the public https URL (used in reset emails and for `Secure` cookies)
- [ ] `ENCRYPTION_KEY` and `JWT_SECRET` come from Secrets Manager / SSM, never from the image
- [ ] RDS is private, encrypted, backed up; `sslmode=require` in `DATABASE_URL`
- [ ] NAT gateway (or egress) so tasks can reach `*.salesforce.com`, `generativelanguage.googleapis.com` (Gemini) and the SMTP host
- [ ] `GEMINI_API_KEY` in Secrets Manager; check that sending the catalog digest to Google fits your customer's data policy
- [ ] `CPQ_DEMO_ORG` is **not** set
- [ ] Extractions are stored gzip-compressed in RDS (≈1–5 MB each, last 10 per org): size storage accordingly
- [ ] Several instances are fine: jobs are tracked in the database with a heartbeat. Long jobs run on the instance that started them, so give instances a deregistration delay of a few minutes during deploys
- [ ] SES domain verified and out of sandbox (for reset emails)
- [ ] CloudWatch alarms on 5xx and on `/healthz` failures

---

## Configuration reference

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | | `3000` | |
| `NODE_ENV` | | `development` | `development` enables the Vite dev middleware |
| `DATABASE_URL` | ✔ | | PostgreSQL connection string (local Docker DB: `postgresql://user:password@localhost:5433/cpq_rca`) |
| `JWT_SECRET` | ✔ | | ≥ 32 chars |
| `ENCRYPTION_KEY` | ✔ | | 32 bytes: 64 hex chars (recommended) or base64. Never change it casually; see *Security design* |
| `ENCRYPTION_KEY_PREVIOUS` | | | Old key(s), comma-separated, still accepted for decryption during a rotation |
| `APP_URL` | | `http://localhost:3000` | Public base URL |
| `JWT_EXPIRES_IN` | | `7d` | |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | | | Empty host → emails logged to console |
| `RESET_TOKEN_TTL_MINUTES` | | `30` | |
| `SF_API_VERSION` | | `62.0` | |
| `SF_TIMEOUT_MS` | | `20000` | Per Salesforce call |
| `SF_ALLOWED_HOST_SUFFIXES` | | Salesforce domains | SSRF allow-list |
| `COOKIE_SECURE` | | `true` if `APP_URL` is https | |
| `TRUST_PROXY` | | `1` in production | Proxy hops (App Runner/ALB = 1) |
| `RUN_MIGRATIONS` | | `true` | Container entrypoint only |
| `GEMINI_API_KEY` | for AI reports | | Google AI Studio key; empty disables report generation |
| `GEMINI_MODEL` | | `gemini-3.5-flash` | Preferred model |
| `GEMINI_FALLBACK_MODELS` | | `gemini-3.5-flash,gemini-3.8-flash,gemini-3.1-flash-lite` | Tried in order when the preferred model is retired (404), overloaded (503) or times out; after these, the newest `gemini-X.Y-flash` the key can list |
| `GEMINI_THINKING_LEVEL` | | `LOW` | Gemini 3+ (`MINIMAL`/`LOW`/`MEDIUM`/`HIGH`); 2.x models use `GEMINI_THINKING_BUDGET` |
| `GEMINI_FIRST_CHUNK_TIMEOUT_MS` / `GEMINI_IDLE_TIMEOUT_MS` | | `120000` / `120000` | Abandon a stuck model and try the next one |
| `GEMINI_MAX_OUTPUT_TOKENS` / `GEMINI_MAX_INPUT_TOKENS` / `GEMINI_THINKING_BUDGET` | | `32768` / `400000` / `4096` | |
| `CPQ_MAX_RECORDS_PER_OBJECT` | | `250000` | Safety cap per object; capped objects are flagged |
| `CPQ_MAX_CONCURRENT_EXTRACTIONS` | | `2` | Per instance |
| `CPQ_KEEP_EXTRACTIONS` | | `10` | History kept per connection |
| `CPQ_DEMO_ORG` / `CPQ_DEMO_PRODUCTS` | | off / `3000` | Development only: synthetic CPQ org |

## Branding

The StreamForce logo lives in `client/public/`:

- `logo.png`: the full wordmark, shown in the dashboard header and on the sign-in/sign-up/reset pages (via `client/src/components/Logo.jsx`).
- `favicon.png` (64×64) and `apple-touch-icon.png` (180×180): the cloud mark cropped from the wordmark, used as the browser-tab icon.

The PNG has a white background, so it is placed on white surfaces only.

Generated assessment documents (DOCX/PDF) embed `client/public/logo.png` on the cover and in every
page header. Users can upload their own PNG/JPEG logo for documents from the assessment panel; it is
stored on their user record, and "Reset to default" switches back.
