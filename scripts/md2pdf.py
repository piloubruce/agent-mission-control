#!/usr/bin/env python3
"""Convertit un fichier Markdown en PDF consultable (fpdf2 + DejaVuSans).

Extensions ajoutées pour le briefing Pontevès :
  - Directive bloc image :  ![légende](/chemin/vers/image.jpg)  -> image embarquée + légende.
  - Annotation automatique des liens vers des PAGES WEB :
        tout URL pointant vers un hôte de page web reçoit
        « (page web - clic requis) » juste après le lien.
"""
import re
import os
import sys
from fpdf import FPDF

SRC = "/home/piloubruce/briefing_ponteves_2026.md"
DST = "/home/piloubruce/hermes-docs/briefing_ponteves_2026.pdf"
FONT_DIR = "/usr/share/fonts/truetype/dejavu"

URL_RE = re.compile(r"https?://[^\s)>\]]+")
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
IMG_RE = re.compile(r"^!\[(?P<cap>.*?)\]\((?P<path>.*?)\)$")

# Hôtes servant des PAGES web (non intégrables directement) -> annotation honnête
_WEB_HOSTS = (
    "x.com", "twitter.com", "facebook.com", "nicematin.com", "feuxdeforet.fr",
    "ladepeche.fr", "bfmtv.com", "tf1info.fr", "meteofrance.fr",
    "instagram.com", "youtube.com", "t.co",
)


def is_web_page(url):
    return any(h in url for h in _WEB_HOSTS)


# Plages unicode des emoji / symboles pictographiques non gérés par DejaVuSans
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\U0000FE00-\U0000FE0F\U00002190-\U000021FF]",
    flags=re.UNICODE,
)


def clean_emoji(text):
    """Retire les emoji/symboles pictographiques que DejaVuSans ne possède pas."""
    return _EMOJI_RE.sub("", text).strip()


class MarkdownPDF(FPDF):
    def __init__(self):
        super().__init__(orientation="P", unit="mm", format="A4")
        self.set_auto_page_break(auto=True, margin=18)
        self.set_margins(18, 18, 18)
        self.add_font("DejaVu", "", f"{FONT_DIR}/DejaVuSans.ttf")
        self.add_font("DejaVu", "B", f"{FONT_DIR}/DejaVuSans-Bold.ttf")
        self.blue = (0, 90, 200)

    def header(self):
        pass

    def footer(self):
        self.set_y(-12)
        self.set_font("DejaVu", "", 8)
        self.set_text_color(140)
        self.cell(0, 8, f"Page {self.page_no()}", align="C")
        self.set_text_color(0)

    # --- rendu de texte enrichi (gras + liens cliquables) ---
    def write_rich(self, text, size=11, base_style=""):
        self.set_font("DejaVu", base_style, size)
        # découpe en tokens : gras, url, texte simple
        parts = []
        pos = 0
        pattern = re.compile(r"(\*\*.+?\*\*)|(https?://[^\s)>\]]+)")
        for m in pattern.finditer(text):
            if m.start() > pos:
                parts.append(("t", text[pos:m.start()]))
            if m.group(1):
                parts.append(("b", m.group(1)[2:-2]))
            else:
                parts.append(("u", m.group(2)))
            pos = m.end()
        if pos < len(text):
            parts.append(("t", text[pos:]))

        for kind, val in parts:
            if kind == "t":
                self.set_text_color(0)
                self.set_font("DejaVu", base_style, size)
                self.write(size * 0.55, val)
            elif kind == "b":
                self.set_text_color(0)
                self.set_font("DejaVu", "B" + base_style, size)
                self.write(size * 0.55, val)
            elif kind == "u":
                self.set_text_color(*self.blue)
                self.set_font("DejaVu", "U", size)
                self.write(size * 0.55, val, link=val)
                if is_web_page(val):
                    self.set_text_color(120)
                    self.set_font("DejaVu", "", size * 0.82)
                    self.write(size * 0.55, " (page web - clic requis)")
                    self.set_text_color(0)
        # saut de ligne après le paragraphe
        self.set_text_color(0)
        self.set_font("DejaVu", base_style, size)

    def para(self, text, size=11, style=""):
        self.write_rich(text, size=size, base_style=style)
        self.ln(size * 0.5)

    def h1(self, text):
        text = clean_emoji(text)
        self.ln(2)
        self.set_font("DejaVu", "B", 17)
        self.set_text_color(20, 40, 80)
        self.multi_cell(0, 9, text)
        self.set_text_color(0)
        self.ln(3)

    def h2(self, text):
        text = clean_emoji(text)
        self.ln(3)
        self.set_font("DejaVu", "B", 13)
        self.set_text_color(30, 60, 110)
        self.multi_cell(0, 7, text)
        self.set_text_color(0)
        self.ln(1.5)

    def h3(self, text):
        text = clean_emoji(text)
        self.ln(2)
        self.set_font("DejaVu", "B", 11.5)
        self.multi_cell(0, 6, text)
        self.ln(1)

    def bullet(self, text, ordered=None):
        text = clean_emoji(text)
        self.set_font("DejaVu", "", 11)
        x0 = self.get_x()
        marker = f"{ordered}. " if ordered else "• "
        self.set_x(x0 + 4)
        self.set_font("DejaVu", "B", 11)
        self.cell(6, 5.5, marker)
        self.set_font("DejaVu", "", 11)
        # écrit le texte enrichi avec indentation
        self.set_x(self.get_x())
        self.write_rich(text, size=11)
        self.ln(5.5)

    def blockquote(self, text):
        text = clean_emoji(text)
        self.ln(1)
        x0 = self.l_margin
        self.set_left_margin(x0 + 6)
        self.set_font("DejaVu", "", 10.5)
        self.set_text_color(90)
        # bordure verticale
        old_x = self.get_x()
        self.set_draw_color(180)
        self.set_line_width(0.4)
        y1 = self.get_y()
        self.write_rich(text, size=10.5)
        y2 = self.get_y()
        self.line(x0 + 2, y1, x0 + 2, y2)
        self.set_text_color(0)
        self.set_left_margin(x0)
        self.set_x(x0)
        self.ln(2)

    def image_block(self, path, caption):
        """Insère une image embarquée (centrée, largeur max 150 mm) + légende."""
        if not os.path.exists(path):
            return
        avail = self.w - self.l_margin - self.r_margin
        w = min(150, avail)
        # saut de page préventif si peu de place sous le curseur
        if self.get_y() > self.h - self.b_margin - 95:
            self.add_page()
        x = (self.w - w) / 2
        self.image(path, x=x, w=w)
        self.ln(1)
        self.set_font("DejaVu", "", 9)
        self.set_text_color(90)
        self.set_x(self.l_margin)
        self.multi_cell(0, 4.5, caption, align="C")
        self.set_text_color(0)
        self.ln(3)

    def render_table(self, rows):
        # rows : liste de listes de cellules (1re = header)
        from fpdf.fonts import FontFace
        self.ln(1)
        heading_style = FontFace(emphasis="BOLD", color=(255, 255, 255), fill_color=(30, 60, 110))
        with self.table(
            width=174,
            col_widths=(34, 140),
            text_align=("LEFT", "LEFT"),
            line_height=5,
            first_row_as_headings=True,
            headings_style=heading_style,
        ) as table:
            for r_idx, row in enumerate(rows):
                trow = table.row()
                for c in row:
                    trow.cell(c)
        self.ln(2)


def strip_md_inline(text):
    return text


def parse_and_render(pdf, lines):
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        line = raw.rstrip("\n")
        stripped = line.strip()

        # ligne vide
        if stripped == "":
            i += 1
            pdf.ln(1)
            continue

        # image embarquée (bloc) : ![legende](chemin)
        m_img = IMG_RE.match(stripped)
        if m_img:
            pdf.image_block(m_img.group("path").strip(), m_img.group("cap").strip())
            i += 1
            continue

        # titre
        if stripped.startswith("### "):
            pdf.h3(stripped[4:].strip())
            i += 1
            continue
        if stripped.startswith("## "):
            pdf.h2(stripped[3:].strip())
            i += 1
            continue
        if stripped.startswith("# "):
            pdf.h1(stripped[2:].strip())
            i += 1
            continue

        # séparateur
        if set(stripped) <= {"-", "*", "="} and len(stripped) >= 3:
            pdf.ln(1)
            pdf.set_draw_color(200)
            y = pdf.get_y()
            pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
            pdf.ln(3)
            i += 1
            continue

        # tableau (lignes contenant | )
        if "|" in stripped and stripped.startswith("|"):
            table_rows = []
            j = i
            while j < n and lines[j].strip().startswith("|"):
                cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
                # ignorer la ligne de séparation |---|---|
                if all(set(c) <= {"-", ":"} for c in cells if c):
                    j += 1
                    continue
                table_rows.append(cells)
                j += 1
            # nettoyer le gras dans les cellules pour la table
            cleaned = []
            for row in table_rows:
                cleaned.append([BOLD_RE.sub(r"\1", c) for c in row])
            if cleaned:
                pdf.render_table(cleaned)
            i = j
            continue

        # blockquote
        if stripped.startswith(">"):
            # agréger les lignes de blockquote consécutives
            quote = []
            j = i
            while j < n and lines[j].strip().startswith(">"):
                quote.append(lines[j].strip().lstrip(">").strip())
                j += 1
            pdf.blockquote(" ".join(quote))
            i = j
            continue

        # liste à puces / numérotée
        bullet_m = re.match(r"^[-*]\s+(.*)$", stripped)
        ordered_m = re.match(r"^(\d+)[.)]\s+(.*)$", stripped)
        if bullet_m or ordered_m:
            j = i
            counter = 0
            while j < n:
                bl = lines[j].strip()
                bm = re.match(r"^[-*]\s+(.*)$", bl)
                om = re.match(r"^(\d+)[.)]\s+(.*)$", bl)
                if bm:
                    pdf.bullet(bm.group(1))
                    j += 1
                elif om:
                    counter += 1
                    pdf.bullet(om.group(2), ordered=counter)
                    j += 1
                else:
                    break
            i = j
            continue

        # paragraphe simple (peut contenir du gras et des URLs inline)
        pdf.para(clean_emoji(stripped))
        i += 1


def main():
    with open(SRC, encoding="utf-8") as f:
        lines = f.read().splitlines()
    pdf = MarkdownPDF()
    pdf.add_page()
    parse_and_render(pdf, lines)
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    pdf.output(DST)
    print(f"PDF généré : {DST}")


if __name__ == "__main__":
    main()
