import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {migrateLegacyFavs} from './mcFavsMigration';
import {initTheme} from './lib/theme';

// Applique le theme (dark par defaut) AVANT le premier rendu, pour eviter
// tout flash de couleurs au chargement.
initTheme();

// Migration one-shot des favoris localStorage -> serveur. Fire-and-forget:
// l'UI se monte immediatement, la migration se fait en tache de fond.
void migrateLegacyFavs();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
