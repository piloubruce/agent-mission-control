# MISSION 1 : Analyse et documentation des procédures du tableau de bord "Hermès Agent"

## 1. Initialisation et Déploiement du Template
1.  **Création du point d'upload :** Mise en place d'une interface web permettant de téléverser un fichier HTML (le template du tableau de bord).
2.  **Téléversement du template :** L'utilisateur téléverse le fichier `Hermes-dashboard-template.html`.
3.  **Définition de la source de vérité :** Le système copie le fichier téléversé et le renomme en `index.html`. Ce fichier devient le modèle principal (source de vérité) servi par le serveur (ex: sur le port 51763).
4.  **Vérification des onglets :** Le système vérifie la présence des sections requises : Aperçu (Overview), Agents, Tâches (Tasks), Bureau (Office), Contenu (Content), Calendrier (Schedule) et Documents (Docs).

## 2. Protocole de Sauvegarde et de Versioning (Sécurité)
1.  **Création du dossier de sauvegarde :** Initialisation d'un dossier `/backups`.
2.  **Règle de sauvegarde automatique :** Avant chaque modification de `index.html`, le système doit créer une copie de sauvegarde horodatée et numérotée (ex: `index_v1.0_YYYY-MM-DD-HHMM.html`).
3.  **Incrémentation de la version :** Un badge de version (ex: `v1.0`) présent sur le tableau de bord est incrémenté à chaque modification validée (v1.1, v1.2, etc.).

## 3. Intégration des Données en Temps Réel (Onglets Aperçu et Agents)
1.  **Extraction des métriques :** Le tableau de bord passe de données codées en dur à des données dynamiques récupérées depuis le serveur backend Hermès.
2.  **Affichage global (Overview) :** Mise à jour des compteurs globaux : charge CPU, utilisation des jetons (tokens API), nombre total d'exécutions, etc.
3.  **Affichage par agent (Agents) :** Affichage des statuts individuels pour les 9 agents :
    *   **Manager** (Coordinateur / Spécialiste du routage)
    *   **Recherche** (Spécialiste de la recherche et du sourcing)
    *   **Analyse** (Spécialiste de la synthèse et de la veille IA)
    *   **Redacteur** (Spécialiste de la rédaction longue)
    *   **Social** (Spécialiste du contenu court et des réseaux)
    *   **Reseau** (Spécialiste de l'infrastructure)
    *   **Developpeur** (Spécialiste du code)
    *   **Vision-Image** (Spécialiste des documents et images)
    *   **Vision-Media** (Spécialiste des médias vidéo/audio)
4.  **Journaux d'activité (Logs) :** Connexion d'un flux d'événements affichant les actions récentes des agents (ex: "Acknowledged dashboard server start", "Analyzed query", etc.).
5.  **Tiroir de détails (Drawer) :** Configuration d'une interface latérale s'ouvrant au clic sur un agent pour afficher ses statistiques détaillées.

## 4. Gestion des Tâches (Onglet Tasks / Kanban)
1.  **Connexion à la base de données :** Relier le tableau Kanban à la base de données des tâches.
2.  **Gestion des statuts :** Gérer trois colonnes : "À faire" (To Do), "En cours" (In progress), "Terminé" (Done).
3.  **Création de tâches :** Permettre l'ajout manuel de nouvelles missions depuis l'interface.
4.  **Glisser-déposer (Drag & Drop) :** Implémenter le déplacement visuel des cartes entre les colonnes.
5.  **Synchronisation du Drag & Drop :** Lors d'un déplacement, mettre à jour le statut de la tâche correspondante dans la base de données de manière asynchrone pour refléter le changement.

## 5. Interface de Communication Directe (Onglet Chat)
1.  **Liaison avec la session :** Connecter l'interface de chat web directement à la boucle d'interaction des agents (indépendant de Telegram).
2.  **Routage des messages :** S'assurer que les requêtes de l'utilisateur sont envoyées au bon agent (souvent le Manager en premier lieu).
3.  **Nettoyage des messages :** Implémenter un filtre pour supprimer les métadonnées internes ou les préfixes (ex: `[Working directory: /root]`) des réponses des agents afin de garder une interface utilisateur propre.

## 6. Bibliothèque de Contenus (Onglet Content)
1.  **Détection des documents longs :** Configurer les agents pour qu'ils n'envoient pas de textes très longs directement dans le chat.
2.  **Génération de documents :** Lorsqu'un agent produit un rapport, un article ou une recherche longue (ex: Markdown), le fichier est sauvegardé dans un dossier spécifique (`/content/<nom_agent>/`).
3.  **Affichage dans la bibliothèque :** L'onglet Content lit ces répertoires et affiche les documents générés avec un rendu lisible.

## 7. Planification des Tâches (Onglet Schedule / Cron Jobs)
1.  **Intégration du système Cron :** Connecter l'interface aux tâches planifiées d'Hermès.
2.  **Visualisation des tâches :** Afficher la liste des tâches récurrentes (ex: "Morning briefing", "Daily Bible Message").
3.  **Nettoyage initial :** Supprimer les tâches d'exemple (mock data) pour ne charger que les tâches réelles.
4.  **Exécution manuelle :** Intégrer un bouton permettant de forcer l'exécution immédiate d'une tâche planifiée à des fins de test.

## 8. Visualisation 3D du Bureau (Onglet Office)
1.  **Chargement de la scène :** Afficher une représentation visuelle (ville/bâtiments) où chaque tour représente un agent.
2.  **Indicateurs d'état dynamique :**
    *   **Inactif (Idle) :** Le bâtiment de l'agent est éclairé en couleur **Orange**.
    *   **Actif (Working) :** Dès qu'une tâche lui est assignée, le bâtiment change de couleur et devient **Cyan (Bleu)**.
3.  **Temps réel :** Cette vue est connectée au statut d'exécution en temps réel des agents.

## 9. Documentation Globale (Onglet Docs)
1.  **Mise à disposition du manuel :** Fournir une vue statique contenant le mode d'emploi, les règles et la documentation architecturale pour l'administrateur du système.
