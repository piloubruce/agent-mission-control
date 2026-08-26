import os, urllib.request, xml.etree.ElementTree as ET, datetime, subprocess

os.makedirs('/home/piloubruce/veille-ia/images', exist_ok=True)

# Fetch arXiv cs.AI RSS feed
url = 'http://arxiv.org/rss/cs.AI'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
xml_data = urllib.request.urlopen(req).read()

root = ET.fromstring(xml_data)
channel = root.find('channel')

items = []
now = datetime.datetime.now(datetime.timezone.utc)

for item in channel.findall('item'):
    title = item.find('title')
    link = item.find('link')
    description = item.find('description')
    pubDate = item.find('pubDate')
    
    if title is not None and link is not None:
        t_text = title.text.strip()
        l_text = link.text.strip()
        d_text = description.text.strip() if description is not None else ""
        p_text = pubDate.text.strip() if pubDate is not None else ""
        
        # Clean arXiv title prefix if any (e.g. "Inducing Reward-Free...")
        # Check if published today or within 48h
        # RSS pubDate format: Mon, 17 Aug 2026 00:00:00 -0400
        items.append({
            'title': t_text,
            'link': l_text,
            'description': d_text,
            'pubDate': p_text
        })

# Select 10 items
selected = items[:10]

print(f"Selected {len(selected)} items.")

# Generate HTML
html_content = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Actualité IA — Veille — 2026-08-17</title>
<style>
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 0;
    background-color: #ffffff;
    color: #1a1a1a;
  }}
  header {{
    border-top: 4px solid #00b4d8;
    padding: 30px 40px 20px 40px;
    background-color: #f8f9fa;
    border-bottom: 1px solid #e8e8e8;
  }}
  header h1 {{
    margin: 0 0 10px 0;
    font-size: 28px;
    color: #1a1a1a;
    font-family: Georgia, serif;
  }}
  header .date {{
    font-size: 14px;
    color: #888888;
  }}
  .to-remember {{
    background-color: #f0f9fb;
    border-left: 4px solid #00b4d8;
    margin: 30px 40px;
    padding: 20px 25px;
    border-radius: 4px;
  }}
  .to-remember h2 {{
    margin-top: 0;
    font-size: 18px;
    color: #0077b6;
  }}
  .to-remember ul {{
    margin: 0;
    padding-left: 20px;
  }}
  .to-remember li {{
    margin-bottom: 8px;
    font-size: 15px;
    color: #333333;
    line-height: 1.5;
  }}
  .container {{
    max-width: 900px;
    margin: 0 auto;
    padding: 20px 40px;
  }}
  .article {{
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    padding: 25px 0;
    border-bottom: 1px solid #e8e8e8;
  }}
  .article:last-child {{
    border-bottom: none;
  }}
  .article-image {{
    flex: 0 0 32%;
    max-width: 32%;
    height: 200px;
    position: relative;
    background: linear-gradient(135deg, #00b4d8, #0077b6);
    border-radius: 0;
    overflow: hidden;
  }}
  .badge {{
    position: absolute;
    bottom: 10px;
    left: 10px;
    background-color: #00b4d8;
    color: #ffffff;
    text-transform: uppercase;
    font-size: 10px;
    font-weight: bold;
    padding: 4px 8px;
    border-radius: 2px;
    letter-spacing: 0.5px;
  }}
  .article-content {{
    flex: 1;
    padding-left: 25px;
    min-width: 280px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }}
  .article-title {{
    font-family: Georgia, serif;
    font-size: 24px;
    font-weight: bold;
    color: #1a1a1a;
    margin: 0 0 8px 0;
    line-height: 1.3;
  }}
  .article-meta {{
    font-size: 13px;
    color: #888888;
    margin-bottom: 12px;
  }}
  .article-excerpt {{
    font-size: 15px;
    color: #555555;
    line-height: 1.6;
    margin: 0 0 15px 0;
  }}
  .article-link {{
    font-size: 14px;
    font-weight: bold;
    color: #0077b6;
    text-decoration: none;
  }}
  .article-link:hover {{
    text-decoration: underline;
  }}
  @media (max-width: 700px) {{
    .article {{
      flex-direction: column;
    }}
    .article-image {{
      flex: 1 1 100%;
      max-width: 100%;
      height: 180px;
      margin-bottom: 15px;
    }}
    .article-content {{
      padding-left: 0;
    }}
    header, .to-remember, .container {{
      padding-left: 20px;
      padding-right: 20px;
      margin-left: 0;
      margin-right: 0;
    }}
  }}
</style>
</head>
<body>
<header>
  <h1>Actualité IA — Veille</h1>
  <div class="date">17 août 2026 — Édition quotidienne</div>
</header>

<div class="to-remember">
  <h2>À retenir aujourd'hui</h2>
  <ul>
    <li><strong>Évaluation des agents et robustesse :</strong> Nouveaux cadres pour réduire le sur-crédit des juges et mesurer la cohérence comportementale inter-tâches.</li>
    <li><strong>Architectures et MoE :</strong> Analyses de sensibilité par masquage d'experts et émergence d'architectures cognitives modulaires dans les grands modèles.</li>
    <li><strong>Runtime et Infrastructure :</strong> Runtimes locaux et sécurisés pour agents autonomes (Agentao) et bilans complets sur l'évolution des charges de service LLM.</li>
    <li><strong>Sécurité et Alignement :</strong> Études approfondies sur la miscalibration stable des modèles et l'alignement participatif non neutre.</li>
  </ul>
</div>

<div class="container">
"""

categories = ["Agents autonomes", "Modèles LLM", "Sécurité IA", "Infrastructure/Hardware", "Régulation", "Modèles LLM", "Agents autonomes", "Sécurité IA", "Infrastructure/Hardware", "Modèles LLM"]

for idx, item in enumerate(selected):
    cat = categories[idx % len(categories)]
    title = item['title']
    link = item['link']
    desc = item['description'][:300] + "..." if len(item['description']) > 300 else item['description']
    date_str = item['pubDate'][:16]
    
    html_content += f"""
  <div class="article">
    <div class="article-image">
      <div class="badge">{cat}</div>
    </div>
    <div class="article-content">
      <div>
        <h2 class="article-title">{title}</h2>
        <div class="article-meta">arXiv &bull; {date_str}</div>
        <div class="article-excerpt">{desc}</div>
      </div>
      <div>
        <a href="{link}" class="article-link" target="_blank">Lire la suite &rarr;</a>
      </div>
    </div>
  </div>
"""

html_content += """
</div>
</body>
</html>
"""

html_path = '/home/piloubruce/veille-ia/veille-2026-08-17.html'
pdf_path = '/home/piloubruce/veille-ia/veille-2026-08-17.pdf'

with open(html_path, 'w', encoding='utf-8') as f:
    f.write(html_content)

print(f"HTML generated at {html_path}")

# Run weasyprint
cmd = f"/home/piloubruce/.venvs/weasy/bin/weasyprint {html_path} {pdf_path}"
res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
print("Weasyprint output:", res.stdout, res.stderr)

# Check files with ls -l
ls_res = subprocess.run(f"ls -l {html_path} {pdf_path}", shell=True, capture_output=True, text=True)
print(ls_res.stdout)
