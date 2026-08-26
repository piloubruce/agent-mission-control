#!/usr/bin/env python3
# Recommandation des 10 meilleurs modeles par agent, score pondere par besoins.
import json
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether, HRFlowable)
from reportlab.lib.enums import TA_LEFT

DATA = json.load(open('/home/piloubruce/agent-mission-control/_models_specs.json'))

# Besoins par agent: poids (raisonnement, outils CLI, vision, codage, contexte long, generaliste/rapidite)
AGENTS = {
 'Réseau':      {'reasoning':0.30,'tools':0.30,'vision':0.05,'coding':0.20,'ctx':0.05,'general':0.10},
 'Développeur': {'reasoning':0.25,'tools':0.25,'vision':0.05,'coding':0.35,'ctx':0.05,'general':0.05},
 'Recherche':   {'reasoning':0.30,'tools':0.10,'vision':0.10,'coding':0.05,'ctx':0.30,'general':0.15},
 'Analyste':    {'reasoning':0.35,'tools':0.10,'vision':0.10,'coding':0.05,'ctx':0.25,'general':0.15},
 'Rédacteur':   {'reasoning':0.15,'tools':0.05,'vision':0.10,'coding':0.05,'ctx':0.25,'general':0.40},
 'Social':      {'reasoning':0.15,'tools':0.05,'vision':0.20,'coding':0.0,'ctx':0.10,'general':0.50},
 'Vision-Image':{'reasoning':0.20,'tools':0.10,'vision':0.45,'coding':0.05,'ctx':0.10,'general':0.10},
 'Vision-Media':{'reasoning':0.30,'tools':0.10,'vision':0.35,'coding':0.05,'ctx':0.10,'general':0.10},
 'Bob (géné.)': {'reasoning':0.25,'tools':0.15,'vision':0.15,'coding':0.15,'ctx':0.15,'general':0.15},
 'Manager':      {'reasoning':0.30,'tools':0.15,'vision':0.15,'coding':0.10,'ctx':0.15,'general':0.15},
 'Agentique':    {'reasoning':0.30,'tools':0.20,'vision':0.15,'coding':0.15,'ctx':0.20,'general':0.00},
}

def coding_bonus(name):
    n=name.lower()
    if any(k in n for k in ['codestral','devstral','code','coder','coding','laguna','nemotron-3-super']): return 1.0
    if any(k in n for k in ['mistral-medium','mistral-large','command-a','glm','qwen','minimax','hy3']): return 0.6
    return 0.3

def score(m, w):
    # Score = adequation capacites -> besoins agent.
    # PAS de tokens/s (variable jour apres jour) ni de latence.
    s=0.0
    s += (1 if m['reasoning']=='Oui' else 0)*w['reasoning']
    s += (1 if m['tools']=='Oui' else 0)*w['tools']
    s += (1 if m['vision']=='Oui' else 0)*w['vision']
    s += coding_bonus(m['models'][0])*w['coding']
    # contexte: seuil raisonnable, pas de gain lineaire jusqu'a 1M
    c = m['context'] or 128000
    ctx_score = 0.0
    if c >= 1_000_000: ctx_score = 1.0
    elif c >= 256000: ctx_score = 0.8
    elif c >= 128000: ctx_score = 0.6
    else: ctx_score = 0.4
    s += ctx_score*w['ctx']
    # general: penalise legerement les routeurs auto deja exclus; sinon plein
    s += 1.0*w['general']
    return round(s*100,1)

recos = {}
for agent, w in AGENTS.items():
    # Exclut les routeurs auto/* (pas une famille de labo) pour maximiser la diversite
    candidates = [m for m in DATA if not m['models'][0].lower().startswith('auto')]
    ranked = sorted(candidates, key=lambda m: score(m,w), reverse=True)
    # Diversite: max 3 modeles par famille (prend les meilleurs), jusqu'a 10
    seen_fam = {}
    diverse = []
    for m in ranked:
        fam = m['family']
        seen_fam[fam] = seen_fam.get(fam, 0) + 1
        if seen_fam[fam] > 3:
            continue
        diverse.append(m)
        if len(diverse) == 10:
            break
    # Si <10 (familles epuisees), completer avec les suivants toutes familles
    if len(diverse) < 10:
        for m in ranked:
            if m not in diverse:
                diverse.append(m)
                if len(diverse) == 10:
                    break
    recos[agent] = [(m['models'][0], score(m,w), m['vision'], m['reasoning'], m['tools'], m['context_str']) for m in diverse]

# ---------- PDF ----------
DARK=colors.HexColor('#1c1917'); ACCENT=colors.HexColor('#ea580c'); GREY=colors.HexColor('#78716c')
LIGHT=colors.HexColor('#f5f5f4'); BORDER=colors.HexColor('#d6d3d1')
LIGHT2=colors.HexColor('#e7e5e4')
styles=getSampleStyleSheet()
def S(n,**kw): return ParagraphStyle(n,parent=styles['Normal'],**kw)
h1=S('h1',fontSize=20,textColor=DARK,spaceAfter=2,leading=24,fontName='Helvetica-Bold')
sub=S('sub',fontSize=9.5,textColor=GREY,spaceAfter=8)
agent_st=S('a',fontSize=13,textColor=ACCENT,spaceBefore=12,spaceAfter=4,fontName='Helvetica-Bold')

flow=[Paragraph("Top 10 modèles par agent — Recommandations",h1),
      Paragraph("Classement par score pondéré selon les besoins de chaque agent (raisonnement, outils CLI, vision, codage, contexte, généralisme). Basé sur le scan Hermès MC du 25/08/2026 (118 modèles uniques).",sub),
      HRFlowable(width="100%",thickness=1.2,color=ACCENT,spaceAfter=6)]

hdr=[Paragraph('<b>#</b>',S('x')),Paragraph('<b>Modèle</b>',S('x')),Paragraph('<b>Score</b>',S('x')),
     Paragraph('<b>Vision</b>',S('x')),Paragraph('<b>Raisonnement</b>',S('x')),Paragraph('<b>Outils CLI</b>',S('x')),Paragraph('<b>Contexte</b>',S('x'))]

import re
def short_ctx(c):
    if '1 000 000' in c: return '1M'
    m = re.search(r'(\d+)\s*K', c)
    if m: return m.group(1)+'K'
    if 'variable' in c: return 'variable'
    return c

for agent in AGENTS:
    rows=[hdr]
    for i,(name,sc,vis,rea,too,ctx) in enumerate(recos[agent],1):
        rows.append([Paragraph(str(i),S('c')),
                     Paragraph(name,S('c2')),
                     Paragraph(f"<b>{sc}</b>",S('c')),
                     Paragraph(vis,S('c')),Paragraph(rea,S('c')),Paragraph(too,S('c')),
                     Paragraph(short_ctx(ctx),S('c'))])
    t=Table(rows,colWidths=[8*mm,48*mm,14*mm,16*mm,22*mm,18*mm,18*mm],repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),LIGHT2),
        ('FONTSIZE',(0,0),(-1,-1),8),('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),
        ('TEXTCOLOR',(0,0),(-1,0),DARK),
        ('GRID',(0,0),(-1,-1),0.4,BORDER),('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ('LINEBELOW',(0,0),(-1,0),1.2,ACCENT),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,LIGHT]),
        ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
        ('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4),
    ]))
    flow.append(Paragraph(agent,agent_st))
    flow.append(t)
    flow.append(Spacer(1,4))

def on_page(c,doc):
    c.saveState(); c.setStrokeColor(ACCENT); c.setLineWidth(0.8)
    c.line(18*mm,14*mm,192*mm,14*mm); c.setFont('Helvetica',7.5); c.setFillColor(GREY)
    c.drawString(18*mm,9*mm,"Hermès MC — Top 10 modèles par agent")
    c.drawRightString(192*mm,9*mm,f"Page {doc.page}"); c.restoreState()

doc=BaseDocTemplate('/home/piloubruce/agent-mission-control/reco_modeles_par_agent_2026-08-25.pdf',
                    pagesize=A4,leftMargin=18*mm,rightMargin=18*mm,topMargin=16*mm,bottomMargin=18*mm,
                    title="Top 10 modeles par agent")
frame=Frame(doc.leftMargin,doc.bottomMargin,doc.width,doc.height,id='m')
doc.addPageTemplates([PageTemplate(id='a',frames=[frame],onPage=on_page)])
doc.build(flow)
print("PDF reco généré")
