# Shedflare Money

Envelope-budgeting personal finance app — self-hosted, single-user, web-only.

Currently built as a Cloudflare Worker-backed SolidJS SPA with REST APIs, D1 SQLite, R2 upload storage, and local browser caching for selected settings.

Durable Objects, WebSocket sync, TanStack DB collections, and IndexedDB offline snapshots are target architecture ideas from the replacement plan, not shipped behavior today.

Home is the everyday view: category balances, quick expense entry, recent activity, and upcoming
payments. Budget is the monthly planning view: allocations, targets, and money held for next month.
Open a category from either view to record spending, assign money, move funds, or edit its target.
Moving money commits both sides together and supports undo. Existing account ledgers, imports,
reconciliation, schedules, and reports remain available.

Indonesian rupiah is supported throughout the budget: choose it in Settings → Currency.
Automatic number formatting uses `Rp1.250.000`, with whole-rupiah entry and grouped amounts in
transactions, assignments, targets, transfers, balances, and schedules. Mobile layouts make room
for longer amounts. Currency is a single-budget preference; it does not convert existing data.

Categories can use an outline icon or their initial. Choose one when adding a category or from
its drawer's settings; the saved choice appears on Home and Budget and supports undo.

Try the interface locally with sample data, without Cloudflare credentials or resource creation:

```bash
pnpm --filter @shedflare/money dev:demo
# Indonesian rupiah sample data
MONEY_DEMO_CURRENCY=IDR pnpm --filter @shedflare/money dev:demo
```

Open `http://localhost:5173`. The demo runs the real REST router with an in-memory SQLite database;
sample changes reset when the process stops. It listens only on loopback. Normal app development
and deployed E2E workflows remain separate.

---

## What It Is

Shedflare Money is a zero-based budgeting (envelope budgeting) app for personal use. You assign every dollar of income to a category, track spending against those budgets, and see where your money goes.

**Designed for:** single users who want full control over their finances without cloud dependencies or multi-user complexity.

---

## Features

### Budgeting

- **Envelope budgeting** — assign income to categories, track leftover, carryover between months
- **Buffer** — hold money aside for next month
- **Budget actions** — cover overspending, move money between categories, fill missing assignments from the previous month
- **5 goal template types** — monthly (fixed amount), byDate (save by deadline), refill (maintain target balance), periodic (every N months), percentage (% of monthly income)
- **Budgeted minus spending = leftover** (computed live via SQL queries, not stored)

### Accounts & Transactions

- **Multi-account support** — checking, savings, credit cards, off-budget accounts
- **Transaction CRUD** — create, update, delete, split transactions
- **Reconciliation** — compare statement balance against app balance, mark cleared/adjusted
- **Tags** — create tags, assign to transactions, color-coded
- **Payees** — manage payees, merge duplicates, favorites, autocomplete
- **Transaction filters** — save searches with condition builder, server-side SQL execution

### Automation

- **Schedules** — recurring transaction templates with configurable frequency, weekend handling (skip before/after), end conditions (after N occurrences or on a date)
- **Schedule discovery** — analyze transaction history to detect recurring patterns, suggest schedules with confidence scores
- **Rules engine** — auto-categorize transactions on import with conditions (payee, amount, date, notes, account, cleared + 12 comparison operators) and actions (set category/payee/notes, prepend/append notes, delete transaction, link schedule)
- **Rule test UI** — preview which existing transactions would match a rule
- **CSV import** — upload CSV files, parse, run rules, insert/update transactions

### Home & Reports

- **Home** — available category balances, overspending, quick entry, recent activity, and scheduled payments
- **Built-in reports** — net worth history, cash flow, spending breakdown, budget analysis, age of money
- **Custom reports** — save reports with filter conditions, grouping, sorting, and graph types

Home replaces the configurable widget dashboard. Existing widget records and dashboard APIs remain
in D1, but the old dashboard grid and its layout import/export controls are not part of the Home UI.

### Sync & Offline

- **Current behavior** — REST requests against D1-backed API handlers
- **Local settings cache** — selected settings are read from localStorage before server refresh
- **Pending command helper** — command dispatch supports undo metadata, but there is no global offline queue or server event replay
- **Target only** — WebSocket sync, snapshot/replay, IndexedDB offline cache, and TanStack DB collections are not implemented yet

### Settings

- **Currency** — USD and IDR with configurable exchange rate
- **Number format** — comma-dot (1,234.56), dot-comma (1.234,56), space-dot (1 234.56)
- **Date format** — ISO (YYYY-MM-DD), US (MM/DD/YYYY), EU (DD.MM.YYYY)
- **First day of week** — Sunday or Monday (affects calendar heatmap)
- **Privacy mode** — blur all monetary amounts with CSS filter
- **Export** — CSV export of all transactions, JSON export of dashboard

### UI

- **Command palette** — Cmd+K to fuzzy-search pages, accounts, payees, categories, schedules
- **Offline indicator** — sticky banner on disconnect with reconnect attempt count
- **PageState component** — consistent loading spinners and error retry across all pages
- **Dark theme only**

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare Worker                                  │
│  - Auth gate via @shedflare/auth                    │
│  - REST routes under /api/*                         │
│  - Serves static assets (SolidJS SPA)              │
└─────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│  Cloudflare D1 + R2                                 │
│  - D1 stores accounts, transactions, budgets, etc.  │
│  - R2 stores uploaded import files                  │
│  - Drizzle schema and generated migrations          │
└─────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│  SolidJS SPA (client)                               │
│  - Route-local REST data loading                    │
│  - Settings signal backed by localStorage           │
│  - Undo/redo (keyboard: Ctrl+Z / Ctrl+Y)           │
│  - D3-based chart components                        │
└─────────────────────────────────────────────────────┘
```

### Data Flow

```
User adds transaction:
  1. Client dispatches a command to POST /api/command
  2. Server validates and handles the command against D1
  3. Route reloads or locally patches the affected data
  4. Undo metadata is stored client-side when provided

Page load:
  1. SPA route mounts
  2. Route fetches data from /api/* endpoints
  3. Settings read localStorage immediately, then refresh from /api/settings
```

### Database Schema (32 tables)

| Table                       | Purpose                                           |
| --------------------------- | ------------------------------------------------- |
| `accounts`                  | Checking, savings, credit cards, off-budget       |
| `category_groups`           | Income/expense groupings                          |
| `categories`                | Spending categories with goal definitions         |
| `transactions`              | All transactions (parent/child splits, schedules) |
| `budgets`                   | Per-month, per-category budget amounts            |
| `budget_months`             | Monthly metadata (buffered money)                 |
| `payees`                    | Merchant/recipient names with favorites           |
| `schedules`                 | Recurring transaction templates                   |
| `rules`                     | Auto-categorization (conditions + actions)        |
| `tags` + `transaction_tags` | User-defined tags on transactions                 |
| `custom_reports`            | Saved report configurations                       |
| `dashboard_widgets`         | User's dashboard grid layout                      |
| `exchange_rates`            | USD ↔ IDR conversion rates                        |
| `settings`                  | User preferences (format, privacy, etc.)          |
| `events`                    | Audit trail (event sourcing)                      |
| `notes`                     | Generic key-value notes for any entity            |
| `transaction_filters`       | Saved search queries                              |
| `commands`                  | Idempotent command tracking                       |

### Command/Event Model

- **49 commands** across 13 aggregate handlers
- Commands validated via Effect/Schema
- Events persisted with sequence numbers
- Derived state (budget values) computed live via SQL queries
- Events broadcast to all connected WebSocket clients

---

## Tech Stack

- **Frontend:** SolidJS 1.9 + SolidJS Router + TanStack DB + D3
- **Backend:** Cloudflare Workers + Durable Objects + SQLite
- **Database:** Drizzle ORM (DO SQLite)
- **Validation:** Effect/Schema
- **Sync:** WebSocket with hello/ack/reject/event protocol
- **Offline:** IndexedDB cache, pending operations, offline-first SSR

---

## Design Decisions (Explicitly Out of Scope)

These are intentional boundaries — not missing features, but deliberate exclusions:

### Budget Model

- **Envelope budgeting only** — no tracking budget mode. Zero-based budgeting is the core interaction model.
- **SQL-computed derived values** — budget engine computes leftover/to_budget on the fly. No reactive spreadsheet cell graph.
- **No PEG parser for natural-language goals** — goal templates use JSON definitions with 5 fixed types (monthly, byDate, refill, periodic, percentage). No DSL parsing.
- **No AQL query language** — reports use condition JSON arrays with standard comparison operators.

### Rules & Automation

- **No formula actions** — rule actions set fixed values or note text. No balance-of queries, HyperFormula, or spreadsheet formulas.
- **No Handlebars template helpers** — rule actions are simple set/prepend/append/delete. No string interpolation with runtime variables.
- **No payee-specific learning** — rules are manually created. No auto-rule-generation from repeated user behavior.

### Data & Import

- **CSV import only** — no OFX/QFX/QIF/CAMT bank formats. No bank sync (GoCardless, SimpleFIN). Indonesian banks use CSV exports.
- **No batch operations** — single transaction commands only. No bulk insert/update/delete endpoints.
- **No data encryption** — data at rest in DO SQLite is unencrypted. No E2E encryption.
- **No backups/restore** — no backup list or restore mechanism. Users should use the CSV export and dashboard export features.

### Localization & Theming

- **English only** — no i18n framework. No language selection.
- **USD and IDR only** — no multi-currency support beyond the exchange rate toggle.
- **Dark theme only** — no light/midnight themes. No custom CSS override.
- **No theme customization** — the app has a fixed visual style.

### Multi-User & Infrastructure

- **Single-user, owner-only** — no multi-user support. The app is deployed once per user.
- **Single Durable Object** — all data lives in one `MoneyBudgetDO` instance. No sharding or multi-DO architecture.

### Future Considerations

- **LLM-based categorization** — rule engine and payee learning may be replaced or augmented by LLM-powered categorization in a future iteration. This is the planned direction for the rules and learning features.
- **Charting library project** — Sankey flow diagrams and formula cards are deferred to a separate charting library project.
