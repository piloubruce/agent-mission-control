/**
 * Gestion du thème Dark / Light.
 *
 * Le thème est appliqué via une classe sur <html> (`dark` ou `light`).
 * Les couleurs claires sont définies dans index.css en surchargeant les
 * variables de palette Tailwind v4 (`--color-stone-*`) sous `html.light`,
 * ce qui inverse automatiquement toutes les classes stone-* de l'app
 * sans toucher aux composants.
 */
import { useEffect, useState } from 'react';

export type ThemeName = 'dark' | 'light';
export const THEME_KEY = 'mc_theme';

/** Lit le thème persisté (défaut : dark). */
export function loadTheme(): ThemeName {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* localStorage indisponible */ }
  return 'dark';
}

/** Applique la classe sur <html> et persiste le choix. */
export function applyTheme(theme: ThemeName): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  // Notifie les composants montés (ConfigTab / TopNav) pour rester synchro.
  window.dispatchEvent(new CustomEvent<ThemeName>('mc-theme-change', { detail: theme }));
}

/** À appeler une fois au démarrage (main.tsx). */
export function initTheme(): ThemeName {
  const t = loadTheme();
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(t);
  return t;
}

/** Hook React : thème courant + bascule, synchronisé entre composants. */
export function useTheme(): [ThemeName, (t?: ThemeName) => void] {
  const [theme, setTheme] = useState<ThemeName>(() => loadTheme());

  useEffect(() => {
    const onChange = (e: Event) => setTheme((e as CustomEvent<ThemeName>).detail);
    window.addEventListener('mc-theme-change', onChange);
    return () => window.removeEventListener('mc-theme-change', onChange);
  }, []);

  const toggle = (t?: ThemeName) => {
    const next: ThemeName = t ?? (theme === 'dark' ? 'light' : 'dark');
    applyTheme(next);
    setTheme(next);
  };

  return [theme, toggle];
}
