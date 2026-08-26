#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pdf_export.py — Génère un PDF consultable des résultats de scan Hermès MC.

Lit sur STDIN un objet JSON: {"provider": <str|None>, "rows": [ScanModelResult...]}
puis écrit au STDOUT un PDF binaire (fpdf2, venv ~/.venv_pdf).

Tableau: Provider | Modèle | Statut | Latence(ms) | Tokens/s | Vision |
          Reasoning | Tools | Raison (tronquée ~40) | Dernier test
- Longues raisons tronquées pour garder le tableau lisible.
- Emojis retirés (DejaVu n'en a pas) -> jamais de cases vides.
- Polices DejaVuSans / DejaVuSans-Bold (accents français OK).
"""

import datetime
import json
import re
import sys

from fpdf import FPDF

DEJAVU = "/usr/share/fonts/truetype/dejavu/"
FONT = DEJAVU + "DejaVuSans.ttf"
FONT_BOLD = DEJAVU + "DejaVuSans-Bold.ttf"

# Blocs Unicode emoji / picto / symboles variés que DejaVu ne couvre pas.
EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"   # pictographs, emoji
    "\U00002600-\U000027BF"   # divers symboles / dingbats
    "\U00002300-\U000023FF"   # symboles techniques
    "\U0000FE00-\U0000FE0F"   # variation selectors
    "\U0001E000-\U0001EFFF"   # extra symbols
    "]+")


def _clean(text):
    """Normalise une valeur à écrire dans le PDF (emoji retirés)."""
    if text is None:
        return ""
    s = str(text)
    s = EMOJI_RE.sub("", s)
    # Retire aussi les caractères de contrôle nuisibles à fpdf2.
    s = "".join(ch for ch in s if ord(ch) >= 32 or ch in "\t\n")
    return s


def _trunc(text, n=40):
    s = _clean(text).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _bool_str(v):
    if v is None:
        return "-"
    return "Oui" if v else "Non"


def _fmt_epoch(epoch):
    if not epoch:
        return "-"
    try:
        return datetime.datetime.fromtimestamp(float(epoch)).strftime("%Y-%m-%d %H:%M")
    except Exception:  # noqa: BLE001
        return str(epoch)


def build_pdf(provider, rows):
    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=12)
    pdf.add_font("DejaVu", "", FONT)
    pdf.add_font("DejaVu", "B", FONT_BOLD)
    pdf.add_page()

    # --- En-tête du document ---
    pdf.set_font("DejaVu", "B", 14)
    title = "Hermes Mission Control - Resultats du scan des modeles"
    if provider:
        title += " ({})".format(provider)
    pdf.cell(0, 8, _clean(title), new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("DejaVu", "", 9)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    pdf.cell(0, 5, "Genere le {}  -  {} modele(s)".format(now, len(rows)),
             new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    headers = [
        ("Provider", 28), ("Modele", 50), ("Statut", 20), ("Latence(ms)", 20),
        ("Tokens/s", 20), ("Vision", 16), ("Reasoning", 20), ("Tools", 16),
        ("Raison", 50), ("Dernier test", 32),
    ]
    widths = [w for _, w in headers]
    col_headers = [h for h, _ in headers]

    # --- En-tête du tableau (fond gris) ---
    pdf.set_font("DejaVu", "B", 7.2)
    header_h = 6
    pdf.set_fill_color(225, 225, 225)
    for i, h in enumerate(col_headers):
        pdf.cell(widths[i], header_h, _clean(h), border=1, align="C", fill=True)
    pdf.ln(header_h)

    # --- Lignes de données ---
    pdf.set_font("DejaVu", "", 7.2)
    row_h = 6
    pdf.set_font_size(7.2)
    for i in range(len(rows)):
        r = rows[i]
        status = "OK" if r.get("ok") else "HORS-SERVICE"
        lat = "" if r.get("latency_ms") is None else str(r.get("latency_ms"))
        tps = "" if r.get("tokens_per_sec") is None else str(r.get("tokens_per_sec"))
        cells = [
            _clean(r.get("provider")),
            _clean(r.get("model")),
            status,
            lat,
            tps,
            _bool_str(r.get("vision_supported")),
            _bool_str(r.get("reasoning_supported")),
            _bool_str(r.get("tools_supported")),
            _trunc(r.get("reason"), 40),
            _fmt_epoch(r.get("last_checked")),
        ]
        pdf.set_fill_color(245, 245, 245) if i % 2 == 0 else pdf.set_fill_color(255, 255, 255)
        for j, text in enumerate(cells):
            pdf.cell(widths[j], row_h, text, border=1, fill=True)
        pdf.ln(row_h)

    return pdf


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        rows = payload.get("rows") or []
        provider = payload.get("provider")
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("ERR parse stdin: {}\n".format(e))
        sys.exit(2)

    pdf = build_pdf(provider, rows)
    data = pdf.output()
    if isinstance(data, str):
        data = data.encode("latin-1")
    sys.stdout.buffer.write(data)


if __name__ == "__main__":
    main()