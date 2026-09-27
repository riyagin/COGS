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
| Schema owner | `backend/schema.sql` — apply with `npm run db:migrate` (from `backend/`) |
| Legacy | the old SQLite file `backend/cogs.db` is no longer used; copy it in once with `npm run db:import-sqlite` |

### Read it safely

Use a read-only transaction so an analysis can never modify data:

```bash
psql "$DATABASE_URL" -c "SET default_transaction_read_only = on; SELECT * FROM products;"
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
(`date_of_purchase`, `date_produced`, `invoices.date`, `stock_adjustments.date`) are `TEXT`.

### Alternative: the HTTP API

A JSON view of the same data is served by the app (`/api/*` on the deployed site, or
`http://localhost:3001` when running locally):

| Endpoint | Returns |
|---|---|
| `GET /api/products` | all products |
| `GET /api/inventory` | all lots, with `unit_price` pre-computed |
| `GET /api/inventory/stock` | per-product `total_remaining` + `avg_unit_price` |
| `GET /api/recipes` / `GET /api/recipes/:id` | recipes; ingredients on the detail route |
| `GET /api/production` | production runs |
| `GET /api/production/preview?recipe_id=&batches=` | costed what-if, consumes nothing |
| `GET /api/invoices` | invoices with nested `items` |
| `GET /api/adjustments` | last 200 adjustments |
| `GET /api/adjustments/stock` | per-product `total_remaining` |

Direct SQL is preferred for analysis; the API is capped (`/api/adjustments` has `LIMIT 200`)
and requires the server to be running.

---

## 2. Domain model in one paragraph

Everything is a **product** — raw ingredients and finished goods alike. Stock is tracked as
**lots** in `inventory_items`; each lot records how much was bought or made (`amount`), how
much is left (`remaining`), and the **total cost of the whole lot** (`price`). A **recipe**
turns input products into one output product. Recording a **production** run consumes
ingredient lots **FIFO**, sums their real cost, and inserts a new lot of the output product
priced at that cost — this is how COGS propagates up a multi-level bill of materials. Selling
via an **invoice** likewise consumes lots FIFO and records which lot each sale drew from.
**Stock adjustments** and **opname** (physical counts) reconcile the books to reality.

```
products ──< inventory_items (lots)
   │              ▲        ▲
   │              │        └── invoice_item_consumptions ──> invoice_items ──> invoices
   │              └── production_id ──> productions ──> recipes ──< recipe_items ──> products
   └──< recipe_items / recipes.output_product_id
```

---

## 3. Tables

### `products` — 29 rows

The catalogue. Raw materials and finished goods are **not** distinguished by a flag.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT | **UNIQUE**, the natural key; Indonesian names (e.g. `Sagu`, `Terigu`) |
| `unit_type` | TEXT | free text; in practice `g`, `mL`, `piece` |
| `created_at` | DATETIME | `CURRENT_TIMESTAMP`, **UTC** |

> A product is a *finished good* iff it appears as `recipes.output_product_id`.
> It is a *raw material* iff it only ever appears in `recipe_items.product_id` or purchased lots.

### `inventory_items` — 38 rows — **the most important table**

One row = one **lot** of stock.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `product_id` | INTEGER FK → `products.id` | |
| `amount` | REAL | quantity the lot **originally** held, in the product's `unit_type` |
| `remaining` | REAL | quantity **still available**; decremented by FIFO consumption |
| `price` | REAL | ⚠️ **TOTAL cost of the entire lot, not a unit price** |
| `date_of_purchase` | TEXT | `YYYY-MM-DD`; primary FIFO sort key |
| `source` | TEXT | `purchase` \| `production` \| `adjustment` \| `opname` |
| `production_id` | INTEGER | set only when `source='production'`; → `productions.id` (no FK constraint) |
| `note` | TEXT | added by a later migration; nullable |
| `created_at` | DATETIME | UTC; FIFO tie-breaker |

**The single biggest gotcha:** `price` is the lot total.

```sql
-- unit cost of a lot
SELECT price / amount AS unit_price FROM inventory_items WHERE amount > 0;
```

`amount` can be `0` in pathological rows — guard every division with `amount > 0`.

**FIFO order used everywhere in the app** (replicate it exactly):

```sql
SELECT id, remaining FROM inventory_items
WHERE product_id = $1 AND remaining > 0
ORDER BY date_of_purchase ASC, created_at ASC, id ASC;
```

`source` semantics:

- `purchase` — bought; `price` is what was actually paid.
- `production` — output of a run; `price` = `productions.total_cost` of that run.
- `adjustment` — positive manual correction; **`price` is 0**, i.e. free stock. This drags
  weighted-average cost downward. Exclude or re-price these when valuing inventory.
- `opname` — positive delta from a physical count; priced at an explicit `unit_price` if one
  was supplied, otherwise at this product's historical weighted-average unit price.

### `recipes` — 6 rows / `recipe_items` — 52 rows

A bill of materials. Recipes may **nest** (a recipe's output product is another recipe's
ingredient — e.g. `Kulit` feeding `Risoles SMB`), so treat it as a DAG, not a flat list.

`recipes`: `id`, `name` (UNIQUE), `output_product_id` FK → `products.id`,
`items_per_batch` (REAL, yield of one batch), `created_at`.

`recipe_items`: `id`, `recipe_id` FK (**ON DELETE CASCADE**), `product_id` FK,
`quantity_per_batch` (REAL, in the ingredient's own `unit_type`).

> Editing a recipe (`PUT /api/recipes/:id`) **deletes and re-inserts all `recipe_items`**, so
> their `id`s are unstable and past `productions` do **not** reference the ingredient rows that
> were actually used. Historical cost lives in `productions.total_cost`, not in the recipe.

### `productions` — 5 rows

One recorded manufacturing run. This is the **authoritative COGS record**.

| Column | Notes |
|---|---|
| `recipe_id` | FK → `recipes.id` |
| `batches` | REAL, may be fractional |
| `items_produced` | `= recipes.items_per_batch * batches` at the time of the run |
| `total_cost` | actual FIFO cost of ingredients consumed — **not** a weighted average |
| `unit_cost` | `total_cost / items_produced` |
| `date_produced` | TEXT `YYYY-MM-DD` |
| `created_at` | DATETIME UTC |

Each run also inserts one `inventory_items` row with `source='production'`,
`production_id = productions.id`, `price = total_cost`.

`GET /api/production/preview` costs a hypothetical run using the **weighted-average price of
remaining stock**, whereas an actually recorded run uses **true FIFO lot cost**. The two can
differ; `productions` holds the FIFO truth.

### `invoices` — 2 rows / `invoice_items` — 2 rows

Sales.

`invoices`: `invoice_num` (TEXT, **not unique, not enforced**), `customer_name` (may be `''`),
`date`, `note`, `subtotal`, `discount_pct`, `discount`, `tax_rate` (**TEXT**, e.g. `'0'`),
`tax`, `total`, `created_at`.

`invoice_items`: `invoice_id` FK (**ON DELETE CASCADE**), `description` (TEXT snapshot of the
name at sale time), `product_id` (**nullable** — free-text lines carry no product and consume
no stock), `qty`, `unit_price`, `subtotal`.

> ⚠️ **Date format is inconsistent.** `invoices.date` is stored as **`MM/DD/YYYY`**
> (e.g. `04/20/2026`), while every other date column is `YYYY-MM-DD`. Normalize before
> comparing or grouping:
>
> ```sql
> SELECT substr(date,7,4)||'-'||substr(date,1,2)||'-'||substr(date,4,2) AS iso_date
> FROM invoices;
> ```
>
> For time-series work, `created_at` (UTC, ISO) is the more reliable ordering key.

### `invoice_item_consumptions` — 0 rows

Links a sold line to the specific lots it drew from: `invoice_item_id` FK (**ON DELETE
CASCADE**), `inventory_item_id` FK, `quantity`. This is what makes per-sale COGS and margin
computable, and what lets invoice deletion restore `remaining`.

> ⚠️ **Currently empty while 2 invoices exist.** Those invoices predate this table, so their
> COGS cannot be attributed to lots — fall back to the output product's `productions.unit_cost`
> around that date. Deleting such an invoice will also **not** restore stock.

### `stock_adjustments` — 7 rows

Audit log of manual corrections and physical counts. The actual stock change is written to
`inventory_items`; this table only records *that it happened*.

| Column | Notes |
|---|---|
| `product_id` | FK → `products.id` |
| `quantity` | REAL, **signed delta**. Positive = stock added, negative = stock removed |
| `note` | TEXT |
| `date` | TEXT `YYYY-MM-DD` |
| `type` | `manual` (default) \| `opname` — added by a later migration |
| `created_at` | DATETIME UTC |

`manual` positive inserts a **zero-price** `adjustment` lot; `manual` negative FIFO-consumes.
`opname` computes `delta = counted − current total remaining` and stores **the delta**, not the
counted figure — so the counted number is not recoverable from this log alone.

---

## 4. Ready-to-use queries

**Current stock and inventory value**

```sql
SELECT p.id, p.name, p.unit_type,
       COALESCE(SUM(i.remaining), 0)                        AS qty_on_hand,
       COALESCE(SUM(i.remaining * (i.price / i.amount)), 0) AS stock_value,
       CASE WHEN SUM(i.remaining) > 0
            THEN SUM(i.remaining * (i.price / i.amount)) / SUM(i.remaining)
            ELSE 0 END                                      AS avg_unit_cost
FROM products p
LEFT JOIN inventory_items i
       ON i.product_id = p.id AND i.remaining > 0 AND i.amount > 0
GROUP BY p.id, p.name, p.unit_type
ORDER BY stock_value DESC;
```

**Unit-cost trend per finished good**

```sql
SELECT r.name AS recipe, pr.date_produced, pr.batches,
       pr.items_produced, pr.total_cost, pr.unit_cost
FROM productions pr
JOIN recipes r ON r.id = pr.recipe_id
ORDER BY r.name, pr.date_produced;
```

**Recipe cost at current average prices (what-if, one batch)**

```sql
SELECT r.name AS recipe, p.name AS ingredient,
       ri.quantity_per_batch,
       s.avg_unit_price,
       ri.quantity_per_batch * s.avg_unit_price AS line_cost
FROM recipe_items ri
JOIN recipes  r ON r.id = ri.recipe_id
JOIN products p ON p.id = ri.product_id
LEFT JOIN (
  SELECT product_id,
         SUM(remaining * (price / amount)) / SUM(remaining) AS avg_unit_price
  FROM inventory_items WHERE remaining > 0 AND amount > 0
  GROUP BY product_id
) s ON s.product_id = ri.product_id
ORDER BY r.name, line_cost DESC;
```

**Gross margin per sold line** (only meaningful once `invoice_item_consumptions` is populated)

```sql
SELECT inv.invoice_num,
       substr(inv.date,7,4)||'-'||substr(inv.date,1,2)||'-'||substr(inv.date,4,2) AS iso_date,
       ii.description, ii.qty, ii.subtotal AS revenue,
       COALESCE(SUM(c.quantity * (l.price / l.amount)), 0) AS cogs,
       ii.subtotal - COALESCE(SUM(c.quantity * (l.price / l.amount)), 0) AS gross_margin
FROM invoice_items ii
JOIN invoices inv ON inv.id = ii.invoice_id
LEFT JOIN invoice_item_consumptions c ON c.invoice_item_id = ii.id
LEFT JOIN inventory_items l ON l.id = c.inventory_item_id AND l.amount > 0
GROUP BY ii.id, inv.id
ORDER BY iso_date DESC;
```

**Lots at risk of being mis-valued (free adjustment stock)**

```sql
SELECT i.id, p.name, i.remaining, i.source, i.price, i.note, i.date_of_purchase
FROM inventory_items i JOIN products p ON p.id = i.product_id
WHERE i.remaining > 0 AND (i.price = 0 OR i.amount = 0);
```

**Classify products**

```sql
SELECT p.id, p.name,
       CASE WHEN EXISTS (SELECT 1 FROM recipes r WHERE r.output_product_id = p.id)
            THEN 'finished_good' ELSE 'raw_material' END AS kind
FROM products p ORDER BY kind, p.name;
```

---

## 5. Rules an evaluating agent must follow

1. **`inventory_items.price` is a lot total.** Divide by `amount` for a unit price. This is the
   single most common source of wrong numbers here.
2. **Guard every division** with `amount > 0` / `SUM(remaining) > 0`.
3. **FIFO is `ORDER BY date_of_purchase ASC, created_at ASC, id ASC`** — date first, then `id` only as a tie-break; not by `created_at`
   alone. Matching this exactly is required to reproduce the app's costing.
4. **Two date conventions coexist**: `invoices.date` is `MM/DD/YYYY`; everything else is
   `YYYY-MM-DD`. All `created_at` values are **UTC**, not local time.
5. **No currency column.** Amounts are plain DOUBLE PRECISION values, in practice **IDR** (e.g. `19000` for a
   500 g bag of Sagu). Nothing enforces this — don't mix in another currency.
6. **Floats, not decimals.** Every quantity and price is DOUBLE PRECISION, so totals carry rounding error
   (`101581.99318181818`). The app treats **1e-4 as its equality epsilon**; do the same, and
   round only at presentation time.
7. **Zero-price `adjustment` lots are possible.** A positive manual adjustment writes a lot with
   `price = 0`, which pulls weighted-average cost toward zero. None exist right now (the
   `source` values actually present are `purchase`, `production` and `opname`), but decide
   explicitly whether to include them once they appear.
8. **`remaining` is mutable, `amount` is not.** Consumption is destructive: there is no ledger
   for production or adjustment consumption, only `invoice_item_consumptions` for sales. You
   cannot fully reconstruct historical stock levels from this schema.
9. **Recipes are versionless.** A recipe reflects *today*; the cost of a past run lives only in
   `productions`. Never re-cost history from the current recipe.
10. **Recipes nest** — resolve the BOM recursively; don't assume one level.
11. **Read-only, please.** This is the live operational DB behind the app on port 3001. Open
    with `mode=ro`, and never write, `VACUUM`, or delete the `-wal`/`-shm` files.
12. **Referential integrity is only partly enforced.** `foreign_keys` is set per-connection by
    the app, `production_id` has no FK at all, and `invoice_items.product_id` is nullable —
    expect orphans and use `LEFT JOIN` when in doubt.
