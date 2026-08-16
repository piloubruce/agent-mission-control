# Hermès Mission Control — Changelog

## v1.16 - 2026-07-31
### corrections
- Modèle multi-agent : filtrage des providers aligné sur la modale par agent ; un provider avec tous ses modèles blacklistés ou une liste vide n’est plus affiché, sauf provider courant d’un agent sélectionné.

## v1.15 - 2026-07-31
### corrections
- Modèle multi-agent : filtrage exhaustif des providers masqués quand tous leurs modèles sont blacklistés ou quand leur liste est vide, sauf provider courant d’un agent sélectionné.

## v1.14 - 2026-07-31
### corrections
- Modèle multi-agent : listing providers/modèles filtré par la blacklist Scan, comme la modale par agent.

## v1.13 - 2026-07-31
### corrections
- Modèle multi-agent : la modale se ferme automatiquement après une application réussie.

## v1.12 - 2026-07-31
### corrections
- Agent multi-modèle : le backend batch accepte bien le format envoyé par la modale `{agents, provider, model}` au lieu d'exiger seulement une liste `items`; l'application s'appliquait donc à aucun agent.

## v1.11 - 2026-07-31
### corrections
- Messages : suppression du doublon visible sur l'envoi utilisateur dans l'historique immédiatement après un send, avant la réponse agent.

## v1.10 - 2026-07-30
### fonctionnalités & UI
- Ajout du bouton **Modèle multi-agent** dans l’onglet Agents, avec sélection par cases à cocher + tout cocher/tout décocher.
- Propagation du statut `finalizing` dans les réponses messages serveur pour coller au comportement Telegram.
- Amélioration de l’expérience Messages : bulles user persistantes immédiatement, anti-doublon, reprise du stream après changement d’onglet/agent.

## v1.01
- Version précédente connue du tableau de bord.
