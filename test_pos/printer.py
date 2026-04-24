"""
printer.py  –  ESC/POS invoice printing via python-escpos (Win32Raw)
"""

import os
from escpos.printer import Win32Raw
from PIL import Image, ImageOps

# Characters per line for each paper width
PAPER_CHARS = {"58": 32, "80": 48}


def _chars(paper_width: str) -> int:
    return PAPER_CHARS.get(str(paper_width), 32)


def _divider(char: str, n: int) -> str:
    return char * n + "\n"


def _ljust_rjust(left: str, right: str, width: int) -> str:
    """Fit left + right text into exactly `width` chars."""
    gap = width - len(left) - len(right)
    if gap < 1:
        gap = 1
        left = left[: width - len(right) - 1]
    return left + " " * gap + right + "\n"


def _prepare_logo(logo_path: str, max_px: int = 400) -> Image.Image | None:
    """Load, convert, and resize a PNG logo for thermal printing."""
    if not logo_path or not os.path.exists(logo_path):
        return None
    try:
        img = Image.open(logo_path).convert("RGBA")

        # Flatten transparency onto white background
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        img = bg.convert("L")  # grayscale

        # Resize if wider than max_px
        if img.width > max_px:
            ratio = max_px / img.width
            img = img.resize(
                (max_px, int(img.height * ratio)), Image.LANCZOS)

        # Convert to 1-bit (monochrome) for ESC/POS
        img = img.convert("1")
        return img
    except Exception as exc:
        print(f"[printer] Logo load failed: {exc}")
        return None


def print_invoice(printer_name: str, data: dict) -> None:
    """Send an invoice to the named Windows printer via ESC/POS."""

    cols = _chars(data.get("paper_width", "58"))
    p = Win32Raw(printer_name)

    try:
        # ── Logo ────────────────────────────────────────────────────────────
        logo = _prepare_logo(data.get("logo_path", ""), max_px=cols * 8)
        if logo:
            p.image(logo, impl="bitImageRaster", center=True)
            p.ln(1)

        # ── Business header ──────────────────────────────────────────────────
        p.set(align="center", bold=True, width=2, height=2)
        p.text(data.get("business_name", "") + "\n")
        p.set(align="center", bold=False, width=1, height=1)
        p.text(data.get("business_address", "") + "\n")
        p.text(data.get("business_phone", "") + "\n")

        p.text(_divider("-", cols))

        # ── Invoice meta ─────────────────────────────────────────────────────
        p.set(align="left")
        inv_num = data.get("invoice_num", "")
        inv_date = data.get("date", "")
        p.text(_ljust_rjust(f"Invoice #{inv_num}", inv_date, cols))

        customer = data.get("customer_name", "")
        if customer:
            p.text(f"Customer: {customer}\n")

        note = data.get("note", "")
        if note:
            p.text(f"Note: {note}\n")

        p.text(_divider("-", cols))

        # ── Items header ─────────────────────────────────────────────────────
        # Two-line layout per item:
        #   Line 1: description (full width)
        #   Line 2: "  {qty} x Rp {price}"  right-padded  "Rp {subtotal}"
        p.set(bold=True)
        p.text("Item\n")
        p.set(bold=False)
        p.text(_divider("-", cols))

        # ── Items ────────────────────────────────────────────────────────────
        for item in data.get("items", []):
            desc = item["desc"]
            qty = item["qty"]
            price = item["price"]
            subtotal = item["subtotal"]

            # Description line(s)
            while desc:
                p.text(desc[:cols] + "\n")
                desc = desc[cols:]

            # Qty × price = subtotal line
            detail_left = f"  {qty:.0f} x Rp {price:,.0f}"
            detail_right = f"Rp {subtotal:,.0f}"
            p.text(_ljust_rjust(detail_left, detail_right, cols))

        # ── Totals ───────────────────────────────────────────────────────────
        p.text(_divider("=", cols))

        p.text(_ljust_rjust("Subtotal:", f"Rp {data['subtotal']:,.0f}", cols))

        discount_pct = data.get("discount_pct", 0)
        if discount_pct:
            p.text(_ljust_rjust(f"Discount ({discount_pct:.0f}%):",
                                f"- Rp {data['discount']:,.0f}", cols))

        try:
            tax_rate = float(data.get("tax_rate", "0"))
        except ValueError:
            tax_rate = 0.0

        if tax_rate:
            p.text(_ljust_rjust(f"Tax ({tax_rate}%):",
                                f"Rp {data['tax']:,.0f}", cols))

        p.text(_divider("-", cols))

        p.set(bold=True)
        p.text(_ljust_rjust("TOTAL:", f"Rp {data['total']:,.0f}", cols))
        p.set(bold=False)

        p.text(_divider("=", cols))

        # ── Footer ───────────────────────────────────────────────────────────
        footer = data.get("footer_text", "").strip()
        if footer:
            p.ln(1)
            p.set(align="center")
            p.text(footer + "\n")

        # Feed and cut
        p.ln(3)
        p.cut()

    finally:
        p.close()
