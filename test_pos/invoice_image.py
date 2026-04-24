"""invoice_image.py — Render an invoice dict to a PIL JPEG image."""

from PIL import Image, ImageDraw, ImageFont
import os

_FONT_DIR = "C:/Windows/Fonts/"
_FONT_CANDIDATES = {
    "regular": ["arial.ttf", "calibri.ttf", "segoeui.ttf", "verdana.ttf"],
    "bold":    ["arialbd.ttf", "calibrib.ttf", "segoeuib.ttf", "verdanab.ttf"],
}


def _get_font(style: str, size: int) -> ImageFont.FreeTypeFont:
    for name in _FONT_CANDIDATES.get(style, _FONT_CANDIDATES["regular"]):
        path = os.path.join(_FONT_DIR, name)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


class _Renderer:
    W = 800
    PAD = 56
    BG = (255, 255, 255)
    FG = (30, 30, 30)
    GRAY = (130, 130, 130)
    RED = (190, 40, 40)
    ACCENT = (44, 123, 229)
    RULE_COLOR = (210, 210, 210)

    def __init__(self, data: dict):
        self.data = data
        self.f_sm    = _get_font("regular", 14)
        self.f_norm  = _get_font("regular", 18)
        self.f_bold  = _get_font("bold",    18)
        self.f_title = _get_font("bold",    32)
        self.f_total = _get_font("bold",    21)

    # ── helpers ──────────────────────────────────────────────────────────────

    def _tw(self, text: str, font) -> int:
        bb = font.getbbox(text)
        return bb[2] - bb[0]

    def _th(self, font) -> int:
        bb = font.getbbox("Ag")
        return bb[3] - bb[1]

    def _rule(self, draw: ImageDraw.ImageDraw, y: int,
              color=None, thickness: int = 1) -> int:
        color = color or self.RULE_COLOR
        draw.line([(self.PAD, y), (self.W - self.PAD, y)],
                  fill=color, width=thickness)
        return y + thickness + 10

    def _center_text(self, draw, y, text, font, color=None):
        color = color or self.FG
        w = self._tw(text, font)
        draw.text(((self.W - w) // 2, y), text, font=font, fill=color)
        return y + self._th(font) + 6

    def _left_right(self, draw, y, left, right, left_font, right_font,
                    left_color=None, right_color=None):
        left_color = left_color or self.FG
        right_color = right_color or self.FG
        draw.text((self.PAD, y), left, font=left_font, fill=left_color)
        rw = self._tw(right, right_font)
        draw.text((self.W - self.PAD - rw, y), right,
                  font=right_font, fill=right_color)
        return y + max(self._th(left_font), self._th(right_font)) + 8

    # ── sections ─────────────────────────────────────────────────────────────

    def _draw_logo(self, img: Image.Image, y: int) -> int:
        logo_path = self.data.get("logo_path", "")
        if not logo_path or not os.path.exists(logo_path):
            return y
        try:
            logo = Image.open(logo_path).convert("RGBA")
            bg = Image.new("RGBA", logo.size, (255, 255, 255, 255))
            bg.paste(logo, mask=logo.split()[3])
            logo = bg.convert("RGB")
            logo.thumbnail((400, 200), Image.LANCZOS)
            x = (self.W - logo.width) // 2
            img.paste(logo, (x, y))
            return y + logo.height + 18
        except Exception:
            return y

    def _draw_header(self, draw: ImageDraw.ImageDraw, y: int) -> int:
        y = self._center_text(draw, y,
                              self.data.get("business_name", ""),
                              self.f_title)
        y += 2
        for key in ("business_address", "business_phone"):
            val = self.data.get(key, "").strip()
            if val:
                y = self._center_text(draw, y, val, self.f_norm, self.GRAY)
        y += 10
        y = self._rule(draw, y, thickness=2)
        return y

    def _draw_meta(self, draw: ImageDraw.ImageDraw, y: int) -> int:
        inv_num  = self.data.get("invoice_num", "")
        date     = self.data.get("date", "")
        customer = self.data.get("customer_name", "").strip()
        note     = self.data.get("note", "").strip()

        y = self._left_right(draw, y,
                             f"Invoice #{inv_num}", date,
                             self.f_bold, self.f_norm,
                             right_color=self.GRAY)
        if customer:
            draw.text((self.PAD, y), f"Customer:  {customer}",
                      font=self.f_norm, fill=self.FG)
            y += self._th(self.f_norm) + 8
        if note:
            draw.text((self.PAD, y), f"Note:  {note}",
                      font=self.f_norm, fill=self.GRAY)
            y += self._th(self.f_norm) + 8

        y += 6
        y = self._rule(draw, y)
        return y

    def _draw_items(self, draw: ImageDraw.ImageDraw, y: int) -> int:
        right = self.W - self.PAD
        col_sub   = right
        col_price = right - 165
        col_qty   = right - 305
        desc_max  = col_qty - self.PAD - 16

        # Header
        draw.text((self.PAD, y),    "Description", font=self.f_bold, fill=self.FG)
        draw.text((col_qty,   y),   "Qty",    font=self.f_bold, fill=self.FG, anchor="ra")
        draw.text((col_price, y),   "Price",  font=self.f_bold, fill=self.FG, anchor="ra")
        draw.text((col_sub,   y),   "Amount", font=self.f_bold, fill=self.FG, anchor="ra")
        y += self._th(self.f_bold) + 6
        y = self._rule(draw, y)

        row_h = self._th(self.f_norm) + 10
        for item in self.data.get("items", []):
            # Truncate description if too wide
            desc = item["desc"]
            while self._tw(desc, self.f_norm) > desc_max and len(desc) > 1:
                desc = desc[:-1]
            draw.text((self.PAD,    y), desc,
                      font=self.f_norm, fill=self.FG)
            draw.text((col_qty,   y), f"{item['qty']:.0f}",
                      font=self.f_norm, fill=self.FG, anchor="ra")
            draw.text((col_price, y), f"Rp {item['price']:,.0f}",
                      font=self.f_norm, fill=self.FG, anchor="ra")
            draw.text((col_sub,   y), f"Rp {item['subtotal']:,.0f}",
                      font=self.f_norm, fill=self.FG, anchor="ra")
            y += row_h

        y += 4
        y = self._rule(draw, y, thickness=2)
        return y

    def _draw_totals(self, draw: ImageDraw.ImageDraw, y: int) -> int:
        right   = self.W - self.PAD
        label_x = self.W - self.PAD - 320
        row_h   = self._th(self.f_norm) + 10

        def tline(label, value, font_l=None, font_v=None, color=None):
            nonlocal y
            fl = font_l or self.f_norm
            fv = font_v or self.f_norm
            c  = color or self.FG
            draw.text((label_x, y), label, font=fl, fill=c)
            draw.text((right,   y), value, font=fv, fill=c, anchor="ra")
            y += row_h

        tline("Subtotal:", f"Rp {self.data['subtotal']:,.0f}")

        disc_pct = self.data.get("discount_pct", 0)
        if disc_pct:
            tline(f"Discount ({disc_pct:.0f}%):",
                  f"- Rp {self.data['discount']:,.0f}",
                  color=self.RED)

        try:
            tax_rate = float(self.data.get("tax_rate", "0"))
        except ValueError:
            tax_rate = 0.0
        if tax_rate:
            tline(f"Tax ({tax_rate}%):", f"Rp {self.data['tax']:,.0f}")

        # separator + bold total
        draw.line([(label_x, y), (right, y)],
                  fill=(180, 180, 180), width=1)
        y += 8
        tline("TOTAL:", f"Rp {self.data['total']:,.0f}",
              font_l=self.f_total, font_v=self.f_total, color=self.ACCENT)
        return y

    def _draw_footer(self, draw: ImageDraw.ImageDraw, y: int) -> int:
        footer = self.data.get("footer_text", "").strip()
        if not footer:
            return y
        y += 16
        y = self._rule(draw, y)
        y = self._center_text(draw, y, footer, self.f_sm, self.GRAY)
        return y

    # ── main ─────────────────────────────────────────────────────────────────

    def render(self) -> Image.Image:
        # Draw on a tall scratch canvas, then crop to content
        scratch = Image.new("RGB", (self.W, 4000), self.BG)
        draw    = ImageDraw.Draw(scratch)
        y = self.PAD
        y = self._draw_logo(scratch, y)
        y = self._draw_header(draw, y)
        y = self._draw_meta(draw, y)
        y = self._draw_items(draw, y)
        y = self._draw_totals(draw, y)
        y = self._draw_footer(draw, y)
        y += self.PAD
        return scratch.crop((0, 0, self.W, y))


def render_invoice_image(data: dict) -> Image.Image:
    return _Renderer(data).render()
