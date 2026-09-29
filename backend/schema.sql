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
-- Allowlist of people who may sign in (Google via Supabase Auth), matched by email.
-- role: 'admin' (manage users + everything), 'staff' (read/write), 'viewer' (read-only)
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT,
  role           TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff', 'viewer')),
  active         BOOLEAN NOT NULL DEFAULT true,
  auth_user_id   UUID UNIQUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who recorded each movement (NULL for rows created before sign-in existed)
ALTER TABLE inventory_items   ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE productions       ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE invoices          ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
