-- COGS schema (PostgreSQL). Idempotent: safe to run on every migrate.
-- Quantities and money use DOUBLE PRECISION so the pg driver returns plain JS numbers.
-- Business dates (date_of_purchase, date_produced, ...) stay 'YYYY-MM-DD' TEXT, as before.

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  unit_type   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipes (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  output_product_id  INTEGER NOT NULL REFERENCES products(id),
  items_per_batch    DOUBLE PRECISION NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id                  SERIAL PRIMARY KEY,
  recipe_id           INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id),
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

CREATE TABLE IF NOT EXISTS inventory_items (
  id                SERIAL PRIMARY KEY,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  amount            DOUBLE PRECISION NOT NULL,
  remaining         DOUBLE PRECISION NOT NULL,
  price             DOUBLE PRECISION NOT NULL,
  date_of_purchase  TEXT NOT NULL,
  source            TEXT DEFAULT 'purchase',
  production_id     INTEGER REFERENCES productions(id),
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FIFO scans: open lots of a product, oldest first
CREATE INDEX IF NOT EXISTS inventory_items_fifo_idx
  ON inventory_items (product_id, date_of_purchase, created_at, id)
  WHERE remaining > 0;

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

CREATE TABLE IF NOT EXISTS invoice_items (
  id           SERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  product_id   INTEGER REFERENCES products(id),
  qty          DOUBLE PRECISION NOT NULL,
  unit_price   DOUBLE PRECISION NOT NULL,
  subtotal     DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_item_consumptions (
  id                 SERIAL PRIMARY KEY,
  invoice_item_id    INTEGER NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  inventory_item_id  INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity           DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    DOUBLE PRECISION NOT NULL,
  note        TEXT,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- ── Foreign-key indexes (Postgres does not create these automatically) ───────
CREATE INDEX IF NOT EXISTS recipes_output_product_id_idx            ON recipes (output_product_id);
CREATE INDEX IF NOT EXISTS recipe_items_recipe_id_idx               ON recipe_items (recipe_id);
CREATE INDEX IF NOT EXISTS recipe_items_product_id_idx              ON recipe_items (product_id);
CREATE INDEX IF NOT EXISTS productions_recipe_id_idx                ON productions (recipe_id);
CREATE INDEX IF NOT EXISTS productions_created_by_idx               ON productions (created_by);
CREATE INDEX IF NOT EXISTS inventory_items_product_id_idx           ON inventory_items (product_id);
CREATE INDEX IF NOT EXISTS inventory_items_production_id_idx        ON inventory_items (production_id);
CREATE INDEX IF NOT EXISTS inventory_items_created_by_idx           ON inventory_items (created_by);
CREATE INDEX IF NOT EXISTS invoices_created_by_idx                  ON invoices (created_by);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_id_idx             ON invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_items_product_id_idx             ON invoice_items (product_id);
CREATE INDEX IF NOT EXISTS invoice_item_consumptions_item_idx       ON invoice_item_consumptions (invoice_item_id);
CREATE INDEX IF NOT EXISTS invoice_item_consumptions_lot_idx        ON invoice_item_consumptions (inventory_item_id);
CREATE INDEX IF NOT EXISTS stock_adjustments_product_id_idx         ON stock_adjustments (product_id);
CREATE INDEX IF NOT EXISTS stock_adjustments_created_by_idx         ON stock_adjustments (created_by);

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
    'products', 'recipes', 'recipe_items', 'productions', 'inventory_items',
    'invoices', 'invoice_items', 'invoice_item_consumptions', 'stock_adjustments', 'users'
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
