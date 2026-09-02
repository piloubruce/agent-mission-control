/**
 * #4 — Onglet CONFIGURATION.
 *  - Thème Dark / Light (lib/theme.ts, classe sur <html>, persistance locale)
 *  - Raccourcis clavier personnalisables (Ctrl/Alt/Shift + touche -> onglet)
 *  - Round-trip GET /api/config -> POST /api/config -> GET /api/config
 *    (fallback localStorage tant que le backend ne sert pas l'endpoint).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SlidersHorizontal, Sun, Moon, Save, RotateCcw,
  RefreshCw, CheckCircle2, AlertTriangle, Keyboard,
  GripVertical,
} from 'lucide-react';
import { TabId } from '../../types';
import { useTheme } from '../../lib/theme';
import {
  DEFAULT_HOTKEYS, TAB_LABELS, VALID_TABS, loadHotkeys, saveHotkeys,
  normalizeCombo, formatCombo, parseCombo,
  type HotkeyCombo, type HotkeyMap,
} from '../../lib/hotkeys';
import { getConfig, setConfig } from '../../lib/mcApi';
import type { CfgSource } from '../../lib/mcApi';
import { createBackup, listBackups, downloadBackupUrl, restoreBackup } from '../../lib/mcApi';
import { getModelCatalog, refreshModelCatalog, getScanResults, type ModelCatalog, type ScanModelResult } from '../../api';


// Row state pour l'édition des raccourcis
interface HotkeyRow {
  tab: TabId;
  combo: string;  // ex: "ctrl+1", "alt+t", "x"
}

// Clé localStorage pour l'ordre des cellules (drag & drop)
const ORDER_KEY = 'mc_hotkeys_order';

// Charge l'ordre persiste des cellules, sinon l'ordre canonique VALID_TABS.
function loadOrder(): TabId[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [...VALID_TABS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...VALID_TABS];
    const valid = (parsed.filter(t => VALID_TABS.includes(t as TabId)) as TabId[]);
    for (const t of VALID_TABS) {
      if (!valid.includes(t)) valid.push(t);  // tabs manquants -> fin
    }
    return valid;
  } catch {
    return [...VALID_TABS];
  }
}

function saveOrder(order: TabId[]): void {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
}

// Convertit la map hotkeys en lignes pour l'UI, dans l'ordre fourni.
// BUG FIX (audit 2026-08-07) : l'ancienne version poussait les tabs SANS
// combo en fin de liste (2e boucle) — un tab réordonné par drag & drop mais
// sans raccourci (ex: TIMELINE « — ») semblait "refuser de se déplacer".
function mapToRows(map: HotkeyMap, order: TabId[] = VALID_TABS): HotkeyRow[] {
  const rows: HotkeyRow[] = [];
  for (const tab of order) {
    let combo = '';
    for (const [c, target] of Object.entries(map)) {
      if (target === tab) { combo = c; break; }
    }
    rows.push({ tab, combo });
  }
  return rows;
}

// Convertit les lignes en map hotkeys
function rowsToMap(rows: HotkeyRow[]): HotkeyMap {
  const out: HotkeyMap = {};
  for (const r of rows) {
    const normalized = normalizeCombo(r.combo);
    if (normalized.length > 0 && VALID_TABS.includes(r.tab)) {
      // Vérifier qu'il n'y a pas de doublon de combo
      if (!Object.values(out).includes(r.tab)) {
        out[normalized] = r.tab;
      }
    }
  }
  return out;
}

// Génère les labels pour les cases à cocher des modificateurs
const MOD_LABELS = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Maj',
  key: '',
};

// Champs sensibles à masquer dans l'affichage de la configuration brute
const SENSITIVE_KEYS = ['password', 'password_hash', 'apiKey', 'api_key', 'token', 'secret'];

// Fonction pour masquer les champs sensibles dans un objet JSON
function maskSensitive(obj: unknown, maxDepth = 10, currentDepth = 0): unknown {
  if (currentDepth > maxDepth) return '...';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => maskSensitive(item, maxDepth, currentDepth + 1));
  }
  
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some(s => lowerKey.includes(s))) {
      result[key] = '********';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = maskSensitive(value, maxDepth, currentDepth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const ConfigTab: React.FC = () => {
  const [theme, toggleTheme] = useTheme();
  const [order, setOrder] = useState<TabId[]>(loadOrder);
  const [rows, setRows] = useState<HotkeyRow[]>(() => mapToRows(loadHotkeys(), loadOrder()));
  const [editingCombo, setEditingCombo] = useState<{ tab: TabId; combo: string } | null>(null);

  const [source, setSource] = useState<CfgSource>('local');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [rawCfg, setRawCfg] = useState<string>('');
  // Drag & drop : index source + index survolé pour le reorder visuel
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  // Providers visibles dans Scan : catalogue /api/models + config scan_providers
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [scanProviders, setScanProviders] = useState<Record<string, boolean>>({});
  const [scanProvLoaded, setScanProvLoaded] = useState(false);
  const [scanProvError, setScanProvError] = useState<string | null>(null);
  const [scanProvLoadError, setScanProvLoadError] = useState<string | null>(null);
  const [scanProvSaving, setScanProvSaving] = useState(false);
  const [scanProvSaved, setScanProvSaved] = useState(false);
  const [scanProvRefreshing, setScanProvRefreshing] = useState(false);
  const [backupList, setBackupList] = useState<Array<{name: string; size: number; mtime: number}>>([]);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Modèles scannés pour la création de combos virtuels
  const [scannedModels, setScannedModels] = useState<ScanModelResult[]>([]);
  // Modèles virtuels / combos (créés depuis scans)
  const [virtualCombos, setVirtualCombos] = useState<Array<{name: string; models: {provider: string; model: string}[]}>>([]);
  const [comboName, setComboName] = useState('');
  const [selectedScanModels, setSelectedScanModels] = useState<Set<string>>(new Set());
  // Filtres pour la liste des modèles scannés
  const [scanFilter, setScanFilter] = useState('');
  const [capFilter, setCapFilter] = useState({ vision: false, reasoning: false, tools: false });

  // --- chargement initial (GET /api/config) ---------------------------
  // Source de verite = SERVEUR. L'utilisateur a demande explicitement que
  // la sauvegarde ne vive PAS dans le localStorage (effacement du cache =
  // perte). reload() applique donc la config serveur telle quelle ; le
  // localStorage n'est qu'un cache de demarrage (premier rendu).
const reload = async () => {
  setBusy(true);
  try {
    const { config, source: src } = await getConfig();
    setSource(src);
    setRawCfg(JSON.stringify(config, null, 2));

    // Theme serveur : toujours l'appliquer (source de verite)
    if (config.theme) {
      document.documentElement.dataset.theme = config.theme;
    }

    // Modèles virtuels / combos
    const vcs = Array.isArray(config.virtual_combos) ? config.virtual_combos as Array<{name: string; models: {provider: string; model: string}[]}> : [];
    setVirtualCombos(vcs);

    if (source === 'server') {
      // Ordre serveur (hotkey_order) si present
      let nextOrder = order;
      if (Array.isArray(config.hotkey_order)) {
        const valid = (config.hotkey_order as unknown[]).filter(t => VALID_TABS.includes(t as TabId)) as TabId[];
        if (valid.length) {
          for (const t of VALID_TABS) if (!valid.includes(t)) valid.push(t);
          nextOrder = valid;
          setOrder(valid);
          // Note: order will be persisted to localStorage by the useEffect below
        }
      }
      // Raccourcis : utiliser ceux du backend si disponibles, sinon ceux du cache local
      let shortcutsMap: HotkeyMap;
      if (config.shortcuts && typeof config.shortcuts === 'object') {
        shortcutsMap = {};
        for (const [combo, tab] of Object.entries(config.shortcuts)) {
          const normalized = normalizeCombo(combo);
          if (normalized.length > 0 && VALID_TABS.includes(tab as TabId)) {
            shortcutsMap[normalized] = tab as TabId;
          }
        }
        // Persist these shortcuts to localStorage for caching
        saveHotkeys(shortcutsMap);
      } else {
        shortcutsMap = loadHotkeys();
      }
      setRows(mapToRows(shortcutsMap, nextOrder));
    } else {
      // Backend indisponible : on garde le cache local
      setRows(mapToRows(loadHotkeys(), order));
    }

    setMsg({
      kind: src === 'server' ? 'ok' : 'warn',
      text: src === 'server'
        ? 'Configuration chargée depuis le serveur.'
        : 'Endpoint /api/config indisponible — configuration locale (cache).',
    });
  } finally {
    setBusy(false);
  }
};

  useEffect(() => { void reload(); }, []);

  // --- Chargement des modèles scannés (GET /api/scan/results) ------------
  useEffect(() => {
    let cancelled = false;
    getScanResults()
      .then((r) => {
        if (!cancelled) setScannedModels(r.results ?? []);
      })
      .catch(() => {
        if (!cancelled) setScannedModels([]);
      });
    return () => { cancelled = true; };
  }, []);

  // --- Providers visibles dans Scan ------------------------------------
  // Charge le catalogue (GET /api/models) puis la config scan_providers.
  // Si scan_providers est vide ({}) -> TOUS les providers sont actifs
  // (backward compatibility, comportement identique au ScanTab).
  useEffect(() => {
    let cancelled = false;
    const loadScanProviders = async () => {
      try {
        const cat = await getModelCatalog();
        if (cancelled) return;
        setCatalog(cat);
        let cfg: Record<string, boolean> = {};
        try {
          const resp = await fetch('/api/config/scan_providers');
          if (resp.ok) {
            const data = await resp.json();
            cfg = (data.scan_providers || {}) as Record<string, boolean>;
          }
        } catch {
          // backend scan_providers indisponible : on garde {} (tout actif)
        }
        const hasCfg = Object.keys(cfg).length > 0;
        const next: Record<string, boolean> = {};
        for (const key of Object.keys(cat.providers || {})) {
          // mc-provider is always visible/enabled (virtual combos, not scanable)
          if (key === 'mc-provider') {
            next[key] = true;
            continue;
          }
          next[key] = hasCfg ? cfg[key] === true : true;
        }
        if (!cancelled) {
          setScanProviders(next);
          setScanProvLoaded(true);
          setScanProvError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setScanProvLoadError(e instanceof Error ? e.message : String(e));
          setScanProvLoaded(true);
        }
      }
    };
    void loadScanProviders();
    return () => { cancelled = true; };
  }, []);

  // Actualiser : force le backend a relire le catalogue (nouveaux providers
  // ajoutes via config.yaml `providers:` ou `hermes setup`), puis recharge
  // la liste + la selection scan_providers courante. Ne touche pas la config.
  const refreshScanProviders = async () => {
    setScanProvRefreshing(true);
    try {
      const res = await refreshModelCatalog();
      if (!res || res.ok === false) {
        throw new Error(res?.error || 'refresh echoue');
      }
      const cat = await getModelCatalog();
      setCatalog(cat);
      let cfg: Record<string, boolean> = {};
      try {
        const resp = await fetch('/api/config/scan_providers');
        if (resp.ok) {
          const data = await resp.json();
          cfg = (data.scan_providers || {}) as Record<string, boolean>;
        }
      } catch { /* garde {} */ }
      const hasCfg = Object.keys(cfg).length > 0;
      const next: Record<string, boolean> = {};
      for (const key of Object.keys(cat.providers || {})) {
        next[key] = hasCfg ? cfg[key] === true : true;
      }
      setScanProviders(next);
      setScanProvError(null);
      setScanProvLoadError(null);
    } catch (e) {
      setScanProvLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanProvRefreshing(false);
    }
  };

  // Sauvegarde immédiate : POST {"scan_providers": {...}} + flash 2s.
  const saveScanProviders = async (next: Record<string, boolean>) => {
    setScanProvSaving(true);
    try {
      const resp = await fetch('/api/config/scan_providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scan_providers: next }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      setScanProvSaved(true);
      savedTimer.current = setTimeout(() => setScanProvSaved(false), 2000);
      setScanProvError(null);
    } catch (e) {
      setScanProvError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanProvSaving(false);
    }
  };

  // Toggle d'un provider : met a jour l'etat + POST immediat.
  const toggleScanProvider = (key: string) => {
    const next = { ...scanProviders, [key]: !scanProviders[key] };
    setScanProviders(next);
    void saveScanProviders(next);
  };

  // Providers tries par ordre alphabétique.
  const providerList = useMemo(() => {
    if (!catalog) return [];
    return Object.entries(catalog.providers || {})
      .map(([key, meta]) => ({ key, display_name: meta.display_name || key, count: meta.count || 0 }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'fr', { sensitivity: 'base' }));
  }, [catalog]);

  // Nettoie le timer de flash au demontage.
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  // --- enregistrement (POST /api/config) ------------------------------
  // Source de verite = serveur : toute modification (✓, DnD, reset, bouton
  // Enregistrer) repousse la config complete au backend.
  const persist = async (nextRows: HotkeyRow[], nextOrder: TabId[], showMsg: boolean) => {
    const map = rowsToMap(nextRows);
    saveHotkeys(map);           // cache local rapide + event App
    saveOrder(nextOrder);       // cache local ordre

    // Format backend: combos completes
    const shortcuts: Record<string, string> = {};
    for (const [combo, tab] of Object.entries(map)) {
      shortcuts[combo] = tab;
    }
    const payload = { theme, shortcuts, hotkey_order: nextOrder, virtual_combos: virtualCombos };
    const r = await setConfig(payload);
    setSource(r.source);
    if (showMsg) {
      setMsg(r.ok
        ? { kind: 'ok', text: 'Configuration enregistrée sur le serveur.' }
        : { kind: 'warn', text: `Serveur indisponible (${r.error}) — modification conservée en cache local.` });
    }
    return r;
  };

  const save = async () => {
    setBusy(true);
    const r = await persist(rows, order, true);
    setBusy(false);
    // Round-trip : on relit pour prouver la persistance.
    const back = await getConfig();
    setRawCfg(JSON.stringify(back.config, null, 2));
  };

  const resetHotkeys = () => {
    const nextRows = mapToRows(DEFAULT_HOTKEYS, order);
    setRows(nextRows);
    void persist(nextRows, order, false);
  };

  // --- Drag & drop : réorganise la cellule from -> to (ordre persisté) ---
  const handleDrop = (from: number, to: number) => {
    setDragIdx(null);
    setOverIdx(null);
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
    const next = [...order];
    const tmp = next[from];
    next[from] = next[to];
    next[to] = tmp;
    setOrder(next);
    const nextRows = mapToRows(rowsToMap(rows), next);
    setRows(nextRows);
    void persist(nextRows, next, false);
  };

  // Gestion d'une combinaison complète (avec modificateurs)
  const [comboInput, setComboInput] = useState<string>('');
  const [mods, setMods] = useState({ ctrl: false, alt: false, shift: false });
  const [keyInput, setKeyInput] = useState<string>('');

  const startEditing = (tab: TabId, currentCombo: string = '') => {
    setEditingCombo({ tab, combo: currentCombo });
    setComboInput(currentCombo);
    const parsed = currentCombo ? parseCombo(currentCombo) : null;
    setMods(parsed?.mods ?? { ctrl: false, alt: false, shift: false });
    setKeyInput(parsed?.key ?? '');
  };

  const stopEditing = () => {
    setEditingCombo(null);
    setComboInput('');
    setMods({ ctrl: false, alt: false, shift: false });
    setKeyInput('');
  };

  const saveCombo = () => {
    if (!editingCombo) return;

    // Construire la combinaison complète
    let combo = '';
    if (mods.ctrl) combo += 'ctrl+';
    if (mods.alt) combo += 'alt+';
    if (mods.shift) combo += 'shift+';
    combo += keyInput;

    const newRows = rows.map(r => r.tab === editingCombo.tab ? { ...r, combo } : r);
    setRows(newRows);
    stopEditing();
    // FIX (audit 2026-08-07) : persister immediatement — serveur (source de
    // verite) + cache local — sinon un F5 apres le ✓ perdait la modif.
    void persist(newRows, order, false);
  };

  const setCombo = (tab: TabId, combo: string) => {
    setComboInput(combo);
    const parsed = parseCombo(combo);
    if (parsed) {
      setMods(parsed.mods);
      setKeyInput(parsed.key.toUpperCase());
    }
  };

  const card = 'bg-stone-900 border border-stone-800 rounded-3xl p-6';
  const btn = 'px-4 py-2 rounded-lg text-sm font-medium transition-colors';

  // Configuration masquée pour affichage ( Sensitive keys masked)
  const maskedCfg = rawCfg ? JSON.stringify(maskSensitive(JSON.parse(rawCfg)), null, 2) : '';

// Persist order to localStorage whenever it changes
useEffect(() => {
  saveOrder(order);
}, [order]);
  return (
    <div className="w-full space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-serif text-stone-100 flex items-center gap-3">
            <SlidersHorizontal className="w-7 h-7 text-orange-500" /> Configuration
          </h2>
          <p className="text-stone-500 mt-1">Préférences globales du dashboard.</p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={busy}
          className={`${btn} bg-stone-800 hover:bg-stone-700 text-stone-200 flex items-center gap-2 disabled:opacity-50`}
        >
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Recharger
        </button>
      </div>

      {/* --- Thème ------------------------------------------------------ */}
      <div className={card}>
        <h3 className="text-stone-300 font-medium mb-4">Apparence</h3>
        <div className="flex items-center gap-3">
          <button
            onClick={() => toggleTheme('dark')}
            className={`${btn} flex items-center gap-2 ${theme === 'dark'
              ? 'bg-orange-600 text-white'
              : 'bg-stone-800 text-stone-300 hover:bg-stone-700'}`}
          >
            <Moon className="w-4 h-4" /> Sombre
          </button>
          <button
            onClick={() => toggleTheme('light')}
            className={`${btn} flex items-center gap-2 ${theme === 'light'
              ? 'bg-orange-600 text-white'
              : 'bg-stone-800 text-stone-300 hover:bg-stone-700'}`}
          >
            <Sun className="w-4 h-4" /> Clair
          </button>
          <span className="text-xs text-stone-500 ml-2">
            Appliqué instantanément, persisté dans <code className="font-mono">mc_theme</code>.
          </span>
        </div>
      </div>

      {/* --- Raccourcis clavier ----------------------------------------- */}
      <div className={card}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-stone-300 font-medium flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-orange-500" /> Raccourcis clavier (libre)
          </h3>
          <button
            onClick={resetHotkeys}
            className="flex items-center gap-1.5 text-xs text-stone-500 hover:text-orange-500 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Valeurs par défaut
          </button>
        </div>
        <div
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const cellEls = Array.from(e.currentTarget.querySelectorAll('[draggable="true"]')) as HTMLElement[];
            const fromIdx = dragIdx ?? -1;
            // Hit-test: check if cursor is INSIDE any cell's bounding rect
            let hitIdx = -1;
            for (let i = 0; i < cellEls.length; i++) {
              if (i === fromIdx) continue;
              const r = cellEls[i].getBoundingClientRect();
              if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                hitIdx = i;
                break;
              }
            }
            let target = cellEls.length;
            if (hitIdx >= 0) {
              // Cursor is inside a cell → insert before that cell
              target = hitIdx;
            } else {
              // Not inside any cell → find the first cell below the cursor
              for (let i = 0; i < cellEls.length; i++) {
                if (i === fromIdx) continue;
                const r = cellEls[i].getBoundingClientRect();
                if (e.clientY < r.top + r.height / 2) { target = i; break; }
              }
            }
            if (overIdx !== target) setOverIdx(target);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const fromRaw = e.dataTransfer.getData('text/plain');
            const from = fromRaw !== '' ? Number(fromRaw) : (dragIdx ?? 0);
            const cellEls = Array.from(e.currentTarget.querySelectorAll('[draggable="true"]')) as HTMLElement[];
            let hitIdx = -1;
            let bestDist = Infinity;
            for (let i = 0; i < cellEls.length; i++) {
              if (i === from) continue;
              const r = cellEls[i].getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              const d = Math.hypot(e.clientX - cx, e.clientY - cy);
              if (d < bestDist) {
                bestDist = d;
                hitIdx = i;
              }
            }
            const to = hitIdx >= 0 ? hitIdx : from;
            handleDrop(Number.isFinite(from) ? from : 0, to);
          }}
        >
          {rows.map((r, idx) => (
            <div
              key={r.tab}
              draggable
              onDragStart={(e) => {
                setDragIdx(idx);
                e.dataTransfer.effectAllowed = 'move';
                // L'index source doit voyager dans le DataTransfer : setState
                // est asynchrone, le drop survient dans le meme tick et ne
                // peut pas compter sur dragIdx (toujours null a ce moment).
                e.dataTransfer.setData('text/plain', String(idx));
              }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
              className={`flex items-center justify-between bg-stone-950/60 border rounded-xl px-4 py-2.5 transition-colors cursor-grab active:cursor-grabbing ${
                dragIdx === idx
                  ? 'border-orange-600/80 opacity-60'
                  : overIdx === idx
                    ? 'border-orange-500 bg-orange-950/40'
                    : 'border-stone-800 hover:border-stone-700'
              }`}
              title="Glisser pour réorganiser"
            >
              <div className="flex items-center gap-2 min-w-0">
                <GripVertical className="w-4 h-4 text-stone-600 shrink-0" />
                <span className="text-sm text-stone-300 tracking-wide truncate">{TAB_LABELS[r.tab]}</span>
              </div>
              {editingCombo?.tab === r.tab ? (
                <div className="flex items-center gap-2">
                  {/* Modificateurs */}
                  <button
                    type="button"
                    onClick={() => setMods(prev => ({ ...prev, ctrl: !prev.ctrl }))}
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      mods.ctrl ? 'bg-orange-600 text-white' : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
                    }`}
                  >
                    Ctrl
                  </button>
                  <button
                    type="button"
                    onClick={() => setMods(prev => ({ ...prev, alt: !prev.alt }))}
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      mods.alt ? 'bg-orange-600 text-white' : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
                    }`}
                  >
                    Alt
                  </button>
                  <button
                    type="button"
                    onClick={() => setMods(prev => ({ ...prev, shift: !prev.shift }))}
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      mods.shift ? 'bg-orange-600 text-white' : 'bg-stone-800 text-stone-300 hover:bg-stone-700'
                    }`}
                  >
                    Maj
                  </button>
                  {/* Touche */}
                  <input
                    type="text"
                    value={keyInput}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveCombo();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        stopEditing();
                      } else if (e.code && e.code.startsWith('Numpad')) {
                        const numMatch = e.code.match(/^Numpad(\d)$/);
                        if (numMatch) {
                          e.preventDefault();
                          setKeyInput(numMatch[1]);
                        } else if (e.code === 'NumpadDivide') {
                          e.preventDefault();
                          setKeyInput('/');
                        } else if (e.code === 'NumpadMultiply') {
                          e.preventDefault();
                          setKeyInput('*');
                        } else if (e.code === 'NumpadSubtract') {
                          e.preventDefault();
                          setKeyInput('-');
                        } else if (e.code === 'NumpadAdd') {
                          e.preventDefault();
                          setKeyInput('+');
                        }
                      }
                    }}
                    onChange={(e) => setKeyInput(e.target.value.slice(-1).toUpperCase())}
                    maxLength={1}
                    className="w-8 text-center bg-stone-900 border border-stone-700 rounded-md py-1 text-sm font-mono text-orange-400 focus:outline-none focus:border-orange-600"
                  />
                  <button
                    type="button"
                    onClick={saveCombo}
                    className="px-2 py-1 rounded text-xs text-emerald-400 hover:bg-stone-800"
                    title="Sauvegarder"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    onClick={stopEditing}
                    className="px-2 py-1 rounded text-xs text-stone-400 hover:bg-stone-800"
                    title="Annuler"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => startEditing(r.tab, r.combo)}
                  className="px-3 py-1 rounded text-xs font-mono text-stone-400 hover:bg-stone-800"
                  title="Modifier"
                >
                  {r.combo ? formatCombo(r.combo) : <span className="text-stone-600">—</span>}
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-stone-600 mt-3">
          Glissez les cellules (icône ⠿) pour les réorganiser — l'ordre est mémorisé.<br />
          Les raccourcis sont ignorés pendant la saisie dans un champ texte.<br />
          Combinaisons libres : Ctrl, Alt, Shift peuvent être combinés avec n'importe quelle touche.
        </p>
      </div>

      {/* --- Providers visibles dans Scan ------------------------------- */}
      <div className={card}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-stone-300 font-medium">Providers visibles dans Scan</h3>
          <button
            type="button"
            onClick={refreshScanProviders}
            disabled={scanProvRefreshing || !scanProvLoaded}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed text-stone-200 text-xs font-medium transition-colors"
            title="Relire les providers depuis la config Hermès (sans redémarrer le serveur)"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanProvRefreshing ? 'animate-spin' : ''}`} />
            {scanProvRefreshing ? 'Actualisation…' : 'Actualiser'}
          </button>
        </div>
        <p className="text-xs text-stone-500 mb-4">
          Les providers décochés n'apparaîtront pas dans l'onglet Scan. Cliquez « Actualiser » après avoir ajouté un provider (config.yaml ou hermes setup).
        </p>
        {!scanProvLoaded ? (
          <div className="flex items-center gap-2 text-sm text-stone-500">
            <RefreshCw className="w-4 h-4 animate-spin" /> Chargement des providers…
          </div>
        ) : providerList.length === 0 ? (
          <p className="text-sm text-stone-500">
            Aucun provider disponible (catalogue vide).
          </p>
        ) : (
          <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 gap-2 space-y-2">
            {providerList.map((p) => (
              <div key={p.key} className="break-inside-avoid">
                <label
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-stone-950/60 border border-stone-800 hover:border-stone-700 transition-colors cursor-pointer w-full"
                >
                  <input
                    type="checkbox"
                    checked={!!scanProviders[p.key]}
                    onChange={() => toggleScanProvider(p.key)}
                    className="accent-orange-600"
                  />
                  <span className="text-sm text-stone-400 min-w-0">
                    {p.display_name}{' '}
                    <span className="text-stone-600">({p.count} modèle{p.count > 1 ? 's' : ''})</span>
                  </span>
                </label>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2 text-sm min-h-5">
          {scanProvSaving && (
            <span className="text-stone-500 flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Sauvegarde…
            </span>
          )}
          {!scanProvSaving && scanProvSaved && (
            <span className="text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" /> Sauvegardé
            </span>
          )}
          {scanProvError && (
            <span className="text-red-400 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" /> Erreur de sauvegarde : {scanProvError}
            </span>
          )}
          {!scanProvError && scanProvLoadError && (
            <span className="text-red-400 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" /> Erreur de chargement des providers : {scanProvLoadError}
            </span>
          )}
          {!scanProvSaving && !scanProvSaved && !scanProvError && (
            <span className="text-xs text-stone-600">Sauvegarde immédiate à chaque modification.</span>
          )}
        </div>
      </div>

      {/* --- Modèles Virtuels / Combos --- */}
      <div className={card}>
        <h3 className="text-stone-300 font-medium mb-4">Modèles Virtuels Créés</h3>
        <p className="text-xs text-stone-500 mb-4">
          Agrégez des modèles scannés (Scan) sous un nom virtuel utilisable sur tous les agents.
          Sélectionnez des modèles dans la liste ci-dessous, donnez un nom, puis Enregistrez.
        </p>

        {/* Formulaire de création */}
        <div className="flex flex-wrap gap-3 items-end mb-4">
          <div className="flex flex-col flex-1 min-w-[180px]">
            <label className="text-xs text-stone-500 mb-1">Nom du modèle virtuel</label>
            <input
              type="text"
              value={comboName}
              onChange={(e) => setComboName(e.target.value)}
              placeholder="ex: Best Coding"
              className="px-3 py-1.5 bg-stone-900 border border-stone-700 rounded-md text-sm text-stone-200 focus:outline-none focus:border-orange-600"
            />
          </div>
          <button
            onClick={() => {
              if (!comboName.trim()) {
                setMsg({ kind: 'warn', text: 'Indiquez un nom pour le modèle virtuel.' });
                return;
              }
              if (selectedScanModels.size === 0) {
                setMsg({ kind: 'warn', text: 'Sélectionnez au moins un modèle scanné.' });
                return;
              }
              const models = Array.from(selectedScanModels).map((k) => {
                const [provider, model] = k.split('::');
                return { provider, model };
              });
              setVirtualCombos([...virtualCombos, { name: comboName.trim(), models }]);
              setComboName('');
              setSelectedScanModels(new Set());
              setMsg({ kind: 'ok', text: `Modèle virtuel "${comboName.trim()}" créé (pensez à Enregistrer).` });
            }}
            className={`${btn} bg-orange-600 hover:bg-orange-500 text-white flex items-center gap-2`}
          >
            Créer
          </button>
        </div>

        {/* Liste des modèles scannés (OK seulement) avec checkboxes */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs text-stone-500 uppercase">Modèles scannés disponibles (OK)</h4>
          </div>
          {/* Filtres: nom + capacités V/R/T */}
          <div className="flex flex-wrap gap-2 items-end mb-2">
            <div className="flex flex-col flex-1 min-w-[200px]">
              <input
                type="text"
                value={scanFilter}
                onChange={(e) => setScanFilter(e.target.value)}
                placeholder="Filtrer par nom de modèle..."
                className="px-3 py-1.5 bg-stone-900 border border-stone-700 rounded-md text-sm text-stone-200 focus:outline-none focus:border-orange-600"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="flex items-center gap-0.5">
                <input
                  type="checkbox"
                  checked={capFilter.vision}
                  onChange={(e) => setCapFilter({ ...capFilter, vision: e.target.checked })}
                  className="accent-orange-600 w-3 h-3"
                />
                <span className="text-xs text-stone-400">V</span>
              </label>
              <label className="flex items-center gap-0.5">
                <input
                  type="checkbox"
                  checked={capFilter.reasoning}
                  onChange={(e) => setCapFilter({ ...capFilter, reasoning: e.target.checked })}
                  className="accent-orange-600 w-3 h-3"
                />
                <span className="text-xs text-stone-400">R</span>
              </label>
              <label className="flex items-center gap-0.5">
                <input
                  type="checkbox"
                  checked={capFilter.tools}
                  onChange={(e) => setCapFilter({ ...capFilter, tools: e.target.checked })}
                  className="accent-orange-600 w-3 h-3"
                />
                <span className="text-xs text-stone-400">T</span>
              </label>
            </div>
          </div>
          {scannedModels.length === 0 ? (
            <p className="text-xs text-stone-500 italic">Aucun modèle scanné. Lancez un scan dans l'onglet Scan.</p>
          ) : (
            <div className="space-y-1 max-h-60 overflow-y-auto border border-stone-800 rounded-lg p-2">
              {scannedModels
                .filter((r) => r.ok === true && r.provider && r.model)
                .reduce((acc: ScanModelResult[], r) => {
                  const seen = new Set(acc.map((x) => `${x.provider}::${x.model}`));
                  if (!seen.has(`${r.provider}::${r.model}`)) acc.push(r);
                  return acc;
                }, [])
                .filter((r) => {
                  // Filtre par nom (provider + model)
                  if (scanFilter.trim()) {
                    const fullName = `${r.provider} / ${r.model}`.toLowerCase();
                    if (!fullName.includes(scanFilter.toLowerCase())) return false;
                  }
                  // Filtre par capacités
                  if (capFilter.vision && !r.vision_supported) return false;
                  if (capFilter.reasoning && !r.reasoning_supported) return false;
                  if (capFilter.tools && !r.tools_supported) return false;
                  return true;
                })
                .sort((a, b) => {
                  const ta = a.tokens_per_sec ?? 0;
                  const tb = b.tokens_per_sec ?? 0;
                  return tb - ta;
                })
                .map((r) => {
                  const key = `${r.provider}::${r.model}`;
                  const checked = selectedScanModels.has(key);
                  return (
                    <label key={key} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-stone-900/30 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = new Set(selectedScanModels);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          setSelectedScanModels(next);
                        }}
                        className="accent-orange-600"
                      />
                      <span className="text-sm text-stone-300 font-mono truncate">
                        {r.provider} / {r.model}
                      </span>
                      {r.tokens_per_sec && (
                        <span className="text-xs text-stone-600">
                          ({r.tokens_per_sec} tok/s)
                        </span>
                      )}
                      {/* Capacités V/R/T */}
                      <span className="flex items-center gap-0.5 text-xs font-mono">
                        <span className={r.vision_supported ? 'text-emerald-400' : 'text-stone-600'}>V</span>
                        <span className={r.reasoning_supported ? 'text-emerald-400' : 'text-stone-600'}>R</span>
                        <span className={r.tools_supported ? 'text-emerald-400' : 'text-stone-600'}>T</span>
                      </span>
                    </label>
                  );
                })}
            </div>
          )}
        </div>

        {/* Liste des combos existants */}
        {virtualCombos.length === 0 ? (
          <p className="text-xs text-stone-500 italic">Aucun modèle virtuel créé.</p>
        ) : (
          <div className="space-y-2">
            {virtualCombos.map((combo, i) => (
              <div key={i} className="flex items-center justify-between bg-stone-950/60 p-3 rounded-lg border border-stone-800">
                <div>
                  <span className="text-sm text-stone-200 font-medium">{combo.name}</span>
                  <span className="text-xs text-stone-500 ml-2">({combo.models.length} modèles)</span>
                  <div className="text-xs text-stone-600 mt-1">
                    {combo.models.map((m) => `${m.provider}/${m.model}`).join(', ')}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const comboStr = combo.models.map((m) => `${m.provider}::${m.model}`).join('\n');
                      const newName = prompt('Nouveau nom pour le modèle virtuel ?', combo.name);
                      if (newName !== null && newName.trim()) {
                        const next = [...virtualCombos];
                        next[i].name = newName.trim();
                        setVirtualCombos(next);
                        setMsg({ kind: 'ok', text: `Combo renommé en "${newName.trim()}".` });
                      }
                    }}
                    className="text-xs text-orange-400 hover:text-orange-300"
                  >
                    Éditer
                  </button>
                  <button
                    onClick={() => {
                      const next = virtualCombos.filter((_, idx) => idx !== i);
                      setVirtualCombos(next);
                      void persist(rows, order, false);
                      setMsg({ kind: 'ok', text: `Modèle virtuel "${combo.name}" supprimé.` });
                    }}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Supprimer
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* --- Bas : Sauvegarde | Enregistrer | Config brute (3 colonnes) --- */}
      {msg && (
        <div className={`flex items-start gap-2 text-sm rounded-xl px-4 py-3 border mb-6 ${
          msg.kind === 'ok'
            ? 'text-emerald-400 border-emerald-900/50 bg-emerald-950/20'
            : 'text-amber-400 border-amber-900/50 bg-amber-950/20'
        }`}>
          {msg.kind === 'ok'
            ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span>{msg.text}</span>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

        {/* Colonne 1 — Sauvegarde / Restauration */}
        <div className={card}>
          <h3 className="text-stone-300 font-medium mb-4">Sauvegarde / Restauration</h3>
          <div className="space-y-4">
            {/* Créer un backup */}
            <div className="flex items-center gap-3">
              <button
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await createBackup();
                    if (res.ok) {
                      setMsg({ kind: 'ok', text: `Backup créé : ${res.backup_name}` });
                    } else {
                      setMsg({ kind: 'warn', text: res.error || 'Erreur inconnue' });
                    }
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy || !scanProvLoaded}
                title={scanProvLoaded ? 'Créer un backup maintenant' : 'Chargement des providers en cours…'}
                className={`${btn} bg-orange-600 hover:bg-orange-500 text-white flex items-center gap-2 disabled:opacity-50`}
              >
                {scanProvLoaded ? 'Créer un backup maintenant' : 'Chargement…'}
              </button>
              {busy && <RefreshCw className="w-4 h-4 animate-spin" />}
            </div>

            {/* Liste des backups */}
            <div>
              <div className="flex justify-between items-start mb-2">
                <span className="font-medium">Backups disponibles</span>
              <button
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await listBackups();
                    if (res.ok) {
                      setBackupList(res.backups || []);
                    } else {
                      setMsg({ kind: 'warn', text: res.error || 'Erreur liste' });
                    }
                  } finally {
                    setBusy(false);
                  }
                }}
                className="flex items-center gap-1.5 text-xs text-stone-500 hover:text-orange-500 transition-colors"
              >
                <RefreshCw className="w-3 h-3" /> Rafraichir
              </button>
            </div>
            {backupList.length === 0 ? (
              <p className="text-xs text-stone-500 italic">Aucun backup trouvé.</p>
            ) : (
              <div className="space-y-2">
                {backupList.map((backup) => (
                  <div key={backup.name} className="flex items-center gap-3 bg-stone-950/60 border rounded-xl px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between">
                        <span className="text-sm text-stone-300 font-mono truncate max-w-[200px]">{backup.name}</span>
                        <span className="text-xs text-stone-500">{new Date(backup.mtime * 1000).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between mt-1">
                        <span className="text-xs text-stone-400">{(backup.size / 1024 / 1024).toFixed(1)} Mo</span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <a
                        href={downloadBackupUrl(backup.name)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-1 rounded bg-stone-800 hover:bg-stone-700 text-stone-300 text-xs font-medium"
                      >
                        Télécharger
                      </a>
                      <button
                        onClick={async () => {
                          if (window.confirm(`Attention : cette opération va remplacer la configuration actuelle par celle du backup\\n${backup.name}\\n\\nCette action est irréversible. Continuer ?`)) {
                            setBusy(true);
                            try {
                              const res = await restoreBackup(backup.name);
                              if (res.ok) {
                                setMsg({ kind: 'ok', text: `Backup restauré : ${backup.name}` });
                                // Forcer un reload pour refléter la nouvelle config
                                void reload();
                              } else {
                                setMsg({ kind: 'warn', text: res.error || 'Erreur restauration' });
                              }
                            } finally {
                              setBusy(false);
                            }
                          }
                        }}
                        disabled={busy}
                        className="flex items-center gap-2 px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-medium"
                      >
                        Restaurer
                      </button>
                      {busy && <RefreshCw className="w-3 h-3 animate-spin" />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        </div>

        {/* Colonne 2 — Enregistrer */}
        <div className={card}>
          <h3 className="text-stone-300 font-medium mb-4">Enregistrer</h3>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => void save()}
              disabled={busy}
              className={`${btn} bg-orange-600 hover:bg-orange-500 text-white flex items-center justify-center gap-2 disabled:opacity-50`}
            >
              <Save className="w-4 h-4" /> Enregistrer
            </button>
            <span className="text-xs text-stone-500">
              Source actuelle : <span className="font-mono text-stone-400">{source === 'server' ? '/api/config' : 'localStorage'}</span>
            </span>
          </div>
        </div>

        {/* Colonne 3 — Configuration brute (rarement consultée) */}
        <details className={card}>
          <summary className="text-stone-400 text-sm cursor-pointer">Configuration brute (relecture après enregistrement)</summary>
          <pre className="mt-3 text-xs font-mono text-stone-400 whitespace-pre-wrap break-all">{maskedCfg || '{}'}</pre>
        </details>

      </div>


    </div>
  );
};