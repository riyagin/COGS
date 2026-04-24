"""
db.py — Shared SQLite connection to the COGS database.

The Python sqlite3 module is built-in so no extra install is needed.
WAL mode is already set by the Node.js side; we just connect as a reader/writer.
"""

import sqlite3
import os

_db_path: str = ""
_conn: sqlite3.Connection | None = None


def set_path(path: str) -> None:
    global _db_path, _conn
    _db_path = path.strip()
    if _conn:
        _conn.close()
        _conn = None


def _connect() -> sqlite3.Connection | None:
    global _conn
    if _conn:
        return _conn
    if not _db_path or not os.path.exists(_db_path):
        return None
    try:
        _conn = sqlite3.connect(_db_path, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        return _conn
    except Exception as e:
        print(f"[db] Connection failed: {e}")
        return None


def is_connected() -> bool:
    return _connect() is not None


def get_products() -> list[dict]:
    """Return products that have produced inventory (source='production') with stock remaining."""
    conn = _connect()
    if not conn:
        return []
    try:
        rows = conn.execute("""
            SELECT DISTINCT p.id, p.name, p.unit_type
            FROM products p
            JOIN inventory_items i ON p.id = i.product_id
            WHERE i.source = 'production' AND i.remaining > 0
            ORDER BY p.name
        """).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"[db] get_products failed: {e}")
        return []


def get_avg_price(product_id: int) -> float:
    """Weighted-average unit price for a product (from remaining inventory)."""
    conn = _connect()
    if not conn:
        return 0.0
    try:
        row = conn.execute("""
            SELECT SUM(remaining * (price / amount)) / NULLIF(SUM(remaining), 0)
            FROM inventory_items
            WHERE product_id = ? AND remaining > 0
        """, (product_id,)).fetchone()
        return float(row[0]) if row and row[0] is not None else 0.0
    except Exception as e:
        print(f"[db] get_avg_price failed: {e}")
        return 0.0


def save_invoice(inv: dict) -> int:
    """
    Persist a completed invoice to the shared DB.
    Returns the new invoice id, or raises on failure.
    """
    conn = _connect()
    if not conn:
        raise RuntimeError(
            "Not connected to COGS database.\n"
            "Set the database path in Settings → COGS Integration."
        )

    cur = conn.execute("""
        INSERT INTO invoices
          (invoice_num, customer_name, date, note,
           subtotal, discount_pct, discount, tax_rate, tax, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        inv.get("invoice_num", ""),
        inv.get("customer_name", ""),
        inv.get("date", ""),
        inv.get("note", ""),
        inv.get("subtotal", 0),
        inv.get("discount_pct", 0),
        inv.get("discount", 0),
        str(inv.get("tax_rate", "0")),
        inv.get("tax", 0),
        inv.get("total", 0),
    ))
    invoice_id = cur.lastrowid

    for item in inv.get("items", []):
        conn.execute("""
            INSERT INTO invoice_items
              (invoice_id, description, product_id, qty, unit_price, subtotal)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            invoice_id,
            item.get("desc", ""),
            item.get("product_id") or None,
            item.get("qty", 0),
            item.get("price", 0),
            item.get("subtotal", 0),
        ))

        # FIFO drawdown of produced inventory for this item
        product_id = item.get("product_id")
        qty_needed = float(item.get("qty", 0))
        if product_id and qty_needed > 0:
            inv_rows = conn.execute("""
                SELECT id, remaining
                FROM inventory_items
                WHERE product_id = ? AND source = 'production' AND remaining > 0
                ORDER BY date_of_purchase ASC, created_at ASC
            """, (product_id,)).fetchall()

            to_consume = qty_needed
            for inv_row in inv_rows:
                if to_consume <= 0.0001:
                    break
                take = min(to_consume, inv_row["remaining"])
                conn.execute(
                    "UPDATE inventory_items SET remaining = remaining - ? WHERE id = ?",
                    (take, inv_row["id"])
                )
                to_consume -= take

    conn.commit()
    return invoice_id
