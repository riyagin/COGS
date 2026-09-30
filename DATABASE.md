# COGS Database — Agent Context Guide

This document tells an external agent/system how to read the COGS (Cost of Goods Sold)
database, what each table means, and which traps to avoid when computing metrics.

---

## 1. Connection

| | |
|---|---|
| Engine | **PostgreSQL** (Supabase in production) |
| Production | connection string in the `DATABASE_URL` env var (Vercel project settings / `backend/.env`) |
| Local dev | when `DATABASE_URL` is unset the app uses **PGlite** (embedded Postgres) in `backend/.pgdata/` |
| Driver used by the app | `pg` / `@electric-sql/pglite` behind one async API (see `backend/db.js`) |
| Schema owner | `backend/schema.sql` — apply with `npm run db:migrate` (from `backend/`); idempotent, and upgrades older databases in place |

### Read it safely

Use a read-only transaction so an analysis can never modify data:

```bash
psql "$DATABASE_URL" -c "SET default_transaction_read_only = on; SELECT * FROM items;"
```

```python
import psycopg
con = psycopg.connect(DATABASE_URL, autocommit=True)
con.execute("SET default_transaction_read_only = on")
```

```js
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query('SET default_transaction_read_only = on');
```

Quantities and money are `DOUBLE PRECISION`; `created_at` is `TIMESTAMPTZ`; business dates
(`date_of_purchase`, `date_produced`, `purchases.date`, `journal_entries.date`, ...) are
`TEXT` `YYYY-MM-DD`.

### Alternative: the HTTP API

A JSON view of the same data is served by the app (`/api/*` on the deployed site, or
`http://localhost:3001` when running locally):

| Endpoint | Returns |
|---|---|
| `GET /api/items` | stocked items with tier, stock on hand and last unit price |
| `GET /api/products` | sellable products with components and expected cost |
| `GET /api/inventory` | all lots, with `unit_price` pre-computed |
| `GET /api/inventory/stock` | per-item `total_remaining`, `total_value`, `avg_unit_price` |
| `GET /api/purchases` | purchases with lines and payment status |
| `GET /api/recipes` / `GET /api/recipes/:id` | recipes (with expected unit cost); ingredients on the detail route |
| `GET /api/recipes/:id/tree` | recipe expanded through its preprocessed ingredients, with costs |
| `GET /api/production` | production runs (auto-made sub-runs have `parent_production_id`) |
| `GET /api/production/preview?recipe_id=&batches=&auto_produce=1&whole_batches=1` | costed what-if plan, consumes nothing |
| `GET /api/invoices` | invoices with nested `items` and FIFO `cogs` |
| `GET /api/adjustments` | last 200 adjustments |
| `GET /api/accounting/accounts` | chart of accounts with balances |
| `GET /api/accounting/journal?from=&to=&account_id=&source_type=` | journal entries with lines (capped at 500) |
| `GET /api/accounting/pnl?from=&to=` | profit & loss, per account and per month |
| `GET /api/accounting/balance-sheet?date=` | balance sheet as of a date |

Direct SQL is preferred for analysis; several API lists are capped and the API requires
the server to be running.

---

## 2. Domain model in one paragraph

An **item** is anything held in stock, in one of three **tiers**: `raw` (bought, e.g. flour),
`preprocessed` (made here by a recipe and used in other recipes, e.g. white sauce), or `final`
(made here and sold, e.g. Risoles Smoke Beef Mayo). A **product** is what's sold: a name and
price made of one or more items per unit (e.g. a box of 10 risoles + 1 box). Stock is tracked
as **lots** in `inventory_items`; each lot records how much came in (`amount`), how much is
left (`remaining`), and the **total cost of the whole lot** (`price`). A **purchase** (one
supplier receipt) adds lots and/or expenses. A **recipe** turns input items into one output
item; recipes nest (white sauce → mayo mix → risoles). A **production** run consumes
ingredient lots **FIFO**, sums their real cost, and inserts a lot of the output priced at that
cost; with auto-produce, missing preprocessed ingredients are made first as child runs. An
**invoice** sells products, consuming their component items FIFO. **Adjustments** and
**opname** (physical counts) reconcile stock to reality. Every one of those movements also
posts a balanced **journal entry**, so the books (and the P&L) follow stock automatically.

```
items ──< inventory_items (lots) >── purchase_lines >── purchases
  │            ▲        ▲      ▲
  │            │        │      └── invoice_item_consumptions ──> invoice_items ──> invoices
  │            │        │                                              │
  │            │        └── production_id ──> productions ──> recipes ──< recipe_items ──> items
  │            └── (adjustment / opname lots)                          │
  └──< product_components >── products <──────────────────────────────┘ (invoice_items.product_id)

accounts ──< journal_lines >── journal_entries (source_type, source_id → the record that posted it)
```

---

## 3. Tables

### `items`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT | **UNIQUE**; Indonesian names (e.g. `Sagu`, `Terigu`) |
| `unit_type` | TEXT | free text; in practice `g`, `mL`, `piece`. Fixed once stock was recorded |
| `tier` | TEXT | `raw` \| `preprocessed` \| `final` |
| `created_at` | TIMESTAMPTZ | UTC |

Rules enforced by the API: recipes output only `preprocessed`/`final` items; ingredients are
only `raw`/`preprocessed`. (Databases upgraded from the old model got tiers guessed from
recipe usage; users can re-tier on the Items page.)

### `inventory_items` — **the most important table**

One row = one **lot** of stock.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `item_id` | INTEGER FK → `items.id` | |
| `amount` | DOUBLE | quantity the lot **originally** held, in the item's `unit_type` |
| `remaining` | DOUBLE | quantity **still available**; decremented by FIFO consumption |
| `price` | DOUBLE | ⚠️ **TOTAL cost of the entire lot, not a unit price** |
| `date_of_purchase` | TEXT | `YYYY-MM-DD`; primary FIFO sort key (also used for produced/adjusted lots) |
| `source` | TEXT | `purchase` \| `production` \| `adjustment` \| `opname` |
| `production_id` | INTEGER FK | set only when `source='production'` |
| `purchase_line_id` | INTEGER FK | set for purchases made through the Purchasing page (NULL for older lots) |
| `note` | TEXT | nullable (supplier name for purchases) |
| `created_by`, `created_at` | | |

```sql
-- unit cost of a lot
SELECT price / amount AS unit_price FROM inventory_items WHERE amount > 0;
```

**FIFO order used everywhere in the app** (replicate it exactly):

```sql
SELECT id, remaining FROM inventory_items
WHERE item_id = $1 AND remaining > 0
ORDER BY date_of_purchase ASC, created_at ASC, id ASC;
```

`source` semantics:

- `purchase` — bought; `price` is what was actually paid.
- `production` — output of a run; `price` = `productions.total_cost` of that run.
- `adjustment` — positive manual correction, priced at the item's last purchase price
  (older rows from before bookkeeping may have `price = 0`).
- `opname` — positive delta from a physical count; priced at an explicit `unit_price` if one
  was supplied, otherwise at the last purchase price.

### `purchases` / `purchase_lines`

One purchase = one supplier receipt. `purchases`: `date`, `supplier`, `reference`, `note`,
`total`, `paid_date` (**NULL = unpaid**, i.e. still in Accounts payable),
`paid_from_account_id` (cash or bank account), `created_by`.

`purchase_lines`: `purchase_id` (**ON DELETE CASCADE**), and exactly one of `item_id`
(stock: `quantity` + `amount`, creates one lot linked by `inventory_items.purchase_line_id`)
or `account_id` (a straight expense such as gas or delivery). `amount` is the line total.

### `recipes` / `recipe_items`

A bill of materials. Recipes **nest** (a recipe's output item is another recipe's
ingredient — e.g. `Kulit Risoles` feeding `Risoles Smoke Beef Mayo`), so treat it as a DAG.
The API refuses loops.

`recipes`: `id`, `name` (UNIQUE), `output_item_id` FK → `items.id`,
`items_per_batch` (yield of one batch), `created_at`.
When an item has several recipes, the **newest** (`created_at DESC, id DESC`) is its primary
recipe: used for expected cost roll-ups and for automatic sub-runs.

Recipes are **versioned**. The name never changes; every edit saves a new row in
`recipe_versions` (`recipe_id`, `version_no` 1, 2, 3…, `output_item_id`, `items_per_batch`,
`note` = what changed, `created_by`, `created_at`). `recipes.current_version_id` points at the
version in use, and `recipes.output_item_id` / `items_per_batch` mirror it. Restoring an old
version saves a copy of it as the newest version; nothing is ever overwritten. Recipes that
existed before versioning are version 1, dated with the recipe's `created_at`.

`recipe_items`: `recipe_id` FK (**ON DELETE CASCADE**), `version_id` FK → `recipe_versions`,
`item_id` FK, `quantity_per_batch` (in the ingredient's own `unit_type`).
⚠️ Rows for **all** versions live here: the current ingredients are
`WHERE version_id = recipes.current_version_id`, never just `WHERE recipe_id = …`.

> Historical cost lives in `productions.total_cost`; `productions.recipe_version_id` says
> which version a run used.

### `productions`

One recorded manufacturing run. This is the **authoritative production cost record**.

| Column | Notes |
|---|---|
| `recipe_id` | FK → `recipes.id` |
| `batches` | may be fractional |
| `items_produced` | `= recipes.items_per_batch * batches` at the time of the run |
| `total_cost` | actual FIFO cost of ingredients consumed |
| `unit_cost` | `total_cost / items_produced` |
| `date_produced` | TEXT `YYYY-MM-DD` |
| `parent_production_id` | set on runs made automatically to cover a missing preprocessed ingredient of another run |

Each run also inserts one `inventory_items` row with `source='production'`.

### `products` / `product_components`

Sellable products. `products`: `name` (UNIQUE), `unit` (e.g. `pcs`, `box`), `sell_price`
(nullable), `active`. `product_components`: `product_id` (**ON DELETE CASCADE**), `item_id`,
`quantity` of the item consumed per unit sold.

### `invoices` / `invoice_items` / `invoice_item_consumptions`

Sales. `invoices`: `invoice_num` (not unique), `customer_name`, `date`, `note`, `subtotal`,
`discount_pct`, `discount`, `tax_rate` (**TEXT**), `tax`, `total`,
`payment_account_id` (cash/bank/receivable; NULL on invoices from before bookkeeping).

`invoice_items`: `invoice_id` (**ON DELETE CASCADE**), `description` (name snapshot),
`product_id` → `products.id` (**nullable** — free-text lines consume no stock), `qty`,
`unit_price`, `subtotal`.

`invoice_item_consumptions`: which lots each sold line drew from (`inventory_item_id`,
`quantity`). This gives true per-sale COGS and lets invoice deletion restore stock.

> ⚠️ **Date format is inconsistent on old invoices**: those from the legacy POS store
> `invoices.date` as **`MM/DD/YYYY`**; invoices created through the API store `YYYY-MM-DD`.
> The two invoices that predate consumptions have no COGS attributable to lots.

### `stock_adjustments`

Audit log of manual corrections and physical counts; the stock change itself is in
`inventory_items`. `item_id`, `quantity` (**signed delta**), `note`, `date`,
`type` (`manual` | `opname` | `reset`), `created_by`.

### `accounts`

Chart of accounts. `code` (UNIQUE), `name`, `type` (`asset` | `liability` | `equity` |
`revenue` | `cogs` | `expense`), `system_key` (set on the accounts the app posts to:
`cash`, `bank`, `receivable`, `inventory_raw`, `inventory_preprocessed`, `inventory_final`,
`payable`, `tax_payable`, `capital`, `opening_balance`, `sales`, `sales_discounts`, `cogs`,
`inventory_adjustments`, `expense_general`), `active`.

### `journal_entries` / `journal_lines`

Double-entry journal. `journal_entries`: `date`, `memo`, `source_type`, `source_id`,
`created_by`. `journal_lines`: `entry_id` (**ON DELETE CASCADE**), `account_id`, `debit`,
`credit` (both ≥ 0, one of them 0), `memo`. **Every entry's debits equal its credits.**

| `source_type` | Posted by | Lines |
|---|---|---|
| `opening` | migration, once | Dr inventory (per tier) / Cr Opening balance |
| `purchase` | purchase | Dr inventory (per tier) and/or expense / Cr cash, bank or payable |
| `purchase_payment` | paying an unpaid purchase | Dr payable / Cr cash or bank |
| `production` | each run | Dr inventory (output tier) / Cr inventory (ingredient tiers) |
| `invoice` | sale | Dr cash/bank/receivable, Dr sales discounts / Cr sales, Cr tax; Dr COGS / Cr inventory |
| `adjustment` | adjustment or opname | inventory ↔ Inventory adjustments & waste |
| `reset` | `npm run stock:reset` | Dr Inventory adjustments & waste / Cr inventory |
| `manual` | Accounting page | anything |

Deleting a purchase or invoice deletes the entries it posted.

---

## 4. Ready-to-use queries

**Current stock and inventory value**

```sql
SELECT i.id, i.name, i.tier, i.unit_type,
       COALESCE(SUM(l.remaining), 0)                        AS qty_on_hand,
       COALESCE(SUM(l.remaining * (l.price / l.amount)), 0) AS stock_value
FROM items i
LEFT JOIN inventory_items l
       ON l.item_id = i.id AND l.remaining > 0 AND l.amount > 0
GROUP BY i.id
ORDER BY stock_value DESC;
```

**Account balances (trial balance)**

```sql
SELECT a.code, a.name, a.type,
       SUM(l.debit) AS debit, SUM(l.credit) AS credit,
       CASE WHEN a.type IN ('asset','cogs','expense') THEN SUM(l.debit - l.credit)
            ELSE SUM(l.credit - l.debit) END AS balance
FROM accounts a JOIN journal_lines l ON l.account_id = a.id
GROUP BY a.id ORDER BY a.code;
```

**Profit & loss by month**

```sql
SELECT substr(e.date, 1, 7) AS month, a.type,
       SUM(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END) AS amount
FROM journal_lines l
JOIN journal_entries e ON e.id = l.entry_id
JOIN accounts a ON a.id = l.account_id
WHERE a.type IN ('revenue', 'cogs', 'expense')
GROUP BY month, a.type ORDER BY month, a.type;
```

**Books vs stock check** (should match per tier, to rounding)

```sql
SELECT i.tier, SUM(l.remaining * l.price / l.amount) AS stock_value
FROM inventory_items l JOIN items i ON i.id = l.item_id
WHERE l.remaining > 0 AND l.amount > 0 GROUP BY i.tier;

SELECT a.system_key, SUM(l.debit - l.credit) AS book_value
FROM accounts a JOIN journal_lines l ON l.account_id = a.id
WHERE a.system_key IN ('inventory_raw', 'inventory_preprocessed', 'inventory_final')
GROUP BY a.system_key;
```

**Unit-cost trend per made item**

```sql
SELECT r.name AS recipe, pr.date_produced, pr.batches,
       pr.items_produced, pr.total_cost, pr.unit_cost, pr.parent_production_id
FROM productions pr
JOIN recipes r ON r.id = pr.recipe_id
ORDER BY r.name, pr.date_produced;
```

**Gross margin per sold line**

```sql
SELECT inv.invoice_num, inv.date, ii.description, ii.qty, ii.subtotal AS revenue,
       COALESCE(SUM(c.quantity * (l.price / l.amount)), 0) AS cogs
FROM invoice_items ii
JOIN invoices inv ON inv.id = ii.invoice_id
LEFT JOIN invoice_item_consumptions c ON c.invoice_item_id = ii.id
LEFT JOIN inventory_items l ON l.id = c.inventory_item_id AND l.amount > 0
GROUP BY ii.id, inv.id
ORDER BY inv.created_at DESC;
```

**Unpaid supplier bills**

```sql
SELECT id, date, supplier, reference, total FROM purchases WHERE paid_date IS NULL ORDER BY date;
```

---

## 5. Rules an evaluating agent must follow

1. **`inventory_items.price` is a lot total.** Divide by `amount` for a unit price.
2. **Guard every division** with `amount > 0` / `SUM(remaining) > 0`.
3. **FIFO is `ORDER BY date_of_purchase ASC, created_at ASC, id ASC`**.
4. **Items vs products**: stock, recipes and costs are about `items`; sales are about
   `products`. A product's cost is the sum of its components' item costs.
5. **Two date conventions coexist on invoices** (old POS rows `MM/DD/YYYY`). All other
   business dates, including every `journal_entries.date`, are `YYYY-MM-DD`. `created_at` is UTC.
6. **No currency column.** Amounts are IDR.
7. **Floats, not decimals.** The app treats **1e-4 as its quantity epsilon** and **0.005 as its
   money epsilon**; round only at presentation time.
8. **Books start at the opening entry.** Journal history only covers movements after
   bookkeeping was switched on; earlier purchases and sales are not in the P&L.
9. **`remaining` is mutable, `amount` is not.** Consumption for production and adjustments has
   no per-lot ledger (sales do: `invoice_item_consumptions`); the value moved is in the journal.
10. **Recipes are versionless and nest** — resolve the BOM recursively; never re-cost history
    from the current recipe.
11. **Read-only, please.** This is the live operational DB behind the app.
12. **Referential integrity** is enforced by foreign keys throughout; `invoice_items.product_id`
    is nullable for free-text lines.
