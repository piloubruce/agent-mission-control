import fs from 'fs';

function replaceInFile(filePath, replacements) {
  let content = fs.readFileSync(filePath, 'utf8');
  for (const [search, replace] of replacements) {
    content = content.split(search).join(replace); // global replacement
  }
  fs.writeFileSync(filePath, content);
}

// types.ts
replaceInFile('src/types.ts', [
  ["role: 'The routing specialist', description: 'Manages the fleet, delegates tasks, and ensures overall coherence.'", "role: 'Spécialiste du routage', description: 'Gère la flotte, délègue les tâches et assure la cohérence globale.'"],
  ["role: 'The writing specialist', description: 'Drafts reports, summaries, and writes elegant copy.'", "role: 'Rédaction et contenu', description: 'Rédige des rapports, des résumés et produit un contenu élégant.'"],
  ["role: 'The research specialist', description: 'Gathers intelligence, analyzes web data, and answers complex queries.'", "role: 'Recherche web & informations', description: 'Recherche web, intelligence des tendances et traitement d\\'informations complexes.'"],
  ["role: 'The distribution specialist', description: 'Handles networking, API calls, and external communications.'", "role: 'Réseau & infrastructure', description: 'Gère le réseau, l\\'infrastructure, les optimisations et les API externes.'"],
  ["role: 'The coding specialist', description: 'Writes, reviews, and deploys software components.'", "role: 'Ingénierie & développement', description: 'Ingénierie, développe, révise et déploie des composants logiciels.'"]
]);

// TopNav.tsx
replaceInFile('src/components/TopNav.tsx', [
  ["label: 'OVERVIEW'", "label: 'APERÇU'"],
  ["label: 'AGENTS'", "label: 'AGENTS'"],
  ["label: 'CHAT'", "label: 'CHAT'"],
  ["label: 'TASKS'", "label: 'TÂCHES'"],
  ["label: 'OFFICE'", "label: 'BUREAU'"],
  ["label: 'CONTENT'", "label: 'CONTENU'"],
  ["label: 'SCHEDULE'", "label: 'PLANIFICATION'"],
  ["label: 'DOCS'", "label: 'DOCS'"]
]);

// OverviewTab.tsx
replaceInFile('src/components/tabs/OverviewTab.tsx', [
  ["One manager.", "Un manager."],
  ["four specialists.", "quatre spécialistes."],
  ["Your autonomous AI workforce is online. Monitoring fleet health, task execution, and system throughput.", "Votre force de travail IA autonome est en ligne. Surveillance de la santé de la flotte, de l'exécution des tâches et des performances."],
  ["Agents that ship work.", "Des agents qui produisent."],
  ["Real-time synchronization of tasks, automated documentation, and code delivery.", "Synchronisation en temps réel des tâches, documentation automatisée et livraison de code."],
  ["Tasks Completed", "Tâches terminées"],
  ["Uptime", "Disponibilité"],
  ["Active Missions", "Missions actives"],
  ["CPU Load %", "Charge CPU %"],
  ["Tokens / Sec", "Jetons / Sec"],
  ["Recent Fleet Activity", "Activité récente de la flotte"],
  ["System initialized. Connecting to Hermes Agent server...", "Système initialisé. Connexion au serveur Hermès Agent..."],
  ["Manager online and awaiting commands.", "Manager en ligne et en attente de commandes."],
  ["Cron jobs synchronized with remote database.", "Tâches Cron synchronisées avec la base de données distante."],
  ["Recherche dispatched for web scraping task.", "Recherche déployé pour une tâche de scraping web."],
  ["Live feed connected.", "Flux en direct connecté."],
  ["View Full Logs", "Voir tous les journaux"]
]);

// AgentsTab.tsx
replaceInFile('src/components/tabs/AgentsTab.tsx', [
  ["The Fleet", "La Flotte"],
  ["Status and metrics for all active agents.", "Statut et métriques pour tous les agents actifs."],
  ["Spin up new agent", "Déployer un nouvel agent"],
  ["Tasks Completed", "Tâches terminées"],
  ["Throughput across the specialist fleet", "Débit à travers la flotte spécialisée"],
  ["Overall success rate", "Taux de réussite global"]
]);

// ChatTab.tsx
replaceInFile('src/components/tabs/ChatTab.tsx', [
  ["How are you doing today?", "Comment allez-vous aujourd'hui ?"],
  ["Doing well — focused and ready to help with routing, orchestrating, or overall system management. How can I assist?", "Tout va bien — concentré et prêt à aider avec le routage, l'orchestration ou la gestion globale du système. Comment puis-je vous assister ?"],
  ["Message received. Awaiting Hermes Agent backend connection to process this request.", "Message reçu. En attente de la connexion au backend Hermès Agent pour traiter cette demande."],
  ["Talk to the fleet.", "Discutez avec la flotte."],
  ["Direct line to", "Ligne directe vers"],
  ["Message ${", "Message pour ${"]
]);

// TasksTab.tsx
replaceInFile('src/components/tabs/TasksTab.tsx', [
  ["Reply to sponsor emails", "Répondre aux emails des sponsors"],
  ["Plan next week\\'s tutorial", "Planifier le tutoriel de la semaine prochaine"],
  ["Review dashboard updates", "Revoir les mises à jour du tableau de bord"],
  ["Edit video for Wednesday", "Monter la vidéo pour mercredi"],
  ["Publish the deep dive", "Publier l\\'analyse approfondie"],
  ["Send newsletter email", "Envoyer la newsletter"],
  ["Every mission, in motion.", "Chaque mission, en mouvement."],
  ["Drag and drop to assign tasks. Hermes agents will automatically pick up their designated workloads.", "Glissez et déposez pour assigner les tâches. Les agents Hermès s\\'en chargeront automatiquement."],
  ["label: 'To do'", "label: 'À faire'"],
  ["label: 'In progress'", "label: 'En cours'"],
  ["label: 'Done'", "label: 'Terminé'"],
  ["Add mission", "Ajouter une mission"]
]);

// OfficeTab.tsx
replaceInFile('src/components/tabs/OfficeTab.tsx', [
  ["A city built by agents.", "Une ville construite par des agents."],
  ["Live visualization of the Hermes server.", "Visualisation en direct du serveur Hermès."],
  ["When an agent is idle, its tower glows orange.", "Lorsqu\\'un agent est inactif, sa tour brille en orange."],
  ["When processing a task, it activates with a cyan glow.", "Lorsqu\\'il traite une tâche, elle s\\'active avec une lueur cyan."],
  ["Processing", "En cours"],
  ["Idle", "Inactif"],
  ["CONNECTION: LIVE", "CONNEXION : EN DIRECT"]
]);

// ContentTab.tsx
replaceInFile('src/components/tabs/ContentTab.tsx', [
  ["Why AI Tutorial Creators Should Ship Prompt Packs as Markdown Downloads", "Pourquoi proposer des packs de prompts en Markdown"],
  ["Q3 Monetization Strategy Analysis", "Analyse de la stratégie de monétisation T3"],
  ["System Architecture v2.0 Specifications", "Spécifications de l\\'architecture système v2.0"],
  ["Research", "Recherche"],
  ["Strategy", "Stratégie"],
  ["Technical", "Technique"],
  ["Library.", "Bibliothèque."],
  ["3 Docs", "3 Documents"],
  ["Search knowledge base...", "Rechercher dans la base de connaissances..."],
  ["Edit Document", "Éditer le document"],
  ["Key Takeaways", "Principaux points à retenir"],
  ["Markdown is lightweight, plain-text formatting which is easy for non-technical users to copy.", "Le format Markdown est léger et en texte brut, facilitant la copie pour tous."],
  ["It prevents platform lock-in (unlike Notion or Google Docs).", "Il empêche la dépendance à une plateforme (contrairement à Notion ou Google Docs)."],
  ["Users prefer immediate value. Shipping raw `.md` files means they can drag and drop into their own systems.", "Les utilisateurs préfèrent une valeur immédiate. Fournir des fichiers `.md` bruts permet de les glisser-déposer dans leurs propres systèmes."],
  ["The Problem with Current Formats", "Le problème des formats actuels"],
  ["Most creators share prompts via Notion templates or PDFs. This creates friction. PDFs suffer from formatting issues when copying text, and Notion templates require duplicating into a specific workspace.", "La plupart des créateurs partagent via des modèles Notion ou PDF, ce qui crée des frictions (problèmes de formatage lors de la copie, obligation de dupliquer les modèles...)."],
  ["[End of document preview]", "[Fin de l\\'aperçu du document]"],
  ["By ${doc.agent}", "Par ${doc.agent}"]
]);

// ScheduleTab.tsx
replaceInFile('src/components/tabs/ScheduleTab.tsx', [
  ["Morning briefing", "Briefing matinal"],
  ["Agent driven: SCHEDULED CRON. Pulls daily stats, pending tasks, and prepares brief.", "Piloté par l\\'agent : CRON PLANIFIÉ. Récupère les stats, les tâches en attente et prépare le résumé."],
  ["Weekly video ideas", "Idées de vidéos hebdomadaires"],
  ["Agent driven: SCHEDULED CRON. Recherche analyzes trending topics and Reseau proposes distribution.", "Piloté par l\\'agent : CRON PLANIFIÉ. Recherche analyse les tendances et Reseau propose la distribution."],
  ["Daily Bible Message", "Message biblique quotidien"],
  ["Manager sends a daily reflection and prayer to the communication channels.", "Manager envoie une réflexion quotidienne et une prière sur les canaux de communication."],
  ["Schedule.", "Planification."],
  ["Manage recurring automated tasks (Cron jobs) for the Hermes fleet.", "Gérez les tâches automatisées récurrentes (tâches Cron) pour la flotte Hermès."],
  ["New Job", "Nouvelle tâche"],
  ["Active Jobs", "Tâches actives"],
  ["Failed Runs (24h)", "Échecs (24h)"],
  ["Next run:", "Prochaine exécution :"],
  ["Run Now", "Exécuter"]
]);

// DocsTab.tsx
replaceInFile('src/components/tabs/DocsTab.tsx', [
  ["Know every corner.", "Connaître chaque recoin."],
  ["A plain-English guide to every tab, panel, and monitor for your Hermes Control Dashboard — what they do, where data comes from, and how the system ticks.", "Un guide simple pour chaque onglet, panneau et moniteur de votre tableau de bord Hermès — ce qu\\'ils font, d\\'où proviennent les données et comment le système fonctionne."],
  ["Your fleet at a glance", "Votre flotte en un coup d\\'œil"],
  ["Gateway & Status", "Passerelle & Statut"],
  ["The gateway operates via the main server, routing user requests and webhooks to the Manager agent.", "La passerelle fonctionne via le serveur principal, routant les requêtes utilisateurs et les webhooks vers l\\'agent Manager."],
  ["Active Missions", "Missions Actives"],
  ["Real-time count of tasks currently being processed by the fleet.", "Le nombre en temps réel de tâches actuellement en cours de traitement par la flotte."],
  ["Every specialist, measured", "Chaque spécialiste, mesuré"],
  ["The Agents tab breaks down performance per role: Manager, Redacteur, Recherche, Reseau, and Developpeur.", "L'onglet Agents détaille les performances par rôle : Manager, Redacteur, Recherche, Reseau et Developpeur."]
  ["Each card displays real-time execution status (Working vs Idle). When an agent is working, its indicator pulses cyan. Data is pulled directly from the Hermes core state engine.", "Chaque carte affiche l\\'état d\\'exécution en temps réel (En cours vs Inactif). Lorsqu\\'un agent travaille, son indicateur clignote en cyan. Les données sont tirées directement du moteur d\\'état principal d\\'Hermès."],
  ["Your city in the cloud", "Votre ville dans le cloud"],
  ["The Office tab provides a visual spatial representation of your agents. Think of it as a virtual headquarters. Towers light up cyan when an agent is processing a task and return to a warm orange glow when idle, giving you an immediate sense of system activity without reading logs.", "L\\'onglet Bureau fournit une représentation spatiale visuelle de vos agents. Considérez-le comme un quartier général virtuel. Les tours s\\'allument en cyan lorsqu\\'un agent traite une tâche et reviennent à une lueur orange chaleureuse lorsqu\\'il est inactif, vous donnant un aperçu immédiat de l\\'activité du système."]
]);
