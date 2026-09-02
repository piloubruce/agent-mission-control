import urllib.request
import urllib.error
import re
import os
import time

articles = [
    {"id": 1, "url": "https://www.lesnumeriques.com/intelligence-artificielle/l-ia-sera-incontrolable-donc-il-faut-que-ce-soit-moi-qui-la-construise-l-etrange-discours-d-elon-musk-a-ses-1000-nouveaux-employes-n260913.html", "title": "L'IA sera incontrôlable..."},
    {"id": 2, "url": "https://www.frandroid.com/marques/microsoft/3223887_openai-pense-toucher-au-but-celui-datteindre-lagi-mais-avec-sa-definition-maison", "title": "OpenAI AGI définition maison"},
    {"id": 3, "url": "https://www.lemondeinformatique.fr/actualites/lire-stability-ai-leve-76-m$-de-financement-soutenu-par-les-geants-de-la-musique-100756.html", "title": "Stability AI lève 76 M$"},
    {"id": 4, "url": "https://www.sudouest.fr/sciences-et-technologie/intelligence-artificielle-comment-700-agents-ia-d-openai-se-sont-coordonnes-tout-seuls-cyberattaquer-hugging-face-30381420.php", "title": "700 agents IA OpenAI attaquent Hugging Face"},
    {"id": 5, "url": "https://www.zdnet.fr/actualites/zdnet-morning-27-08-2026-quand-688-agents-ia-contournent-leur-bac-a-sable-la-nasa-et-lenergie-noire-protection-des-mineurs-meta-conclut-un-accord-historique-500692.htm", "title": "ZDNet Morning 27/08"},
    {"id": 6, "url": "https://www.leparisien.fr/high-tech/meta-va-payer-plus-de-16-milliards-de-dollars-a-plusieurs-etats-americains-pour-mettre-fin-a-son-proces-26-08-2026-EM6ZBURR75C5NGX3RXW7VKUTOY.php", "title": "Meta va payer 16 milliards"},
    {"id": 7, "url": "https://www.lesnumeriques.com/astronomie-conquete-spatiale/telescope-nancy-grace-roman-le-lancement-de-la-nasa-a-suivre-en-direct-ce-30-aout-n260824.html", "title": "Lancement télescope Nancy Grace Roman"},
    {"id": 8, "url": "https://www.francecryptos.fr/articles/deepseek-multiplie-ses-revenus-par-10-en-7-mois-et-vise-une-levee-de-fonds-a-70--265862", "title": "DeepSeek revenus x10"},
    {"id": 9, "url": "https://www.lesnumeriques.com/intelligence-artificielle/coup-de-tonnerre-nvidia-pose-12-9-milliards-sur-la-table-et-s-empare-de-hugging-face-le-sanctuaire-de-l-ia-open-source-n260997.html", "title": "Nvidia rachète Hugging Face"},
    {"id": 10, "url": "https://www.radiofrance.fr/franceinter/podcasts/made-in-franche-raphaelle-baillot/made-in-franche-raphaelle-baillot-du-jeudi-27-aout-2026-9762118", "title": "Lunettes connectées et IA"},
]

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

results = []
for art in articles:
    try:
        req = urllib.request.Request(art["url"], headers=headers)
        with urllib.request.urlopen(req, timeout=20) as response:
            html = response.read().decode('utf-8', errors='ignore')
        
        # Find og:image
        og_image = None
        match = re.search(r'<meta[^>]*property=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']', html, re.IGNORECASE)
        if match:
            og_image = match.group(1)
        
        if og_image:
            # Download image
            img_path = os.path.expanduser(f"~/veille-ia/images/art{art['id']:02d}.jpg")
            try:
                req_img = urllib.request.Request(og_image, headers=headers)
                with urllib.request.urlopen(req_img, timeout=20) as img_response:
                    img_data = img_response.read()
                    # Verify it's actually an image
                    if img_data[:3] == b'\xff\xd8\xff' or img_data[:4] == b'\x89PNG' or img_data[:4] == b'GIF':
                        with open(img_path, 'wb') as f:
                            f.write(img_data)
                        results.append({"id": art["id"], "url": art["url"], "og_image": og_image, "status": "ok", "size": len(img_data)})
                        print(f"art{art['id']:02d}: OK ({len(img_data)} bytes) - {og_image[:60]}")
                    else:
                        results.append({"id": art["id"], "url": art["url"], "og_image": og_image, "status": "not_image", "size": 0})
                        print(f"art{art['id']:02d}: NOT IMAGE ({img_data[:10]})")
            except Exception as e:
                results.append({"id": art["id"], "url": art["url"], "og_image": og_image, "status": f"download_error: {e}", "size": 0})
                print(f"art{art['id']:02d}: DOWNLOAD ERROR - {e}")
        else:
            results.append({"id": art["id"], "url": art["url"], "og_image": None, "status": "no_og_image", "size": 0})
            print(f"art{art['id']:02d}: NO OG IMAGE")
    except Exception as e:
        results.append({"id": art["id"], "url": art["url"], "og_image": None, "status": f"page_error: {e}", "size": 0})
        print(f"art{art['id']:02d}: PAGE ERROR - {e}")
    time.sleep(1)

print("\n--- SUMMARY ---")
for r in results:
    print(f"art{r['id']:02d}: {r['status']}")
