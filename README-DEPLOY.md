# Déploiement Dashboard Hermès Mission Control

## Architecture cible

- **Frontend** : React + Vite (`src/`, `index.html`, `vite.config.ts`, `package.json`)
- **Backend** : `agent-mission-control-legacy/server.py`
- **Pas de Node/Express en production**

## Règles strictes

1. Le serveur `server.py` fait **à la fois** :
   - API `/api/*`
   - SSE `/events`
   - service des fichiers statiques du build React

2. **Ne pas ajouter** de `server.ts`, `server.cjs`, `npm run dev`, ni de proxy Node dans le repo.

3. **Ne pas toucher** aux fichiers Hermès Agent (`~/.hermes/`).

## Modifications autorisées

Uniquement les fichiers du frontend :
- `src/**/*.tsx`
- `src/**/*.ts`
- `index.html`
- `vite.config.ts`
- `package.json` / `package-lock.json` / `bun.lock`
- `tsconfig.json`
- styles et assets

Toute modification backend passe par le legacy `server.py` uniquement.

## Build local

```bash
npm install
npm run build
```

## Déploiement local sur VM

Copier le build React vers le backend legacy :
- source build : `dist/`
- cible backend : `agent-mission-control-legacy/dashboard/dist/`

Puis lancer :
```bash
cd agent-mission-control-legacy
python server.py
```

## Intégration Hermès

- `server.py` lit directement `~/.hermes/` (configs, profils, state.db, sessions)
- Pas de proxy, pas d’API externe nécessaire
- Les chemins Hermès sont résolus via `$HERMES_HOME` ou `~/.hermes/`

## GitHub

- Le repo doit rester frontend-only
- `npm run build` produit le frontend servi par `server.py`
- Pas de serveur Node en dépendance d’exécution
