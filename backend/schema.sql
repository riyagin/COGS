-- COGS schema (PostgreSQL). Idempotent: safe to run on every migrate.
-- Quantities and money use DOUBLE PRECISION so the pg driver returns plain JS numbers.
-- Business dates (date_of_purchase, date_produced, ...) stay 'YYYY-MM-DD' TEXT, as before.
--
-- Vocabulary:
--   item     something we stock: raw material, preprocessed (made here, used in other
--            recipes, e.g. white sauce), or final good (made here, sold, e.g. a risoles)
--   product  something we sell: a name + price made of one or more items
--            (e.g. "Risoles SMB box of 10" = 10 x Risoles Smoke Beef Mayo + 1 x Box)

-- ── One-time upgrade: products -> items ──────────────────────────────────────
-- Before the items/products split, the stocked things lived in `products`. Rename that
-- table (and everything named after it) so `products` is free for sellable products.
DO $$
DECLARE r RECORD;
BEGIN
  IF to_regclass('public.items') IS NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'unit_type'
  ) THEN
    ALTER TABLE products RENAME TO items;
    ALTER SEQUENCE IF EXISTS products_id_seq RENAME TO items_id_seq;
    ALTER INDEX IF EXISTS products_pkey RENAME TO items_pkey;
    ALTER INDEX IF EXISTS products_name_key RENAME TO items_name_key;

    ALTER TABLE recipes           RENAME COLUMN output_product_id TO output_item_id;
    ALTER TABLE recipe_items      RENAME COLUMN product_id TO item_id;
    ALTER TABLE inventory_items   RENAME COLUMN product_id TO item_id;
    ALTER TABLE stock_adjustments RENAME COLUMN product_id TO item_id;
    -- Old sales lines point at items; re-pointed at products further down, then dropped
    ALTER TABLE invoice_items     RENAME COLUMN product_id TO legacy_item_id;

    FOR r IN SELECT * FROM (VALUES
      ('recipes_output_product_id_idx',     'recipes_output_item_id_idx'),
      ('recipe_items_product_id_idx',       'recipe_items_item_id_idx'),
      ('inventory_items_product_id_idx',    'inventory_items_item_id_idx'),
      ('stock_adjustments_product_id_idx',  'stock_adjustments_item_id_idx'),
      ('invoice_items_product_id_idx',      'invoice_items_legacy_item_id_idx')
    ) AS v(old_name, new_name) LOOP
      IF to_regclass('public.' || r.old_name) IS NOT NULL THEN
        EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
      END IF;
    END LOOP;

    FOR r IN SELECT * FROM (VALUES
      ('recipes',           'recipes_output_product_id_fkey',     'recipes_output_item_id_fkey'),
      ('recipe_items',      'recipe_items_product_id_fkey',       'recipe_items_item_id_fkey'),
      ('inventory_items',   'inventory_items_product_id_fkey',    'inventory_items_item_id_fkey'),
      ('stock_adjustments', 'stock_adjustments_product_id_fkey',  'stock_adjustments_item_id_fkey'),
      ('invoice_items',     'invoice_items_product_id_fkey',      'invoice_items_legacy_item_id_fkey')
    ) AS v(tbl, old_name, new_name) LOOP
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.old_name) THEN
        EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ── Chart of accounts ────────────────────────────────────────────────────────
-- type drives the reports: asset/liability/equity -> balance sheet,
-- revenue/cogs/expense -> profit & loss. system_key marks the accounts the app posts
-- to automatically (see backend/ledger.js); those can be renamed but not removed.
CREATE TABLE IF NOT EXISTS accounts (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense')),
  system_key  TEXT UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO accounts (code, name, type, system_key) VALUES
  ('1000', 'Cash',                             'asset',     'cash'),
  ('1010', 'Bank',                             'asset',     'bank'),
  ('1100', 'Accounts receivable',              'asset',     'receivable'),
  ('1200', 'Inventory - raw materials',        'asset',     'inventory_raw'),
  ('1210', 'Inventory - preprocessed',         'asset',     'inventory_preprocessed'),
  ('1220', 'Inventory - finished goods',       'asset',     'inventory_final'),
  ('2000', 'Accounts payable',                 'liability', 'payable'),
  ('2100', 'Tax payable',                      'liability', 'tax_payable'),
  ('3000', 'Owner''s capital',                 'equity',    'capital'),
  ('3900', 'Opening balance',                  'equity',    'opening_balance'),
  ('4000', 'Sales',                            'revenue',   'sales'),
  ('4900', 'Sales discounts',                  'revenue',   'sales_discounts'),
  ('5000', 'Cost of goods sold',               'cogs',      'cogs'),
  ('5100', 'Inventory adjustments & waste',    'cogs',      'inventory_adjustments'),
  ('6000', 'General expenses',                 'expense',   'expense_general')
ON CONFLICT DO NOTHING;

-- Starter expense accounts; free to rename, deactivate or add to
INSERT INTO accounts (code, name, type) VALUES
  ('6100', 'Utilities (gas, electricity, water)', 'expense'),
  ('6200', 'Transport & delivery',                'expense'),
  ('6300', 'Rent',                                'expense'),
  ('6400', 'Salaries & wages',                    'expense'),
  ('6500', 'Equipment & supplies',                'expense'),
  ('6900', 'Other expenses',                      'expense')
ON CONFLICT DO NOTHING;

-- ── Items, recipes, production ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  unit_type   TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'raw' CHECK (tier IN ('raw', 'preprocessed', 'final')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgraded databases: add the tier and guess it from how each item is used.
-- Made by a recipe and used in another -> preprocessed; made by a recipe or sold -> final.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'tier'
  ) THEN
    ALTER TABLE items ADD COLUMN tier TEXT NOT NULL DEFAULT 'raw'
      CHECK (tier IN ('raw', 'preprocessed', 'final'));
    UPDATE items SET tier = 'final'
      WHERE id IN (SELECT output_item_id FROM recipes)
         OR id IN (SELECT legacy_item_id FROM invoice_items WHERE legacy_item_id IS NOT NULL);
    UPDATE items SET tier = 'preprocessed'
      WHERE id IN (SELECT output_item_id FROM recipes)
        AND id IN (SELECT item_id FROM recipe_items);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS recipes (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  output_item_id     INTEGER NOT NULL REFERENCES items(id),
  items_per_batch    DOUBLE PRECISION NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id                  SERIAL PRIMARY KEY,
  recipe_id           INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  item_id             INTEGER NOT NULL REFERENCES items(id),
  quantity_per_batch  DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS productions (
  id              SERIAL PRIMARY KEY,
  recipe_id       INTEGER NOT NULL REFERENCES recipes(id),
  batches         DOUBLE PRECISION NOT NULL,
  items_produced  DOUBLE PRECISION NOT NULL,
  total_cost      DOUBLE PRECISION NOT NULL,
  unit_cost       DOUBLE PRECISION NOT NULL,
  date_produced   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A run made automatically to cover a missing preprocessed ingredient of another run
ALTER TABLE productions ADD COLUMN IF NOT EXISTS parent_production_id INTEGER REFERENCES productions(id);

-- ── Recipe versions ──────────────────────────────────────────────────────────
-- A recipe keeps its name; every edit saves a new numbered version of its contents
-- (output, yield, ingredients) with who made it and when. Old versions stay as they were.
-- recipes.output_item_id / items_per_batch mirror the current version, and
-- recipe_items rows belong to one version (the current ones: version_id = current_version_id).
CREATE TABLE IF NOT EXISTS recipe_versions (
  id               SERIAL PRIMARY KEY,
  recipe_id        INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version_no       INTEGER NOT NULL,
  output_item_id   INTEGER NOT NULL REFERENCES items(id),
  items_per_batch  DOUBLE PRECISION NOT NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, version_no)
);

ALTER TABLE recipes      ADD COLUMN IF NOT EXISTS current_version_id INTEGER REFERENCES recipe_versions(id);
ALTER TABLE recipe_items ADD COLUMN IF NOT EXISTS version_id INTEGER REFERENCES recipe_versions(id) ON DELETE CASCADE;
-- The version a run was made from (runs before versioning point at version 1)
ALTER TABLE productions  ADD COLUMN IF NOT EXISTS recipe_version_id INTEGER REFERENCES recipe_versions(id);

-- Recipes from before versioning become version 1, dated when the recipe was created
DO $$
DECLARE r RECORD; v INTEGER;
BEGIN
  FOR r IN SELECT * FROM recipes WHERE current_version_id IS NULL LOOP
    INSERT INTO recipe_versions (recipe_id, version_no, output_item_id, items_per_batch, note, created_at)
    VALUES (r.id, 1, r.output_item_id, r.items_per_batch, 'Original version', r.created_at)
    RETURNING id INTO v;
    UPDATE recipe_items SET version_id = v WHERE recipe_id = r.id AND version_id IS NULL;
    UPDATE recipes SET current_version_id = v WHERE id = r.id;
    UPDATE productions SET recipe_version_id = v WHERE recipe_id = r.id AND recipe_version_id IS NULL;
  END LOOP;
END $$;

ALTER TABLE recipe_items ALTER COLUMN version_id SET NOT NULL;

-- One-time tidy-up (2026-09-30). Before versioning, new versions of a dish were saved as
-- separate recipes ("Risoles SMB ver1", "ver2", "Risoles Mayo 0909"). Fold them into one
-- recipe whose versions follow the order they were created in, keeping their production
-- history, and drop the "ver1" suffix that versioning makes redundant.
DO $$
DECLARE
  keeper INTEGER;
  n INTEGER := 0;
  r RECORD;
  ver RECORD;
BEGIN
  IF (SELECT COUNT(*) FROM recipes WHERE name IN ('Risoles SMB ver1', 'Risoles SMB ver2', 'Risoles Mayo 0909')) >= 2
     AND NOT EXISTS (SELECT 1 FROM recipes WHERE name = 'Risoles Smoke Beef Mayo') THEN
    FOR r IN SELECT * FROM recipes
             WHERE name IN ('Risoles SMB ver1', 'Risoles SMB ver2', 'Risoles Mayo 0909')
             ORDER BY created_at, id LOOP
      IF keeper IS NULL THEN
        keeper := r.id;
        UPDATE recipes SET name = 'Risoles Smoke Beef Mayo' WHERE id = keeper;
      END IF;
      FOR ver IN SELECT * FROM recipe_versions WHERE recipe_id = r.id ORDER BY version_no LOOP
        n := n + 1;
        UPDATE recipe_versions
        SET recipe_id = keeper, version_no = n,
            note = CASE WHEN version_no = 1 THEN format('Was the separate recipe "%s"', r.name) ELSE note END
        WHERE id = ver.id;
      END LOOP;
      IF r.id <> keeper THEN
        UPDATE recipe_items SET recipe_id = keeper WHERE recipe_id = r.id;
        UPDATE productions  SET recipe_id = keeper WHERE recipe_id = r.id;
        DELETE FROM recipes WHERE id = r.id;
      END IF;
    END LOOP;

    UPDATE recipes k
    SET current_version_id = v.id, output_item_id = v.output_item_id, items_per_batch = v.items_per_batch
    FROM recipe_versions v
    WHERE k.id = keeper AND v.recipe_id = keeper AND v.version_no = n;
  END IF;

  IF EXISTS (SELECT 1 FROM recipes WHERE name = 'Risoles Chicken Truffle ver1')
     AND NOT EXISTS (SELECT 1 FROM recipes WHERE name = 'Risoles Chicken Truffle') THEN
    UPDATE recipe_versions SET note = 'Was named "Risoles Chicken Truffle ver1"'
    WHERE id = (SELECT current_version_id FROM recipes WHERE name = 'Risoles Chicken Truffle ver1') AND version_no = 1;
    UPDATE recipes SET name = 'Risoles Chicken Truffle' WHERE name = 'Risoles Chicken Truffle ver1';
  END IF;
END $$;

-- ── Purchasing ───────────────────────────────────────────────────────────────
-- One purchase = one receipt from a supplier. Lines are either stock (item_id: adds a lot)
-- or a straight expense (account_id). Paid now from cash/bank, or left unpaid (payable)
-- and settled later: unpaid <=> paid_date IS NULL.
CREATE TABLE IF NOT EXISTS purchases (
  id                    SERIAL PRIMARY KEY,
  date                  TEXT NOT NULL,
  supplier              TEXT,
  reference             TEXT,
  note                  TEXT,
  total                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  paid_date             TEXT,
  paid_from_account_id  INTEGER REFERENCES accounts(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id           SERIAL PRIMARY KEY,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id      INTEGER REFERENCES items(id),
  account_id   INTEGER REFERENCES accounts(id),
  description  TEXT,
  quantity     DOUBLE PRECISION,
  amount       DOUBLE PRECISION NOT NULL,
  CHECK ((item_id IS NULL) <> (account_id IS NULL))
);

-- ── Stock lots ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id                SERIAL PRIMARY KEY,
  item_id           INTEGER NOT NULL REFERENCES items(id),
  amount            DOUBLE PRECISION NOT NULL,
  remaining         DOUBLE PRECISION NOT NULL,
  price             DOUBLE PRECISION NOT NULL,
  date_of_purchase  TEXT NOT NULL,
  source            TEXT DEFAULT 'purchase',
  production_id     INTEGER REFERENCES productions(id),
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_line_id INTEGER REFERENCES purchase_lines(id);

-- FIFO scans: open lots of an item, oldest first
CREATE INDEX IF NOT EXISTS inventory_items_fifo_idx
  ON inventory_items (item_id, date_of_purchase, created_at, id)
  WHERE remaining > 0;

-- ── Sellable products ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  unit        TEXT NOT NULL DEFAULT 'pcs',
  sell_price  DOUBLE PRECISION,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What leaves stock when one unit of the product is sold
CREATE TABLE IF NOT EXISTS product_components (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  quantity    DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
  UNIQUE (product_id, item_id)
);

-- ── Sales ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id             SERIAL PRIMARY KEY,
  invoice_num    TEXT,
  customer_name  TEXT,
  date           TEXT,
  note           TEXT,
  subtotal       DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount       DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax_rate       TEXT,
  tax            DOUBLE PRECISION NOT NULL DEFAULT 0,
  total          DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where the money went: cash, bank or receivable (NULL on invoices from before bookkeeping)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_account_id INTEGER REFERENCES accounts(id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id           SERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  qty          DOUBLE PRECISION NOT NULL,
  unit_price   DOUBLE PRECISION NOT NULL,
  subtotal     DOUBLE PRECISION NOT NULL
);

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);

-- Upgraded databases: every final good, and anything that was sold, becomes a product of
-- one item at its last selling price; old sales lines are re-pointed at those products.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoice_items' AND column_name = 'legacy_item_id'
  ) THEN
    INSERT INTO products (name, unit, sell_price)
    SELECT i.name, i.unit_type,
           (SELECT ii.unit_price FROM invoice_items ii
            WHERE ii.legacy_item_id = i.id ORDER BY ii.id DESC LIMIT 1)
    FROM items i
    WHERE i.tier = 'final'
       OR i.id IN (SELECT legacy_item_id FROM invoice_items WHERE legacy_item_id IS NOT NULL)
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO product_components (product_id, item_id, quantity)
    SELECT p.id, i.id, 1
    FROM products p JOIN items i ON i.name = p.name
    ON CONFLICT DO NOTHING;

    UPDATE invoice_items ii SET product_id = p.id
    FROM items i JOIN products p ON p.name = i.name
    WHERE ii.legacy_item_id = i.id;

    ALTER TABLE invoice_items DROP COLUMN legacy_item_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS invoice_item_consumptions (
  id                 SERIAL PRIMARY KEY,
  invoice_item_id    INTEGER NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  inventory_item_id  INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity           DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  quantity    DOUBLE PRECISION NOT NULL,
  note        TEXT,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Bookkeeping ──────────────────────────────────────────────────────────────
-- Double entry: every entry's debits equal its credits. Entries made by the app carry
-- the record they came from (source_type/source_id) and are rewritten or removed with it;
-- source_type 'manual' entries are typed in on the Accounting page.
CREATE TABLE IF NOT EXISTS journal_entries (
  id           SERIAL PRIMARY KEY,
  date         TEXT NOT NULL,
  memo         TEXT,
  source_type  TEXT NOT NULL DEFAULT 'manual',
  source_id    INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id          SERIAL PRIMARY KEY,
  entry_id    INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  debit       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit      DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo        TEXT
);

-- ── Users & access ───────────────────────────────────────────────────────────
-- Username + password accounts, created by an admin (see backend/auth.js).
-- role: 'admin' (manage users + everything), 'staff' (read/write), 'viewer' (read-only)
CREATE TABLE IF NOT EXISTS users (
  id                    SERIAL PRIMARY KEY,
  username              TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  name                  TEXT,
  role                  TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff', 'viewer')),
  password_hash         TEXT NOT NULL,
  must_change_password  BOOLEAN NOT NULL DEFAULT true,
  -- Bumped on password change/reset/deactivation; invalidates all issued session tokens
  token_version         INTEGER NOT NULL DEFAULT 0,
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  active                BOOLEAN NOT NULL DEFAULT true,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who recorded each movement (NULL for rows created before sign-in existed)
ALTER TABLE inventory_items   ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE productions       ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE invoices          ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE purchases         ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE journal_entries   ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE recipe_versions   ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);

-- ── Opening balance ──────────────────────────────────────────────────────────
-- When bookkeeping starts on a database that already holds stock, book that stock's value
-- once against Opening balance so the balance sheet starts from reality.
DO $$
DECLARE entry INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries) AND EXISTS (
    SELECT 1 FROM inventory_items WHERE remaining > 0 AND amount > 0 AND price > 0
  ) THEN
    INSERT INTO journal_entries (date, memo, source_type)
    VALUES (to_char(current_date, 'YYYY-MM-DD'), 'Opening balance: stock on hand when bookkeeping started', 'opening')
    RETURNING id INTO entry;

    INSERT INTO journal_lines (entry_id, account_id, debit, credit)
    SELECT entry, a.id, SUM(l.remaining * l.price / l.amount), 0
    FROM inventory_items l
    JOIN items i ON i.id = l.item_id
    JOIN accounts a ON a.system_key = 'inventory_' || i.tier
    WHERE l.remaining > 0 AND l.amount > 0
    GROUP BY a.id;

    INSERT INTO journal_lines (entry_id, account_id, debit, credit)
    SELECT entry, (SELECT id FROM accounts WHERE system_key = 'opening_balance'), 0, SUM(debit)
    FROM journal_lines WHERE entry_id = entry;
  END IF;
END $$;

-- ── Indexes (Postgres does not index foreign keys automatically) ─────────────
CREATE INDEX IF NOT EXISTS recipes_output_item_id_idx                ON recipes (output_item_id);
CREATE INDEX IF NOT EXISTS recipe_items_recipe_id_idx                ON recipe_items (recipe_id);
CREATE INDEX IF NOT EXISTS recipe_items_item_id_idx                  ON recipe_items (item_id);
CREATE INDEX IF NOT EXISTS recipe_items_version_id_idx               ON recipe_items (version_id);
CREATE INDEX IF NOT EXISTS recipe_versions_output_item_id_idx        ON recipe_versions (output_item_id);
CREATE INDEX IF NOT EXISTS recipe_versions_created_by_idx            ON recipe_versions (created_by);
CREATE INDEX IF NOT EXISTS recipes_current_version_id_idx            ON recipes (current_version_id);
CREATE INDEX IF NOT EXISTS productions_recipe_version_id_idx         ON productions (recipe_version_id);
CREATE INDEX IF NOT EXISTS productions_recipe_id_idx                 ON productions (recipe_id);
CREATE INDEX IF NOT EXISTS productions_parent_production_id_idx      ON productions (parent_production_id);
CREATE INDEX IF NOT EXISTS productions_created_by_idx                ON productions (created_by);
CREATE INDEX IF NOT EXISTS purchases_paid_from_account_id_idx        ON purchases (paid_from_account_id);
CREATE INDEX IF NOT EXISTS purchases_created_by_idx                  ON purchases (created_by);
CREATE INDEX IF NOT EXISTS purchase_lines_purchase_id_idx            ON purchase_lines (purchase_id);
CREATE INDEX IF NOT EXISTS purchase_lines_item_id_idx                ON purchase_lines (item_id);
CREATE INDEX IF NOT EXISTS purchase_lines_account_id_idx             ON purchase_lines (account_id);
CREATE INDEX IF NOT EXISTS inventory_items_item_id_idx               ON inventory_items (item_id);
CREATE INDEX IF NOT EXISTS inventory_items_production_id_idx         ON inventory_items (production_id);
CREATE INDEX IF NOT EXISTS inventory_items_purchase_line_id_idx      ON inventory_items (purchase_line_id);
CREATE INDEX IF NOT EXISTS inventory_items_created_by_idx            ON inventory_items (created_by);
CREATE INDEX IF NOT EXISTS product_components_item_id_idx            ON product_components (item_id);
CREATE INDEX IF NOT EXISTS invoices_created_by_idx                   ON invoices (created_by);
CREATE INDEX IF NOT EXISTS invoices_payment_account_id_idx           ON invoices (payment_account_id);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_id_idx              ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_items_product_id_idx              ON invoice_items (product_id);
CREATE INDEX IF NOT EXISTS invoice_item_consumptions_item_idx        ON invoice_item_consumptions (invoice_item_id);
CREATE INDEX IF NOT EXISTS invoice_item_consumptions_lot_idx         ON invoice_item_consumptions (inventory_item_id);
CREATE INDEX IF NOT EXISTS stock_adjustments_item_id_idx             ON stock_adjustments (item_id);
CREATE INDEX IF NOT EXISTS stock_adjustments_created_by_idx          ON stock_adjustments (created_by);
CREATE INDEX IF NOT EXISTS journal_entries_source_idx                ON journal_entries (source_type, source_id);
CREATE INDEX IF NOT EXISTS journal_entries_date_idx                  ON journal_entries (date);
CREATE INDEX IF NOT EXISTS journal_entries_created_by_idx            ON journal_entries (created_by);
CREATE INDEX IF NOT EXISTS journal_lines_entry_id_idx                ON journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_id_idx              ON journal_lines (account_id);

-- ── Lock down Supabase's Data API ────────────────────────────────────────────
-- All access goes through our backend, which connects as the table owner (RLS does
-- not apply to owners). Supabase's auto-generated REST/GraphQL API would otherwise
-- let anyone holding the public publishable key read these tables as `anon`.
-- RLS with no policies denies everything to anon/authenticated; revoking the grants
-- closes the tables entirely. The roles only exist on Supabase, not in local PGlite.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'items', 'recipes', 'recipe_versions', 'recipe_items', 'productions', 'inventory_items',
    'products', 'product_components', 'purchases', 'purchase_lines',
    'invoices', 'invoice_items', 'invoice_item_consumptions', 'stock_adjustments',
    'accounts', 'journal_entries', 'journal_lines', 'users'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', t);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
  END IF;
END $$;
