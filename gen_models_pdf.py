#!/usr/bin/env python3
# Genere un PDF professionnel: fiches modeles IA groupees par famille.
import json
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether, HRFlowable)

DATA = json.load(open('/home/piloubruce/agent-mission-control/_models_specs.json'))

# Palette
DARK = colors.HexColor('#1c1917')      # stone-900
ACCENT = colors.HexColor('#ea580c')    # orange-600
ACCENT2 = colors.HexColor('#0f766e')   # teal-700
GREEN = colors.HexColor('#16a34a')
RED = colors.HexColor('#dc2626')
GREY = colors.HexColor('#78716c')
LIGHT = colors.HexColor('#f5f5f4')     # stone-100
LIGHT2 = colors.HexColor('#e7e5e4')    # stone-200
BORDER = colors.HexColor('#d6d3d1')

styles = getSampleStyleSheet()
def S(name, **kw):
    base = kw.pop('parent', styles['Normal'])
    return ParagraphStyle(name, parent=base, **kw)

title_st = S('t', parent=styles['Title'], fontSize=22, textColor=DARK, spaceAfter=2, leading=26)
sub_st = S('s', fontSize=10.5, textColor=GREY, spaceAfter=10)
fam_st = S('f', fontSize=14, textColor=ACCENT, spaceBefore=14, spaceAfter=6, leading=17, fontName='Helvetica-Bold')
model_st = S('m', fontSize=11.5, textColor=DARK, fontName='Helvetica-Bold', spaceAfter=2)
desc_st = S('d', fontSize=9.5, textColor=colors.HexColor('#44403c'), leading=13, spaceAfter=4)
label_st = S('l', fontSize=8, textColor=GREY, fontName='Helvetica-Bold', leading=10)
val_st = S('v', fontSize=9, textColor=DARK, leading=12)
usage_st = S('u', fontSize=9, textColor=colors.HexColor('#334155'), leading=12, spaceAfter=2)

def cap_cell(val):
    # val: 'Oui'/'Non'/'-'
    if val == 'Oui':
        return Paragraph(f'<font color="#16a34a"><b>OUI</b></font>', val_st)
    if val == 'Non':
        return Paragraph(f'<font color="#dc2626">NON</font>', val_st)
    return Paragraph(f'<font color="#a8a29e">—</font>', val_st)

def build_sheet():
    flow = []
    flow.append(Paragraph("Catalogue des Modèles IA — Scan Hermès Mission Control", title_st))
    flow.append(Paragraph("Synthèse des capacités (contexte, vision, raisonnement, outils) issue du scan du 25/08/2026 et de recherches sur les spécifications officielles des labs. 118 modèles uniques, regroupés par famille.", sub_st))
    flow.append(HRFlowable(width="100%", thickness=1.2, color=ACCENT, spaceAfter=8))

    # famille order
    fam_order = []
    for m in DATA:
        if m['family'] not in fam_order:
            fam_order.append(m['family'])

    for fam in fam_order:
        items = [m for m in DATA if m['family'] == fam]
        flow.append(Paragraph(fam, fam_st))
        for m in items:
            rep = m['models'][0]
            provs = ", ".join(m['providers'])
            # en-tete modele + providers
            head = Paragraph(rep, model_st)
            prov_txt = Paragraph(f'<font color="#78716c" size="8">Disponible via : {provs}</font>', desc_st)
            # tableau capacites 2x2
            caps = [
                [Paragraph("Contexte", label_st), Paragraph(m['context_str'], val_st),
                 Paragraph("Vision", label_st), cap_cell(m['vision'])],
                [Paragraph("Raisonnement", label_st), cap_cell(m['reasoning']),
                 Paragraph("Outils CLI", label_st), cap_cell(m['tools'])],
            ]
            ct = Table(caps, colWidths=[28*mm, 52*mm, 26*mm, 28*mm])
            ct.setStyle(TableStyle([
                ('BACKGROUND',(0,0),(0,-1), LIGHT),
                ('BACKGROUND',(2,0),(2,-1), LIGHT),
                ('GRID',(0,0),(-1,-1),0.5, BORDER),
                ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
                ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
                ('LEFTPADDING',(0,0),(-1,-1),5),('RIGHTPADDING',(0,0),(-1,-1),5),
            ]))
            usage = m.get('usage') or default_usage(m)
            block = [head, prov_txt, Spacer(1,2), ct,
                     Paragraph(f"<b>Usage recommandé :</b> {usage}", usage_st),
                     Spacer(1,4)]
            flow.append(KeepTogether(block))
        flow.append(Spacer(1,4))
    return flow

def default_usage(m):
    name = m['models'][0].lower()
    fam = m['family']
    if 'codestral' in name or 'devstral' in name or 'code' in name or 'coder' in name:
        return "Génération et complétion de code, agents de développement, refactor."
    if 'vision' in name or m['vision']=='Oui':
        return "Tâches multimodales (image+texte), analyse visuelle, OCR."
    if 'reasoning' in name or 'raison' in fam.lower():
        return "Raisonnement complexe, plans multi-étapes, analyse logique."
    if 'ministral' in name or 'small' in name or '3b' in name or '8b' in name:
        return "Tâches légères, edge/local, assistants rapides à faible latence."
    if 'large' in name or 'medium' in name:
        return "Usage généraliste, rédaction, analyse, agents."
    if 'gemini' in name or 'gemma' in name:
        return "Multimodalité, long contexte, recherche et synthèse."
    if 'cohere' in name or 'command' in name:
        return "RAG, outils d'entreprise, multilingue, citations."
    if name.startswith('auto'):
        return "Routeur Omni-Route : sélection automatique du meilleur modèle selon le besoin (chat/codage/vision/raisonnement)."
    if 'nemotron' in name:
        return "Raisonnement, tâches longues, agents."
    if 'qwen' in name:
        return "Généraliste, codage, multilingue."
    if 'glm' in name:
        return "Texte long (1M contexte), généraliste."
    if 'hy3' in name:
        return "Assistant généraliste, conversation."
    if 'laguna' in name:
        return "Agents de code, raisonnement, contexte très long (1M)."
    if 'sea-lion' in name:
        return "Multilingue Asie du Sud-Est, généraliste."
    if 'minimax' in name:
        return "Généraliste, contexte 1M."
    if 'aion' in name:
        return "Généraliste / RP (roleplay)."
    if 'solar' in name:
        return "Généraliste, résumé, RAG."
    if 'stepfun' in name:
        return "Généraliste, conversation rapide."
    if 'freellm' in name or name=='fusion':
        return "Agrégateur multi-modèles."
    return "Généraliste."

# Pied de page / en-tete page
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(ACCENT); canvas.setLineWidth(0.8)
    canvas.line(18*mm, 14*mm, 192*mm, 14*mm)
    canvas.setFont('Helvetica', 7.5); canvas.setFillColor(GREY)
    canvas.drawString(18*mm, 9*mm, "Hermès Mission Control — Catalogue modèles IA (scan 2026-08-25)")
    canvas.drawRightString(192*mm, 9*mm, f"Page {doc.page}")
    canvas.restoreState()

doc = BaseDocTemplate('/home/piloubruce/agent-mission-control/recherche_modeles_IA_2026-08-25.pdf',
                      pagesize=A4, leftMargin=18*mm, rightMargin=18*mm,
                      topMargin=16*mm, bottomMargin=18*mm,
                      title="Catalogue modèles IA - Scan Hermès MC",
                      author="Hermès Manager")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='main')
doc.addPageTemplates([PageTemplate(id='all', frames=[frame], onPage=on_page)])
doc.build(build_sheet())
print("PDF généré: recherche_modeles_IA_2026-08-25.pdf")
