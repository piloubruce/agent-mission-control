#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Genere la FICHE TECHNIQUE FARINES (IT + FR + equivalences) en PDF.
Source unique : Wikipedia IT (D.P.R. 187/2001), Wikipedia FR, Wikipedia EN.
Modeles/productions : RECHERCHE (A-01/RE)."""
import datetime
from fpdf import FPDF

DEJAVU = "/usr/share/fonts/truetype/dejavu/"
FONT = DEJAVU + "DejaVuSans.ttf"
FONT_BOLD = DEJAVU + "DejaVuSans-Bold.ttf"

NAVY = (30, 60, 110)
LGREY = (240, 240, 245)
MGREY = (220, 222, 228)


def clean(s):
    return str(s).replace("'", "'").replace('"', '"')


class Doc(FPDF):
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("DejaVu", "", 7.5)
        self.set_text_color(120, 120, 120)
        self.cell(0, 5, clean("Fiche technique - Farines italiennes & francaises (equivalences)"), align="L")
        self.cell(0, 5, clean("RECHERCHE A-01/RE"), align="R", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*MGREY)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(2)

    def footer(self):
        self.set_y(-12)
        self.set_font("DejaVu", "", 7.5)
        self.set_text_color(120, 120, 120)
        self.cell(0, 8, clean("Page %d" % self.page_no()), align="C")


def h1(pdf, txt):
    pdf.set_font("DejaVu", "B", 14)
    pdf.set_text_color(*NAVY)
    pdf.ln(2)
    pdf.cell(0, 8, clean(txt), new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*NAVY)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
    pdf.ln(2)


def h2(pdf, txt):
    pdf.set_font("DejaVu", "B", 11)
    pdf.set_text_color(40, 40, 40)
    pdf.ln(1)
    pdf.cell(0, 6, clean(txt), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(0.5)


def para(pdf, txt, size=9.5):
    pdf.set_font("DejaVu", "", size)
    pdf.set_text_color(20, 20, 20)
    pdf.multi_cell(0, 5, clean(txt), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)


def table(pdf, headers, rows, widths, font_size=8.5, header_fill=NAVY):
    # header
    pdf.set_font("DejaVu", "B", font_size)
    pdf.set_fill_color(*header_fill)
    pdf.set_text_color(255, 255, 255)
    line_h = 6
    for h, w in zip(headers, widths):
        pdf.cell(w, line_h, clean(h), border=1, align="C", fill=True)
    pdf.ln(line_h)
    # rows
    pdf.set_font("DejaVu", "", font_size)
    pdf.set_text_color(20, 20, 20)
    for i, r in enumerate(rows):
        fill = LGREY if i % 2 == 0 else (255, 255, 255)
        # compute height needed (multi_cell for text cells)
        pdf.set_fill_color(*fill)
        # simple row: all cells single-line height
        for c, w in zip(r, widths):
            pdf.cell(w, line_h, clean(c), border=1, align="C", fill=True)
        pdf.ln(line_h)


def build():
    pdf = Doc(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=14)
    pdf.add_font("DejaVu", "", FONT)
    pdf.add_font("DejaVu", "B", FONT_BOLD)
    pdf.set_left_margin(15)
    pdf.set_right_margin(15)
    pdf.add_page()

    # ---- COVER / TITRE ----
    pdf.ln(4)
    pdf.set_font("DejaVu", "B", 19)
    pdf.set_text_color(*NAVY)
    pdf.multi_cell(0, 9, clean("FICHE TECHNIQUE - FARINES"), align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("DejaVu", "B", 12)
    pdf.set_text_color(60, 60, 60)
    pdf.multi_cell(0, 7, clean("Types italiens (00/0/1/2) vs Types francais (T45..T150)\nEquivalences & substitutions pour la cuisine"),
                   align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.set_font("DejaVu", "", 9)
    pdf.set_text_color(90, 90, 90)
    now = datetime.datetime.now().strftime("%Y-%m-%d")
    pdf.multi_cell(0, 5, clean("Document etabli par RECHERCHE (A-01/RE) - %s\nSources : Wikipedia IT (D.P.R. 9 fevrier 2001 n.187), Wikipedia FR, Wikipedia EN" % now),
                   align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    pdf.set_draw_color(*MGREY)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
    pdf.ln(3)

    # ---- CHAP 1 : rappel des deux systemes ----
    h1(pdf, "1. Les deux systemes de classement")
    para(pdf,
         "Italie et France classent les farines selon des criteres differents :\n"
         " - ITALIE : le 'tipo' (00, 0, 1, 2) est un grade MULTI-CRITERES fixe par loi (Leggi 580/1967 puis D.P.R. 187/2001). "
         "Il combine taux de cendres MAX, taux de proteines MINI, cellulose et finesse de mouture. Le '00' = le plus raffine.\n"
         " - FRANCE : le 'T' (T45, T55...) code UNIQUEMENT le taux de cendres (teneur en mineraux residuels apres calcination), "
         "exprime en dixiemes de gramme de cendres pour 100 g de farine. Il n'indique ni la force ni les proteines.\n"
         "Consequence : un meme numero ne veut pas dire la meme chose. Le 00 italien correspond en realite a la T45 francaise, "
         "tandis que le '0' italien correspond a la T55.")

    # ---- CHAP 2 : tableau farines italiennes (DPR 187/2001) ----
    h1(pdf, "2. Farines italiennes - caracteristiques (D.P.R. 187/2001)")
    h2(pdf, "Cendres et proteines calcules sur produit sec. Humidite max 15,50% si mentionnee.")
    headers = ["Tipo IT", "Cendres max", "Proteines min", "US/UK", "Allemand", "FR (T)"]
    widths = [34, 30, 30, 28, 26, 22]
    rows = [
        ["Tipo 00", "0,55 %", "9,00 %", "pastry flour", "405", "45"],
        ["Tipo 0", "0,65 %", "11,00 %", "all-purpose", "550", "55"],
        ["Tipo 1", "0,80 %", "12,00 %", "high gluten", "812", "80"],
        ["Tipo 2", "0,95 %", "12,00 %", "first clear", "1050", "110"],
        ["Integrale", "1,30-1,70 %", "12,00 %", "white whole", "1600", "150"],
    ]
    table(pdf, headers, rows, widths)
    pdf.ln(1)
    para(pdf,
         "Valeur W (force/panifiabilite, non encodee par le tipo) :\n"
         " - 00 generique : ~W150 (faible). 00 special pizza : W200-280. 00 dolci lievitates : ~W300.\n"
         " - Manitoba : ble nord-americain tres proteique, sert a renforcer les farines faibles (W eleve).\n"
         "Usages types : 00 = pizza / pates fraiches / patisserie fine / biscuits ; 0 = pain courant & pizza ; "
         "1 et 2 = pains rustiques, plus de son.")

    # ---- CHAP 3 : tableau farines francaises ----
    h1(pdf, "3. Farines francaises - classement par cendres (T)")
    headers = ["Type T", "Cendres (mineraux)", "Designation / usage"]
    widths = [28, 42, 90]
    rows = [
        ["T45", "< 0,50 %", "Fleur de farine - patisserie fine, cremes"],
        ["T55", "0,50 - 0,60 %", "Farine blanche - pain courant, viennoiserie"],
        ["T65", "0,62 - 0,75 %", "Tradition francaise - pains, cereales"],
        ["T70", "0,75 - 0,80 %", "Tradition quebecoise"],
        ["T80", "0,75 - 0,90 %", "Farine bise / semi-complete - pain de caractere, levain"],
        ["T110", "1,00 - 1,20 %", "Farine complete"],
        ["T150", "> 1,50 %", "Farine integale"],
    ]
    table(pdf, headers, rows, widths)
    pdf.ln(1)
    para(pdf,
         "Note reglementaire : le 'pain de tradition francaise' (decret 13 sept 1993) INTERDIT les additifs "
         "mais n'impose AUCUN type de farine. La T65 est la reference visuelle de la baguette blonde, mais la "
         "T80 (au levain / pain de campagne) est tout a fait valide et savoureuse.")

    # ---- CHAP 4 : tableau d'equivalence / substitution ----
    pdf.add_page()
    h1(pdf, "4. Tableau d'equivalence & substitution (IT <-> FR)")
    h2(pdf, "Lecture : colonne 'Substitut FR' = farine francaise la plus proche du tipo italien.")
    headers = ["Tipo IT", "Substitut FR", "Pour pizza", "Pour pain", "Pour patisserie"]
    widths = [26, 24, 34, 34, 36]
    rows = [
        ["Tipo 00", "T45 (fleur)", "T45 gruau W>250", "T55 (depannage)", "T45 direct"],
        ["Tipo 0", "T55", "T55 (fine)", "T55 / T65", "T45 (plus fine)"],
        ["Tipo 1", "T80", "T80 (rustique)", "T80 / T110", "-"],
        ["Tipo 2", "T110", "T110", "T110 / seigle", "-"],
        ["Integrale", "T150", "-", "T150 / mele", "-"],
    ]
    table(pdf, headers, rows, widths)
    pdf.ln(2)

    h2(pdf, "Substitution inverse (FR -> IT)")
    headers = ["Type FR", "Equivalent IT", "Notes"]
    widths = [26, 30, 94]
    rows = [
        ["T45", "Tipo 00 (patisserie)", "Echange direct pour desserts non leves"],
        ["T55", "Tipo 0", "Usage quotidien equivalent"],
        ["T65", "Tipo 0 / Tipo 1", "Pain classique francais"],
        ["T80", "Tipo 1 / Tipo 2", "Version italienne plus rustique"],
        ["T110/T150", "Tipo 2 / W350+", "Fibres & absorption variables"],
    ]
    table(pdf, headers, rows, widths)
    pdf.ln(2)

    h2(pdf, "Conseils pratiques de substitution")
    para(pdf,
         "1. Ajustez les liquides : le tipo 00 absorbant souvent MOINS que les T65-T80, partez avec ~10% d'eau en moins "
         "et ajustez a la consistance.\n"
         "2. Temps de repos : les farines 'forti' (W 280-350) demandent un repos plus long pour le developpement du gluten.\n"
         "3. Melanges : 75% IT + 25% FR (ou inverse) equilibre souvent force et finesse.\n"
         "4. W vs T ne sont PAS equivalents : un 00 peut etre W150 ou W300 selon l'usage ; une T65 reste 'blanche' mais "
         "sa force varie selon le ble.\n"
         "5. Cas concret utilisateur : remplacer la Tipo 00 'special pizza' -> T45 fleur de farine (idealement T45 gruau W>250). "
         "La T80 ne remplace PAS la 00 pour une pizza fine napolitaine (trop complete, trop fondee).")

    # ---- CHAP 5 : sources ----
    h1(pdf, "5. Sources & references")
    para(pdf,
         "1. it.wikipedia.org/wiki/Farina - section 'Farina di grano tenero', tableau D.P.R. 9 febbraio 2001 n.187 "
         "(cendres/proteines, equivalences US/DE/FR).\n"
         "2. fr.wikipedia.org/wiki/Farine - 'Classification francaise des farines' (T45..T150, cendres, usages).\n"
         "3. fr.wikipedia.org/wiki/Pizza - mention 'farine type 00 = T45 en France'.\n"
         "4. fr.wikipedia.org/wiki/Fabrication_du_pain - cadre 'pain de tradition francaise' (decret 1993, interdiction additifs).\n"
         "5. en.wikipedia.org/wiki/Wheat_flour - 'Flour type numbers' (definition cendres ISO 2171 / ICC 104/1, table conversion).\n"
         "6. en.wikipedia.org/wiki/Flour - sections 'Plain/all-purpose', 'Bread flour' (redirections Type 00 / Bread flour).",
         size=9)

    out = "/home/piloubruce/hermes-docs/fiche_technique_farines.pdf"
    pdf.output(out)
    print("PDF genere:", out)
    import os
    print("Taille:", os.path.getsize(out), "octets")


if __name__ == "__main__":
    build()
