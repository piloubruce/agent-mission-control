/**
 * Raccourcis clavier personnalisables du dashboard.
 * Map : "combo" (ex: "ctrl+1", "alt+t", "shift+s", "x") -> TabId, persistée dans localStorage `mc_hotkeys`.
 * Le Ctrl est plus maintenant optionnel - n'importe quelle combinaison est supportée.
 */
import { TabId } from '../types';

export const HOTKEYS_KEY = 'mc_hotkeys';

export type HotkeyCombo = string; // ex: "ctrl+1", "alt+t", "shift+s", "x"
export type HotkeyMap = Record<HotkeyCombo, TabId>;

export const DEFAULT_HOTKEYS: HotkeyMap = {
  '1': 'overview',
  '2': 'agents',
  '3': 'messages',
  '4': 'tasks',
  '5': 'timeline',
  '6': 'content',
  '7': 'schedule',
  '8': 'scan',
  '9': 'config',
  '0': 'terminal',
  '/': 'files',
};

export const VALID_TABS: TabId[] = [
  'overview', 'agents', 'messages', 'tasks', 'timeline',
  'content', 'schedule', 'scan', 'config', 'terminal', 'files',
];

export const TAB_LABELS: Record<TabId, string> = {
  overview: 'APERÇU',
  agents: 'AGENTS',
  messages: 'MESSAGES',
  tasks: 'TÂCHES',
  timeline: 'CHRONOLOGIE',
  content: 'CONTENU',
  schedule: 'PLANIFICATION',
  scan: 'BALAYAGE',
  config: 'CONFIGURATION',
  terminal: 'TERMINAL',
  files: 'EXPLORATEUR',
};

/** Normalise une combinaison: minuscule, trim, espaces supprimés. */
export function normalizeCombo(combo: string): string {
  return combo.trim().toLowerCase().replace(/\s+/g, '');
}

/** Parse une combinaison et retourne les modificateurs et la touche. */
export function parseCombo(combo: string): { mods: { ctrl: boolean; alt: boolean; shift: boolean }; key: string } | null {
  const normalized = normalizeCombo(combo);
  if (!normalized) return null;

  const mods = { ctrl: false, alt: false, shift: false };
  let key = normalized;
  const parts = normalized.split('+');

  if (parts.length === 1) {
    // Pas de modificateur, juste une touche
    key = parts[0];
  } else {
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part === 'ctrl') mods.ctrl = true;
      else if (part === 'alt') mods.alt = true;
      else if (part === 'shift') mods.shift = true;
    }
    key = parts[parts.length - 1];
  }

  if (key.length !== 1) return null;
  return { mods, key };
}

/** Extrait et normalise la touche depuis un KeyboardEvent (gère le pavé numérique / Numpad). */
export function getEventKey(e: KeyboardEvent): string {
  if (e.code) {
    const numMatch = e.code.match(/^Numpad(\d)$/);
    if (numMatch) return numMatch[1];
    if (e.code === 'NumpadDivide') return '/';
    if (e.code === 'NumpadMultiply') return '*';
    if (e.code === 'NumpadSubtract') return '-';
    if (e.code === 'NumpadAdd') return '+';
    if (e.code === 'NumpadDecimal') return '.';
  }
  return (e.key || '').toLowerCase();
}

/** Vérifie si une combinaison correspond à un événement clavier. */
export function matchesCombo(combo: string, e: KeyboardEvent): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;

  const eventKey = getEventKey(e);
  const rawKey = (e.key || '').toLowerCase();

  // Vérifier que la touche principale correspond (soit key directe, soit code pavé numérique)
  if (rawKey !== parsed.key && eventKey !== parsed.key) return false;

  // Vérifier les modificateurs
  if (e.ctrlKey !== parsed.mods.ctrl) return false;
  if (e.altKey !== parsed.mods.alt) return false;
  if (e.shiftKey !== parsed.mods.shift) return false;

  return true;
}

/** Retourne une liste d'affichage pour une combinaison (ex: "ctrl+1" -> "Ctrl + 1"). */
export function formatCombo(combo: string): string {
  const parsed = parseCombo(combo);
  if (!parsed) return combo;

  const parts: string[] = [];
  if (parsed.mods.ctrl) parts.push('Ctrl');
  if (parsed.mods.alt) parts.push('Alt');
  if (parsed.mods.shift) parts.push('Maj');
  parts.push(parsed.key.toUpperCase());
  return parts.join(' + ');
}

/** Map inverse : tab -> combo (pour affichage dans ConfigTab). */
export function mapToCombos(map: HotkeyMap): { tab: TabId; combo: string }[] {
  return VALID_TABS.map((tab) => ({ tab, combo: map[tab] ?? '' })).filter((x) => x.combo !== '');
}

/** Crée une map à partir d'une liste de lignes [tab -> combo]. */
export function combosToMap(rows: { tab: TabId; combo: string }[]): HotkeyMap {
  const out: HotkeyMap = {};
  for (const r of rows) {
    const normalized = normalizeCombo(r.combo);
    if (normalized.length > 0 && VALID_TABS.includes(r.tab)) {
      out[normalized] = r.tab;
    }
  }
  return out;
}

/** Lit la map persistée, en filtrant les entrées invalides. */
export function loadHotkeys(): HotkeyMap {
  try {
    const raw = localStorage.getItem(HOTKEYS_KEY);
    if (!raw) return { ...DEFAULT_HOTKEYS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_HOTKEYS };

    const out: HotkeyMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const combo = normalizeCombo(String(k));
      if (combo.length > 0 && VALID_TABS.includes(v as TabId)) {
        out[combo] = v as TabId;
      }
    }
    return Object.keys(out).length ? out : { ...DEFAULT_HOTKEYS };
  } catch {
    return { ...DEFAULT_HOTKEYS };
  }
}

export function saveHotkeys(map: HotkeyMap): void {
  try { localStorage.setItem(HOTKEYS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent<HotkeyMap>('mc-hotkeys-change', { detail: map }));
}