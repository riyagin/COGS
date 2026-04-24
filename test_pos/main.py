import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import json
import os
import sys
import threading
from datetime import datetime

# When frozen by PyInstaller, store config next to the .exe
if getattr(sys, 'frozen', False):
    _APP_DIR = os.path.dirname(sys.executable)
else:
    _APP_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG_FILE = os.path.join(_APP_DIR, "config.json")

DEFAULT_CONFIG = {
    "business_name": "My Business",
    "business_address": "123 Main St, City, State",
    "business_phone": "(555) 000-0000",
    "logo_path": "",
    "printer_name": "",
    "tax_rate": "0",
    "paper_width": "58",
    "invoice_counter": 1,
    "footer_text": "Thank you for your business!",
    "cogs_db_path": "",
    "save_to_db": True,
}

PAPER_CHARS = {"58": 32, "80": 48}


class InvoiceApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Invoice Printer")
        self.root.geometry("960x720")
        self.root.minsize(820, 620)
        self.config = self._load_config()
        self.item_rows = []
        self.lbl_sub = self.lbl_discount = self.lbl_tax = self.lbl_total = None
        self._product_list = []   # [{"id": int, "name": str, "unit_type": str}]
        self._product_names = []  # parallel list of names for comboboxes
        self._setup_style()
        self._build_ui()
        # Connect to COGS DB if path is already saved
        if self.config.get("cogs_db_path"):
            import db as cogs_db
            cogs_db.set_path(self.config["cogs_db_path"])
            self._refresh_product_list()

    # ── Config ──────────────────────────────────────────────────────────────

    def _load_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r") as f:
                    cfg = json.load(f)
                for k, v in DEFAULT_CONFIG.items():
                    cfg.setdefault(k, v)
                return cfg
            except Exception:
                pass
        return DEFAULT_CONFIG.copy()

    def _save_config(self):
        with open(CONFIG_FILE, "w") as f:
            json.dump(self.config, f, indent=2)

    # ── Style ────────────────────────────────────────────────────────────────

    def _setup_style(self):
        style = ttk.Style()
        style.theme_use("clam")
        bg = "#f0f2f5"
        self.root.configure(bg=bg)
        style.configure("TFrame", background=bg)
        style.configure("TLabel", background=bg, foreground="#222")
        style.configure("TLabelframe", background=bg)
        style.configure("TLabelframe.Label", background=bg, foreground="#333",
                        font=("Segoe UI", 10, "bold"))
        style.configure("TNotebook", background=bg)
        style.configure("TNotebook.Tab", font=("Segoe UI", 10), padding=[14, 6])
        style.configure("TEntry", padding=[4, 4])
        style.configure("TButton", font=("Segoe UI", 10), padding=[8, 5])
        style.configure("Title.TLabel", font=("Segoe UI", 20, "bold"),
                        background=bg, foreground="#1a1a2e")
        style.configure("Header.TLabel", font=("Segoe UI", 10, "bold"),
                        background=bg, foreground="#444")
        style.configure("Sub.TLabel", font=("Segoe UI", 9),
                        background=bg, foreground="#888")
        style.configure("Total.TLabel", font=("Segoe UI", 13, "bold"),
                        background=bg, foreground="#1a1a2e")
        style.configure("Print.TButton", font=("Segoe UI", 12, "bold"),
                        padding=[28, 10])
        style.map("Print.TButton",
                  background=[("active", "#1a5cbf"), ("!active", "#2c7be5")],
                  foreground=[("active", "white"), ("!active", "white")])

    # ── UI Build ─────────────────────────────────────────────────────────────

    def _build_ui(self):
        top = ttk.Frame(self.root, padding=(18, 14, 18, 4))
        top.pack(fill="x")
        ttk.Label(top, text="Invoice Printer", style="Title.TLabel").pack(side="left")

        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill="both", expand=True, padx=14, pady=(6, 14))

        inv_tab = ttk.Frame(self.nb, padding=14)
        self.nb.add(inv_tab, text="  Invoice  ")

        cfg_tab = ttk.Frame(self.nb, padding=14)
        self.nb.add(cfg_tab, text="  Settings  ")

        self._build_invoice_tab(inv_tab)
        self._build_settings_tab(cfg_tab)

    # ── Invoice Tab ──────────────────────────────────────────────────────────

    def _build_invoice_tab(self, parent):
        # Outer scrollable container for the whole tab
        outer_canvas = tk.Canvas(parent, bg="#f0f2f5", highlightthickness=0)
        outer_sb = ttk.Scrollbar(parent, orient="vertical",
                                 command=outer_canvas.yview)
        outer_canvas.configure(yscrollcommand=outer_sb.set)
        outer_sb.pack(side="right", fill="y")
        outer_canvas.pack(side="left", fill="both", expand=True)

        scroll_frame = ttk.Frame(outer_canvas)
        scroll_win = outer_canvas.create_window(
            (0, 0), window=scroll_frame, anchor="nw")

        def _on_scroll_frame_configure(e):
            outer_canvas.configure(scrollregion=outer_canvas.bbox("all"))

        def _on_outer_canvas_configure(e):
            outer_canvas.itemconfig(scroll_win, width=e.width)

        scroll_frame.bind("<Configure>", _on_scroll_frame_configure)
        outer_canvas.bind("<Configure>", _on_outer_canvas_configure)

        def _on_mousewheel(e):
            outer_canvas.yview_scroll(-1 * (e.delta // 120), "units")

        outer_canvas.bind("<Enter>",
                          lambda e: outer_canvas.bind_all("<MouseWheel>",
                                                          _on_mousewheel))
        outer_canvas.bind("<Leave>",
                          lambda e: outer_canvas.unbind_all("<MouseWheel>"))

        # All content goes into scroll_frame from here on
        parent = scroll_frame

        # ---- Customer info ----
        info = ttk.LabelFrame(parent, text=" Customer & Invoice ", padding=12)
        info.pack(fill="x", pady=(0, 10))

        g = ttk.Frame(info)
        g.pack(fill="x")
        g.columnconfigure(1, weight=2)
        g.columnconfigure(3, weight=1)
        g.columnconfigure(5, weight=1)

        def row(label, col, width=None):
            ttk.Label(g, text=label).grid(row=0, column=col, sticky="w",
                                          padx=(0 if col == 0 else 16, 6), pady=4)
            e = ttk.Entry(g, width=width)
            e.grid(row=0, column=col + 1, sticky="ew", pady=4)
            return e

        self.e_customer = row("Customer:", 0, 28)
        self.e_inv_num = row("Invoice #:", 2, 12)
        self.e_inv_num.insert(0, str(self.config.get("invoice_counter", 1)))
        self.e_date = row("Date:", 4, 13)
        self.e_date.insert(0, datetime.now().strftime("%m/%d/%Y"))

        ttk.Label(g, text="Note:").grid(row=1, column=0, sticky="w",
                                        padx=(0, 6), pady=4)
        self.e_note = ttk.Entry(g)
        self.e_note.grid(row=1, column=1, columnspan=5, sticky="ew", pady=4)

        # ---- Items ----
        items_lf = ttk.LabelFrame(parent, text=" Items ", padding=12)
        items_lf.pack(fill="x", pady=(0, 10))

        # Column headers
        hdr = ttk.Frame(items_lf)
        hdr.pack(fill="x")
        ttk.Label(hdr, text="Description", style="Header.TLabel").pack(
            side="left", padx=(2, 0))
        ttk.Label(hdr, text="Qty", style="Header.TLabel", width=6).pack(
            side="right", padx=(0, 82))
        ttk.Label(hdr, text="Unit Price", style="Header.TLabel", width=11).pack(
            side="right", padx=(0, 4))
        ttk.Label(hdr, text="Subtotal", style="Header.TLabel", width=11).pack(
            side="right", padx=(0, 0))
        ttk.Separator(items_lf, orient="horizontal").pack(fill="x", pady=(4, 6))

        # Scrollable rows
        wrap = ttk.Frame(items_lf)
        wrap.pack(fill="both", expand=True)
        self._canvas = tk.Canvas(wrap, bg="#f0f2f5", highlightthickness=0, height=220)
        sb = ttk.Scrollbar(wrap, orient="vertical", command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=sb.set)
        self._canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self._rows_frame = ttk.Frame(self._canvas)
        self._rows_win = self._canvas.create_window(
            (0, 0), window=self._rows_frame, anchor="nw")
        self._rows_frame.bind("<Configure>",
                              lambda e: self._canvas.configure(
                                  scrollregion=self._canvas.bbox("all")))
        self._canvas.bind("<Configure>",
                          lambda e: self._canvas.itemconfig(
                              self._rows_win, width=e.width))
        def _items_scroll(e):
            self._canvas.yview_scroll(-1 * (e.delta // 120), "units")

        self._canvas.bind("<Enter>",
                          lambda e: self._canvas.bind_all(
                              "<MouseWheel>", _items_scroll))
        self._canvas.bind("<Leave>",
                          lambda e: self._canvas.unbind_all("<MouseWheel>"))

        for _ in range(4):
            self._add_row()

        # Add / Remove buttons
        btn_row = ttk.Frame(items_lf)
        btn_row.pack(fill="x", pady=(8, 0))
        ttk.Button(btn_row, text="+ Add Item",
                   command=self._add_row).pack(side="left", padx=(0, 8))
        ttk.Button(btn_row, text="- Remove Last",
                   command=self._remove_row).pack(side="left")

        # ---- Totals ----
        totals_lf = ttk.LabelFrame(parent, text=" Totals ", padding=12)
        totals_lf.pack(fill="x", pady=(0, 10))

        tf = ttk.Frame(totals_lf)
        tf.pack(side="right")

        def total_row(label, r, bold=False):
            lbl_style = "Total.TLabel" if bold else "TLabel"
            ttk.Label(tf, text=label, style=lbl_style).grid(
                row=r, column=0, sticky="e", padx=(0, 16), pady=2)
            val = ttk.Label(tf, text="Rp 0", width=14, anchor="e",
                            style=lbl_style)
            val.grid(row=r, column=1, sticky="e", pady=2)
            return val

        self.lbl_sub = total_row("Subtotal:", 0)

        # Discount input row
        ttk.Label(tf, text="Discount (%):").grid(
            row=1, column=0, sticky="e", padx=(0, 16), pady=2)
        self.e_discount = ttk.Entry(tf, width=8)
        self.e_discount.insert(0, "0")
        self.e_discount.grid(row=1, column=1, sticky="e", pady=2)
        self.e_discount.bind("<KeyRelease>", lambda _e: self._update_totals())

        self.lbl_discount = total_row("Discount:", 2)
        self.lbl_tax = total_row("Tax:", 3)
        ttk.Separator(tf, orient="horizontal").grid(
            row=4, column=0, columnspan=2, sticky="ew", pady=5)
        self.lbl_total = total_row("TOTAL:", 5, bold=True)

        # ---- Action buttons ----
        btn_bar = ttk.Frame(parent)
        btn_bar.pack(pady=8)
        ttk.Button(btn_bar, text="💾  Save Invoice",
                   style="Print.TButton",
                   command=self._save_invoice_only).pack(side="left", padx=(0, 10))
        ttk.Button(btn_bar, text="🖼  Generate JPEG",
                   command=self._save_as_jpg).pack(side="left", padx=(0, 10))
        ttk.Button(btn_bar, text="🖨  Print",
                   command=self._print_invoice).pack(side="left")

    def _refresh_product_list(self):
        """Reload product names from COGS DB and update all comboboxes."""
        import db as cogs_db
        self._product_list = cogs_db.get_products()
        self._product_names = [p["name"] for p in self._product_list]
        for row in self.item_rows:
            row["desc"]["values"] = self._product_names

    def _on_product_selected(self, row: dict, event=None):
        """Auto-fill price when a COGS product is chosen from the combobox."""
        name = row["desc"].get().strip()
        match = next((p for p in self._product_list if p["name"] == name), None)
        if match:
            import db as cogs_db
            avg = cogs_db.get_avg_price(match["id"])
            row["price"].delete(0, "end")
            row["price"].insert(0, str(int(avg)))
            row["product_id"] = match["id"]
            self._update_totals()
        else:
            row["product_id"] = None

    def _add_row(self):
        f = ttk.Frame(self._rows_frame)
        f.pack(fill="x", pady=2, padx=2)

        desc = ttk.Combobox(f, values=self._product_names)
        desc.pack(side="left", fill="x", expand=True, padx=(0, 6))

        qty = ttk.Entry(f, width=6)
        qty.insert(0, "1")
        qty.pack(side="left", padx=(0, 6))

        price = ttk.Entry(f, width=11)
        price.insert(0, "0")
        price.pack(side="left", padx=(0, 6))

        sub_lbl = ttk.Label(f, text="Rp 0", width=14, anchor="e")
        sub_lbl.pack(side="left")

        row_data = {"frame": f, "desc": desc, "qty": qty,
                    "price": price, "sub_lbl": sub_lbl, "product_id": None}

        desc.bind("<<ComboboxSelected>>",
                  lambda e, r=row_data: self._on_product_selected(r, e))
        for w in (qty, price):
            w.bind("<KeyRelease>", lambda _e: self._update_totals())

        self.item_rows.append(row_data)
        self._update_totals()

    def _remove_row(self):
        if len(self.item_rows) > 1:
            row = self.item_rows.pop()
            row["frame"].destroy()
            self._update_totals()

    def _update_totals(self):
        if self.lbl_sub is None:
            return
        try:
            tax_rate = float(self.config.get("tax_rate", "0")) / 100
        except ValueError:
            tax_rate = 0.0

        subtotal = 0.0
        for row in self.item_rows:
            try:
                qty = float(row["qty"].get() or 0)
                price = float(row["price"].get() or 0)
                sub = qty * price
            except ValueError:
                sub = 0.0
            row["sub_lbl"].config(text=f"Rp {sub:,.0f}")
            subtotal += sub

        try:
            discount_pct = float(self.e_discount.get() or 0)
        except ValueError:
            discount_pct = 0.0

        discount = subtotal * (discount_pct / 100)
        discounted = subtotal - discount
        tax = discounted * tax_rate
        total = discounted + tax
        self.lbl_sub.config(text=f"Rp {subtotal:,.0f}")
        self.lbl_discount.config(text=f"- Rp {discount:,.0f}")
        self.lbl_tax.config(text=f"Rp {tax:,.0f}")
        self.lbl_total.config(text=f"Rp {total:,.0f}")

    # ── Settings Tab ─────────────────────────────────────────────────────────

    def _build_settings_tab(self, parent):
        # Scrollable container (same pattern as invoice tab)
        outer_canvas = tk.Canvas(parent, bg="#f0f2f5", highlightthickness=0)
        outer_sb = ttk.Scrollbar(parent, orient="vertical",
                                 command=outer_canvas.yview)
        outer_canvas.configure(yscrollcommand=outer_sb.set)
        outer_sb.pack(side="right", fill="y")
        outer_canvas.pack(side="left", fill="both", expand=True)

        scroll_frame = ttk.Frame(outer_canvas)
        scroll_win = outer_canvas.create_window(
            (0, 0), window=scroll_frame, anchor="nw")

        def _on_cfg_frame_configure(e):
            outer_canvas.configure(scrollregion=outer_canvas.bbox("all"))

        def _on_cfg_canvas_configure(e):
            outer_canvas.itemconfig(scroll_win, width=e.width)

        scroll_frame.bind("<Configure>", _on_cfg_frame_configure)
        outer_canvas.bind("<Configure>", _on_cfg_canvas_configure)

        def _on_cfg_mousewheel(e):
            outer_canvas.yview_scroll(-1 * (e.delta // 120), "units")

        outer_canvas.bind("<Enter>",
                          lambda e: outer_canvas.bind_all("<MouseWheel>",
                                                          _on_cfg_mousewheel))
        outer_canvas.bind("<Leave>",
                          lambda e: outer_canvas.unbind_all("<MouseWheel>"))

        # All content goes into scroll_frame from here on
        parent = scroll_frame

        # Business info
        biz = ttk.LabelFrame(parent, text=" Business Info ", padding=12)
        biz.pack(fill="x", pady=(0, 10))
        biz.columnconfigure(1, weight=1)

        self._sv = {}
        biz_fields = [
            ("Business Name:", "business_name"),
            ("Address:",       "business_address"),
            ("Phone:",         "business_phone"),
            ("Footer Text:",   "footer_text"),
        ]
        for i, (label, key) in enumerate(biz_fields):
            ttk.Label(biz, text=label).grid(row=i, column=0, sticky="w",
                                            padx=(0, 12), pady=5)
            e = ttk.Entry(biz, width=50)
            e.insert(0, self.config.get(key, ""))
            e.grid(row=i, column=1, sticky="ew", pady=5)
            self._sv[key] = e

        # Logo
        logo_lf = ttk.LabelFrame(parent, text=" Logo ", padding=12)
        logo_lf.pack(fill="x", pady=(0, 10))

        logo_row = ttk.Frame(logo_lf)
        logo_row.pack(fill="x")
        ttk.Label(logo_row, text="PNG file:").pack(side="left", padx=(0, 10))
        self._logo_var = tk.StringVar(value=self.config.get("logo_path", ""))
        ttk.Entry(logo_row, textvariable=self._logo_var,
                  width=46).pack(side="left", fill="x", expand=True, padx=(0, 8))
        ttk.Button(logo_row, text="Browse…",
                   command=self._browse_logo).pack(side="left")
        ttk.Label(logo_lf,
                  text="Tip: transparent-background PNG, ~300-400 px wide works best.",
                  style="Sub.TLabel").pack(anchor="w", pady=(6, 0))

        # Printer & paper
        pp = ttk.LabelFrame(parent, text=" Printer & Paper ", padding=12)
        pp.pack(fill="x", pady=(0, 10))
        pp.columnconfigure(1, weight=1)

        ttk.Label(pp, text="Windows Printer Name:").grid(
            row=0, column=0, sticky="w", padx=(0, 12), pady=5)
        self._e_printer = ttk.Entry(pp, width=40)
        self._e_printer.insert(0, self.config.get("printer_name", ""))
        self._e_printer.grid(row=0, column=1, sticky="ew", pady=5)
        ttk.Label(pp,
                  text="Exact name from Windows Settings → Printers & scanners",
                  style="Sub.TLabel").grid(row=1, column=1, sticky="w")

        ttk.Label(pp, text="Paper width:").grid(
            row=2, column=0, sticky="w", padx=(0, 12), pady=5)
        pw_frame = ttk.Frame(pp)
        pw_frame.grid(row=2, column=1, sticky="w", pady=5)
        self._paper_var = tk.StringVar(value=self.config.get("paper_width", "58"))
        for txt, val in (("58 mm (32 chars)", "58"), ("80 mm (48 chars)", "80")):
            ttk.Radiobutton(pw_frame, text=txt, variable=self._paper_var,
                            value=val).pack(side="left", padx=(0, 16))

        ttk.Label(pp, text="Tax Rate (%):").grid(
            row=3, column=0, sticky="w", padx=(0, 12), pady=5)
        self._e_tax = ttk.Entry(pp, width=10)
        self._e_tax.insert(0, str(self.config.get("tax_rate", "0")))
        self._e_tax.grid(row=3, column=1, sticky="w", pady=5)

        # COGS Integration
        cogs_lf = ttk.LabelFrame(parent, text=" COGS Integration ", padding=12)
        cogs_lf.pack(fill="x", pady=(0, 10))
        cogs_lf.columnconfigure(1, weight=1)

        ttk.Label(cogs_lf, text="cogs.db path:").grid(
            row=0, column=0, sticky="w", padx=(0, 12), pady=5)
        cogs_row = ttk.Frame(cogs_lf)
        cogs_row.grid(row=0, column=1, sticky="ew", pady=5)
        cogs_row.columnconfigure(0, weight=1)
        self._cogs_db_var = tk.StringVar(value=self.config.get("cogs_db_path", ""))
        ttk.Entry(cogs_row, textvariable=self._cogs_db_var).pack(
            side="left", fill="x", expand=True, padx=(0, 8))
        ttk.Button(cogs_row, text="Browse…",
                   command=self._browse_cogs_db).pack(side="left")

        self._save_to_db_var = tk.BooleanVar(
            value=self.config.get("save_to_db", True))
        ttk.Checkbutton(cogs_lf,
                        text="Save invoices to COGS database on print / export",
                        variable=self._save_to_db_var).grid(
            row=1, column=0, columnspan=2, sticky="w", pady=(0, 4))

        ttk.Label(cogs_lf,
                  text="Point this to COGS/backend/cogs.db to share products and invoice history.",
                  style="Sub.TLabel").grid(row=2, column=0, columnspan=2, sticky="w")

        self._cogs_status = ttk.Label(cogs_lf, text="", style="Sub.TLabel")
        self._cogs_status.grid(row=3, column=0, columnspan=2, sticky="w", pady=(4, 0))

        ttk.Button(cogs_lf, text="Test Connection",
                   command=self._test_cogs_connection).grid(
            row=4, column=0, columnspan=2, sticky="w", pady=(6, 0))

        ttk.Button(parent, text="Save Settings",
                   command=self._save_settings).pack(pady=8)

    def _browse_logo(self):
        path = filedialog.askopenfilename(
            title="Select Logo",
            filetypes=[("PNG files", "*.png"), ("All files", "*.*")])
        if path:
            self._logo_var.set(path)

    def _browse_cogs_db(self):
        path = filedialog.askopenfilename(
            title="Select cogs.db",
            filetypes=[("SQLite database", "*.db"), ("All files", "*.*")])
        if path:
            self._cogs_db_var.set(path)

    def _test_cogs_connection(self):
        import db as cogs_db
        cogs_db.set_path(self._cogs_db_var.get())
        if cogs_db.is_connected():
            products = cogs_db.get_products()
            self._cogs_status.config(
                text=f"Connected — {len(products)} products found.", foreground="green")
            self._refresh_product_list()
        else:
            self._cogs_status.config(
                text="Could not connect. Check the file path.", foreground="red")

    def _save_settings(self):
        for key, entry in self._sv.items():
            self.config[key] = entry.get()
        self.config["logo_path"] = self._logo_var.get()
        self.config["printer_name"] = self._e_printer.get()
        self.config["paper_width"] = self._paper_var.get()
        self.config["tax_rate"] = self._e_tax.get()
        self.config["cogs_db_path"] = self._cogs_db_var.get()
        self.config["save_to_db"] = self._save_to_db_var.get()
        self._save_config()
        # Apply DB path immediately
        import db as cogs_db
        cogs_db.set_path(self.config["cogs_db_path"])
        self._refresh_product_list()
        self._update_totals()
        messagebox.showinfo("Saved", "Settings saved.")

    # ── Print ────────────────────────────────────────────────────────────────

    def _collect_invoice(self):
        items = []
        for row in self.item_rows:
            desc = row["desc"].get().strip()
            if not desc:
                continue
            try:
                qty = float(row["qty"].get() or 0)
                price = float(row["price"].get() or 0)
            except ValueError:
                qty, price = 0.0, 0.0
            if qty:
                items.append({"desc": desc, "qty": qty, "price": price,
                              "subtotal": qty * price,
                              "product_id": row.get("product_id")})
        return items

    def _build_invoice_data(self):
        """Build and return the invoice dict, or None if validation fails."""
        items = self._collect_invoice()
        if not items:
            messagebox.showwarning("No Items",
                                   "Add at least one item before continuing.")
            return None

        try:
            tax_rate = float(self.config.get("tax_rate", "0")) / 100
        except ValueError:
            tax_rate = 0.0

        try:
            discount_pct = float(self.e_discount.get() or 0)
        except ValueError:
            discount_pct = 0.0

        subtotal = sum(i["subtotal"] for i in items)
        discount = subtotal * (discount_pct / 100)
        discounted = subtotal - discount
        tax = discounted * tax_rate

        return {
            "customer_name":    self.e_customer.get().strip(),
            "invoice_num":      self.e_inv_num.get().strip(),
            "date":             self.e_date.get().strip(),
            "note":             self.e_note.get().strip(),
            "items":            items,
            "subtotal":         subtotal,
            "discount_pct":     discount_pct,
            "discount":         discount,
            "tax_rate":         self.config.get("tax_rate", "0"),
            "tax":              tax,
            "total":            discounted + tax,
            "business_name":    self.config.get("business_name", ""),
            "business_address": self.config.get("business_address", ""),
            "business_phone":   self.config.get("business_phone", ""),
            "footer_text":      self.config.get("footer_text", ""),
            "logo_path":        self.config.get("logo_path", ""),
            "paper_width":      self.config.get("paper_width", "58"),
        }

    def _persist_invoice(self, inv: dict) -> None:
        """Save invoice to the shared COGS DB (best-effort, non-blocking)."""
        if not self.config.get("save_to_db", True):
            return
        import db as cogs_db
        if not cogs_db.is_connected():
            return
        try:
            cogs_db.save_invoice(inv)
        except Exception as e:
            print(f"[db] save_invoice failed: {e}")

    def _save_invoice_only(self):
        """Save invoice to COGS DB and consume production inventory."""
        inv = self._build_invoice_data()
        if inv is None:
            return
        if not self.config.get("save_to_db", True):
            messagebox.showwarning("Not Configured",
                                   "COGS DB integration is disabled in Settings.")
            return
        import db as cogs_db
        if not cogs_db.is_connected():
            messagebox.showwarning("Not Connected",
                                   "Set the COGS DB path in Settings → COGS Integration.")
            return
        try:
            cogs_db.save_invoice(inv)
            # Advance invoice counter
            try:
                next_num = int(self.e_inv_num.get()) + 1
            except ValueError:
                next_num = self.config.get("invoice_counter", 1) + 1
            self.config["invoice_counter"] = next_num
            self._save_config()
            self.e_inv_num.delete(0, "end")
            self.e_inv_num.insert(0, str(next_num))
            # Refresh comboboxes so depleted products disappear
            self._refresh_product_list()
            messagebox.showinfo("Saved", "Invoice saved and inventory updated.")
        except Exception as exc:
            messagebox.showerror("Save Error", f"Failed to save invoice:\n{exc}")

    def _print_invoice(self):
        inv = self._build_invoice_data()
        if inv is None:
            return

        printer_name = self.config.get("printer_name", "").strip()
        if not printer_name:
            messagebox.showwarning("No Printer",
                                   "Set the printer name in Settings first.")
            self.nb.select(1)
            return

        try:
            next_num = int(self.e_inv_num.get()) + 1
        except ValueError:
            next_num = self.config.get("invoice_counter", 1) + 1
        self.config["invoice_counter"] = next_num
        self._save_config()

        def do_print():
            try:
                from printer import print_invoice
                print_invoice(printer_name, inv)
                self.root.after(0, lambda: [
                    messagebox.showinfo("Done", "Invoice printed successfully!"),
                    self.e_inv_num.delete(0, "end"),
                    self.e_inv_num.insert(0, str(next_num)),
                ])
            except Exception as exc:
                self.root.after(0, lambda: messagebox.showerror(
                    "Print Error", f"Failed to print:\n{exc}"))

        threading.Thread(target=do_print, daemon=True).start()

    def _save_as_jpg(self):
        inv = self._build_invoice_data()
        if inv is None:
            return

        default_name = f"Invoice_{inv['invoice_num'] or 'draft'}.jpg"
        path = filedialog.asksaveasfilename(
            title="Save Invoice as JPG",
            initialfile=default_name,
            defaultextension=".jpg",
            filetypes=[("JPEG image", "*.jpg"), ("All files", "*.*")],
        )
        if not path:
            return

        def do_render():
            try:
                from invoice_image import render_invoice_image
                img = render_invoice_image(inv)
                img.save(path, "JPEG", quality=95)
                self.root.after(0, lambda: messagebox.showinfo(
                    "Saved", f"Invoice image saved to:\n{path}"))
            except Exception as exc:
                self.root.after(0, lambda: messagebox.showerror(
                    "Export Error", f"Failed to save image:\n{exc}"))

        threading.Thread(target=do_render, daemon=True).start()


if __name__ == "__main__":
    root = tk.Tk()
    try:
        root.iconbitmap(default="")  # suppress missing icon warning
    except Exception:
        pass
    InvoiceApp(root)
    root.mainloop()
