import os
import datetime
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from bs4 import BeautifulSoup
import requests

os.makedirs('/home/piloubruce/veille-ia/images', exist_ok=True)

today = datetime.date.today().strftime('%Y-%m-%d')
print(f"Today is {today}")

# Let's fetch from official feeds or reliable sources
feeds = [
    ("Modèles LLM", "https://openai.com/news/rss.xml"),
    ("Modèles LLM", "https://deepmind.google/blog/rss.xml"),
    ("Modèles LLM", "https://huggingface.co/blog/feed.xml"),
    ("Modèles LLM", "https://arxiv.org/rss/cs.AI")
]

articles = []

for category, url in feeds:
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            xml_data = response.read()
            root = ET.fromstring(xml_data)
            # Find items or entries
            for item in root.findall('.//item')[:10]:
                title = item.find('title').text if item.find('title') is not None else "No title"
                link = item.find('link').text if item.find('link') is not None else ""
                pubDate = item.find('pubDate').text if item.find('pubDate') is not None else ""
                description = item.find('description').text if item.find('description') is not None else ""
                if not link:
                    # check for atom link
                    pass
                articles.append({
                    'category': category,
                    'title': title.strip(),
                    'link': link.strip(),
                    'date': pubDate.strip(),
                    'summary': BeautifulSoup(description, 'html.parser').get_text()[:300].strip()
                })
    except Exception as e:
        print(f"Error fetching {url}: {e}")

print(f"Fetched {len(articles)} raw articles.")
