import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Scan, Play, Square, CheckSquare, CheckCircle2, XCircle, AlertTriangle, Loader2, TestTube, Ban, Trash2, FileDown, ChevronUp, ChevronDown } from 'lucide-react';
import { getModelCatalog, startScan, getScanStatus, getActiveScans, cancelScan, getBlacklist, toggleBlacklist, clearBlacklist, ModelCatalog, ScanStatus, ScanModelResult, testCapabilities, CapabilityResult, BlacklistMap, getScanResults, clearScanResults, calculateModelScore, isUnmeasured, type ModelScore, getModelSpecs, getHermesRegistryModel } from '../../api';
import { filterModels } from '../../lib/filterModels';

const parseCapBoolean = (val: unknown): boolean | undefined => {
  if (val === true || val === 1 || val === '1' || val === 'true' || val === 'yes' || val === 't' || val === 'OK' || val === 'ok') return true;
  if (val === false || val === 0 || val === '0' || val === 'false' || val === 'no' || val === 'f' || val === 'KO' || val === 'ko') return false;
  return undefined;
};

const toBool = (val: unknown): boolean => {
  return parseCapBoolean(val) === true;
};

const isTruthyCap = (val: unknown): boolean => {
  return parseCapBoolean(val) === true;
};


const CapBadge: React.FC<{ label: string; value: boolean | 'time' | undefined; neterr?: boolean }> = ({ label, value, neterr }) => {
  let cls = 'text-stone-500 border-stone-800';
  let icon = null;
  let title: string | undefined;
  if (value === 'time') {
    // 2026-08-12 : sonde expiree (timeout) -> rectangle ORANGE arrondi + AlertTriangle.
    // Le TEXTE affiche le label de la capacite (Vision / Raison. / Tools).
    cls = 'text-orange-300 border-orange-700 bg-orange-900/30';
    icon = <AlertTriangle className="w-3 h-3" />;
    title = 'timeout (sonde expirée)';
  } else if (value === true) {
    cls = 'text-emerald-400 border-emerald-900/60 bg-emerald-900/20';
    icon = <CheckCircle2 className="w-3 h-3" />;
  } else if (value === false) {
    cls = 'text-red-400 border-red-900/60 bg-red-900/20';
    icon = <XCircle className="w-3 h-3" />;
  } else if (neterr === true) {
    cls = 'text-amber-500 border-amber-700 bg-amber-900/20';
    icon = <AlertTriangle className="w-3 h-3" />;
    title = 'à revérifier (réseau)';
  }
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium ${cls}`}>
      {icon}
      {label}
    </span>
  );
};


// Badge de score (Feature 7) : note /100 + lettre A/B/C/D, code couleur.
// Le detail du calcul est expose au survol (title).
const ScoreBadge: React.FC<{ score: ModelScore; unmeasured?: boolean }> = ({ score, unmeasured }) => {
  // 2026-08-06 : un modele sans AUCUNE mesure de test de vie (jamais scanne,
  // ou ligne remise a plat par la reparation) affiche '—', exactement comme la
  // modale ModelSelector. Un score serait indistinguable d'un modele KO.
  if (unmeasured) {
    return (
      <span
        data-score="none"
        title="Modele non mesure — lancez un scan (test de vie) pour obtenir un score"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-stone-800 text-stone-600 text-[10px] font-medium cursor-help"
      >
        —
      </span>
    );
  }
  const letter = score.score_letter;
  const color = ({
    A: 'text-emerald-400 bg-emerald-900/20 border-emerald-800',
    B: 'text-blue-400 bg-blue-900/20 border-blue-800',
    C: 'text-amber-400 bg-amber-900/20 border-amber-800',
    D: 'text-red-400 bg-red-900/20 border-red-800',
  } as Record<string, string>)[letter] ?? 'text-stone-400 bg-stone-800/50 border-stone-700';

  return (
    <span
      title={score.detail}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium cursor-help ${color}`}
    >
      <span className="font-mono tabular-nums">{score.score}</span>
      <span className="opacity-70">{letter}</span>
    </span>
  );
};

// Score enrichi : latence + debit (tok/s) + capacites PROUVEES.
// `cap` = entree du store de capacites (source la plus fraiche) ; on retombe
// sur les champs persistes de la ligne si le store ne connait pas la cle.
// Les capacites inconnues (undefined) sont ignorees par calculateModelScore.
const getModelScore = (
  m: ScanModelResult,
  cap?: { vision_supported?: boolean; reasoning_supported?: boolean; tools_supported?: boolean },
): ModelScore => {
  return calculateModelScore({
    latency_ms: m.latency_ms ?? null,
    ok: m.ok ?? false,
    error: m.reason ?? null,
    tokens_per_sec: m.tokens_per_sec ?? null,
    vision_supported: cap?.vision_supported ?? m.vision_supported,
    reasoning_supported: cap?.reasoning_supported ?? m.reasoning_supported,
    tools_supported: cap?.tools_supported ?? m.tools_supported,
  });
};

// Valeur sentinelle de l'option "Tous les providers" dans le <select>.
const ALL_PROVIDERS = '__all__';

// Allowed providers for the Scan tab (user wants to see only these and have them enabled by default)
const ALLOWED_PROVIDER_KEYS = ['nvidia', 'nous', 'openrouter', 'ollama', 'lmstudio'];

// ---- v1.17.63 : filtre du TABLEAU + colonnes deplacables ----
// Normalisation insensible a la casse ET aux accents (NFD + suppression des
// diacritiques). Utilisee par le filtre texte du tableau de resultats.
const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

// ---- 2026-08-06 : VERDICT DE VIE A 3 ETATS ----
// Le backend renvoie desormais `life_state` ('vert' | 'orange' | 'rouge').
// Les lignes anterieures a la migration ne l'ont pas : on retombe alors sur
// le booleen `ok` historique (true -> vert, false -> rouge). Aucune ligne
// existante n'est donc affichee differemment tant qu'elle n'est pas re-scannee.
type LifeState = 'vert' | 'orange' | 'rouge' | 'time';
const lifeStateOf = (m: ScanModelResult): LifeState => {
  const ls = (m as { life_state?: string }).life_state;
  if (ls === 'vert' || ls === 'orange' || ls === 'rouge' || ls === 'time') return ls;
  return m.ok ? 'vert' : 'rouge';
};
// Libelle + mots-cles de recherche associes a chaque etat (filtre du tableau).
const LIFE_LABEL: Record<LifeState, string> = {
  vert: 'VERT (OK)',
  orange: 'ORANGE (repond)',
  rouge: 'ROUGE (KO)',
  time: 'TIMEOUT',
};

// Identifiants STABLES des 14 colonnes du tableau d'historique. L'ordre
// ci-dessous est l'ordre PAR DEFAUT (= ordre historique v1.17.62).
const DEFAULT_COL_ORDER = [
  'provider',
  'model',
  'scan',
  'scan_sel',
  'last_checked',
  'status',
  'latency',
  'tps',
  'score',
  'bl',
  'test',
  'test_sel',
  'caps_checked',
  'vision',
  'reasoning',
  'tools',
] as const;
type ColId = (typeof DEFAULT_COL_ORDER)[number];

// Cle localStorage dediee a l'ordre des colonnes (independante du store scan).
const MC_SCAN_COL_ORDER_KEY = 'mc_scan_col_order';

// Lit l'ordre persiste et le RECONCILIE avec DEFAULT_COL_ORDER :
// - on ne garde que des ids connus (pas de colonne fantome),
// - on ajoute a la fin les ids manquants (montee de version = nouvelle colonne).
// Garantit TOUJOURS 14 ids uniques -> alignement colgroup/th/td preserve.
const loadColOrder = (): ColId[] => {
  const base = [...DEFAULT_COL_ORDER] as ColId[];
  try {
    const raw = localStorage.getItem(MC_SCAN_COL_ORDER_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return base;
    const known = new Set<string>(DEFAULT_COL_ORDER);
    const seen = new Set<string>();
    const out: ColId[] = [];
    for (const id of saved) {
      if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id as ColId);
      }
    }
    for (const id of base) {
      if (seen.has(id)) continue;
      // MIGRATION (v1.17.76 : ajout de 'bl') : un ordre persiste ANTERIEUR ne
      // contient pas le nouvel id. On ne l'ajoute pas betement a la fin : on
      // l'insere JUSTE APRES son predecesseur de DEFAULT_COL_ORDER s'il est
      // deja present (ex: 'bl' se replace apres 'score'), sinon a la fin.
      const defIdx = base.indexOf(id);
      let insertAt = out.length;
      for (let k = defIdx - 1; k >= 0; k--) {
        const prevIdx = out.indexOf(base[k]);
        if (prevIdx >= 0) { insertAt = prevIdx + 1; break; }
      }
      out.splice(insertAt, 0, id);
      seen.add(id);
    }
    return out;
  } catch {
    return base;
  }
};

// Modele aplati (mode multi-providers). provider = cle reelle du provider.
interface FlatModel {
  provider: string; // cle provider (ex: 'lmstudio')
  display: string;  // nom affiche (ex: 'LM Studio')
  id: string;       // id du modele
  description?: string;
}

// Objet fusionne cote frontend (utilise pour le rendu en mode single ET multi).
interface MergedScan {
  provider: string;            // provider reel (single) ou '__all__' (multi)
  total: number;
  done: number;
  status: 'running' | 'cancelling' | 'done' | 'cancelled' | 'error';
  configured: boolean;
  error?: string | null;
  results: ScanModelResult[];  // resultats taggues avec .provider en mode multi
  // En mode multi, garde la map scan_id -> ScanStatus pour traçabilité/affichage.
  raw?: Record<string, ScanStatus>;
}

// ---- Store module-level (survit au demontage du composant) ----
// App.tsx demonte/remonte ScanTab a chaque changement d'onglet ; ce store
// (hors composant) conserve l'etat pour restaurer + reprendre un poll en cours.
interface ScanSessionStore {
  provider: string;
  checked: string[];                          // cles "provider::model"
  merged: MergedScan | null;
  scanning: boolean;
  caps: Record<string, CapabilityResult>;
  scanIds: string[];
  scanProv: Record<string, string>;          // scan_id -> provider reel
  scans: Record<string, ScanStatus>;         // scan_id -> dernier ScanStatus (traçabilité)
  byKey: Record<string, ScanModelResult>;    // upsert "provider::model" -> resultat
  filter: string;                            // champ "Filtrer" (checklist)
  tableFilter: string;                       // filtre de recherche dans le tableau
  sortKey: 'provider' | 'model' | 'latency' | 'tps' | 'score' | 'last_checked' | 'caps_checked' | null;
  sortDir: 'asc' | 'desc';
  onlyOk: boolean;
  onlyKo: boolean;
  capsLastChecked: Record<string, number>;          // cle "provider::model" -> epoch secondes (horodatage tests capacites)
  lastBatchKeys: string[];                           // clés "provider::model" du DERNIER scan lance (pour le compteur "Ce scan")
  scanChecked: string[];                             // colonne scan_sel : cles "provider::model" cochees
  testChecked: string[];                             // colonne test_sel : cles "provider::model" cochees
}
const scanSession: ScanSessionStore = {
  provider: '',
  checked: [],
  scanChecked: [],
  testChecked: [],
  merged: null,
  scanning: false,
  caps: {},
  scanIds: [],
  scanProv: {},
  scans: {},
  byKey: {},
  filter: '',
  tableFilter: '',
  sortKey: null,
  sortDir: 'desc',
  onlyOk: false,
  onlyKo: false,
  capsLastChecked: {},
  lastBatchKeys: [],
};

// Construit un MergedScan a partir du store byKey + meta d'un poll.
const buildMergedFromByKey = (
  tagProvider: boolean,
  providerForSingle: string,
  total: number,
  done: number,
  status: MergedScan['status'],
  configured: boolean,
  error: string | null,
  raw: Record<string, ScanStatus>,
): MergedScan => ({
  provider: tagProvider ? ALL_PROVIDERS : providerForSingle,
  total,
  done,
  status,
  configured,
  error,
  results: Object.values(scanSession.byKey),
  raw,
});

// Normalize any `results` field (from localStorage restore or legacy API
// shapes) into a ScanModelResult[]: arrays pass through unchanged, dicts
// keyed by "provider::model" become Object.values (history preserved),
// anything else -> []. Prevents the "f.filter is not a function" crash when
// merged.results was a dict. Used at every ingestion point, not just render.
const normalizeResults = (r: unknown): ScanModelResult[] =>
  Array.isArray(r)
    ? r
    : r && typeof r === 'object'
      ? (Object.values(r) as ScanModelResult[]).filter(
          (x) => x != null && typeof x === 'object',
        )
      : [];

// Upsert par cle "provider::model" : le re-scan ecrase les anciennes valeurs,
// les modeles d'autres scans/providers sont conserves. En multi le provider est
// deja taggue sur chaque resultat ; en single on utilise providerForSingle.
const applyResultsUpsert = (
  results: ScanModelResult[],
  tagProvider: boolean,
  providerForSingle: string,
): void => {
  for (const r of results) {
    // Clé TOUJOURS non-vide : en multi on prend le provider taggué sur le
    // résultat (ou le provider du scan courant en secours) ; en single on
    // prend le provider du scan. Garantit que 2 providers partageant le même
    // modèle ne s'écrasent pas (clés "provA::model" vs "provB::model").
    const p = tagProvider ? (r.provider || providerForSingle || '') : (providerForSingle || r.provider || '');
    const key = `${p}::${r.model}`;
    const existing = scanSession.byKey[key];
    const fallbackSpecs = (!r.specs_display && !existing?.specs_display) ? getHermesRegistryModel(p, r.model) : null;
    scanSession.byKey[key] = {
      ...(existing || {}),
      ...r,
      context_length: r.context_length ?? existing?.context_length ?? fallbackSpecs?.context_length,
      parameter_count: r.parameter_count ?? existing?.parameter_count,
      specs_display: r.specs_display ?? existing?.specs_display ?? fallbackSpecs?.specs_display,
      specs_error: r.specs_error ?? existing?.specs_error ?? fallbackSpecs?.error,
    };
  }
};

// ---- Persistance localStorage (survit au F5 / rechargement complet) ----
const MC_SCAN_KEY = 'mc_scan_session_v1';

// Ecrit l'etat complet du store dans localStorage. Aucun Set/Map/function
// dans scanSession (checked deja tableau) -> JSON.stringify OK.
const persistScanSession = (): void => {
  try {
    localStorage.setItem(MC_SCAN_KEY, JSON.stringify(scanSession));
  } catch {
    // quota plein / localStorage indisponible : on ignore silencieusement.
  }
};

// Lit localStorage au chargement du module et fusionne dans scanSession
// (AVANT la declaration des useState -> les valeurs par defaut sont
// ecrasees par celles restaurees). Champs restaures : provider, checked,
// merged, scanning, caps, scanIds, scanProv, scans, byKey, filter, sortKey,
// sortDir, onlyOk, capsLastChecked.
const loadScanSession = (): void => {
  try {
    const raw = localStorage.getItem(MC_SCAN_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<ScanSessionStore>;
    if (saved && typeof saved === 'object') {
      if (typeof saved.provider === 'string') scanSession.provider = saved.provider;
      if (Array.isArray(saved.checked)) scanSession.checked = saved.checked;
      // FIX RACINE (2026-08-13, Bob): une ancienne version serialisait
      // merged.results comme un dict. On le normalise au chargement pour
      // reparer les sessions locales corrompues (dict -> array, historique
      // conserve via Object.values).
      if (saved.merged !== undefined) {
        scanSession.merged = {
          ...saved.merged,
          results: normalizeResults(saved.merged.results),
        };
      }
      if (saved.scanning !== undefined) scanSession.scanning = saved.scanning;
      if (saved.caps && typeof saved.caps === 'object') scanSession.caps = saved.caps;
      if (saved.scanIds) scanSession.scanIds = saved.scanIds;
      if (saved.scanProv) scanSession.scanProv = saved.scanProv;
      if (saved.scans) scanSession.scans = saved.scans;
      if (saved.byKey) scanSession.byKey = saved.byKey;
      if (typeof saved.filter === 'string') scanSession.filter = saved.filter;
      if (typeof saved.tableFilter === 'string') scanSession.tableFilter = saved.tableFilter;
      if (saved.sortKey !== undefined) scanSession.sortKey = saved.sortKey;
      if (saved.sortDir) scanSession.sortDir = saved.sortDir;
      if (typeof saved.onlyOk === 'boolean') scanSession.onlyOk = saved.onlyOk;
      if (typeof saved.onlyKo === 'boolean') scanSession.onlyKo = saved.onlyKo;
      if (saved.capsLastChecked) scanSession.capsLastChecked = saved.capsLastChecked;
      if (Array.isArray(saved.scanChecked)) scanSession.scanChecked = saved.scanChecked;
      if (Array.isArray(saved.testChecked)) scanSession.testChecked = saved.testChecked;
      // 2026-08-20 : on RESTAURE lastBatchKeys depuis localStorage (comme
      // scanning/scanIds) au lieu de le forcer a []. Sinon, apres F5, le
      // compteur de progression du scan en cours perdait son denominateur
      // (756) et retombait sur merged.total qui pouvait cumuler d'anciens
      // scans encore vivants cote serveur -> "49 sur 2259 / 3015". Le batch
      // de 756 reste la reference du compteur "Ce scan".
      if (Array.isArray(saved.lastBatchKeys)) scanSession.lastBatchKeys = saved.lastBatchKeys;
    }
  } catch {
    // JSON corrompu : on ignore et on garde les valeurs par defaut.
  }
};

// Helper d'ecriture : applique un patch au store + persiste dans localStorage.
// Remplace TOUTES les ecritures directes scanSession.X = Y.
const setStore = (patch: Partial<ScanSessionStore>): void => {
  Object.assign(scanSession, patch);
  persistScanSession();
};

// Vide l'etat persiste (resultats/historique) et le store en memoire.
// Exportee pour un bouton "Effacer les resultats" : vide le store +
// localStorage, l'UI est ensuite resettee par l'appelant.
export const clearScanSession = (): void => {
  scanSession.byKey = {};
  scanSession.merged = null;
  scanSession.scanning = false;
  scanSession.scanIds = [];
  scanSession.scanProv = {};
  scanSession.scans = {};
  scanSession.checked = [];
  persistScanSession();
};

// Hydrate le store depuis localStorage AU MONTAGE DU MODULE (avant les
// useState du composant). Apres cela, les useState initiaux lisent deja
// les valeurs restaurees -> survit au F5.
loadScanSession();

export const ScanTab: React.FC = () => {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [provider, setProvider] = useState<string>(scanSession.provider);
  // Les cles sont NAMESPACED: provider + "::" + id (ex: "lmstudio::qwen2.5").
  const [checked, setChecked] = useState<Set<string>>(new Set(scanSession.checked));
  // Nouvelles selections DANS le tableau (colonnes scan_sel / test_sel).
  const [scanChecked, setScanChecked] = useState<Set<string>>(new Set(scanSession.scanChecked));
  const [testChecked, setTestChecked] = useState<Set<string>>(new Set(scanSession.testChecked));
  const [scanning, setScanning] = useState<boolean>(scanSession.scanning);
  // vFIX (2026-08-13) : lastBatchKeys en state React (le module store
  // scanSession.lastBatchKeys n'est PAS reactif -> compteur Scannes jamais affiche).
  const [, setLastBatchKeysState] = useState<string[]>(scanSession.lastBatchKeys);
  // 'merged' remplace l'ancien 'status' dans tout le rendu. En mode single il a
  // le meme contenu qu'un ScanStatus (incl. provider reel), donc affichage identique.
  const [merged, setMerged] = useState<MergedScan | null>(scanSession.merged);
  const [error, setError] = useState<string | null>(null);
  const [onlyOk, setOnlyOk] = useState<boolean>(scanSession.onlyOk); // filtre: uniquement les modeles OK
  const [onlyKo, setOnlyKo] = useState<boolean>(scanSession.onlyKo); // filtre: uniquement les modeles KO
  const [providerScanConfig, setProviderScanConfig] = useState<Record<string, boolean>>({});
  const [providerScanConfigLoading, setProviderScanConfigLoading] = useState<boolean>(false);
  const [sortKey, setSortKey] = useState<'provider' | 'model' | 'latency' | 'tps' | 'score' | 'last_checked' | 'caps_checked' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  // Champ "Filtrer" (filtre la liste de cases a cocher, pas les resultats de scan).
  const [filter, setFilter] = useState<string>('');
  // v1.17.63 - filtre DEDIE au tableau de resultats (AFFICHAGE UNIQUEMENT :
  // ne touche jamais scanSession.byKey ni la DB serveur).
  const [tableFilter, setTableFilter] = useState<string>('');
  // v1.17.141 - Filtres capacites (Vision/Raison/Tools) pour la checklist ET le tableau.
  const [capFilter, setCapFilter] = useState<{ vision: boolean; reasoning: boolean; tools: boolean }>({
    vision: false, reasoning: false, tools: false,
  });
  // v1.17.63 - ordre des colonnes (persiste dans localStorage, cle dediee).
  const [colOrder, setColOrder] = useState<ColId[]>(() => loadColOrder());
  // Colonne actuellement saisie par le drag, et cible de survol (indicateur).
  const [dragCol, setDragCol] = useState<ColId | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColId | null>(null);
  // Distinction drag / clic : vrai des qu'un dragstart a eu lieu, remis a faux
  // peu apres le dragend -> un onClick issu du drag est ignore, le clic simple
  // (tri / start-stop) passe normalement.
  const draggingRef = useRef(false);
  const stopScanRef = useRef(false);
  const [caps, setCaps] = useState<Record<string, CapabilityResult>>(scanSession.caps);
  // vFIX (2026-08-13) : modeles dont la capacite a ete TESTEE DANS CETTE
  // SESSION (pas l'historique global). Sert au compteur "Testes X/Y" qui
  // doit partir de 0 au lancement, pas du nombre de modeles deja testes
  // par le passe (sinon 54/92 au depart puis monte progressivement).
  const [testedSession, setTestedSession] = useState<Set<string>>(new Set());
  const [scannedSession, setScannedSession] = useState<Set<string>>(new Set());
  const [capsBusy, setCapsBusy] = useState<Record<string, boolean>>({});
  // Etat 'busy' global des boutons d'en-tete 'Tout tester' ('all'|'vision'|'reasoning'|'tools'|null).
  const [testingAll, setTestingAll] = useState<null | 'all' | 'vision' | 'reasoning' | 'tools'>(null);
  // Total figé AU LANCEMENT d'une série de tests : ne doit PAS décroître quand
  // les modèles se décochent. Le compteur "Testés X / Y" affiche X = modèles
  // testés dans cette session, Y = total figé ici (et non testChecked.size).
  const [testTotal, setTestTotal] = useState<number>(0);
  // v1.17.60 - ARRET PROPRE des series de tests de capacites.
  // Etat SUIVI PAR COLONNE (pas de flag global): 'running' = serie en cours,
  // 'stopping' = arret demande, on laisse finir le test deja parti puis on
  // vide la file. Deux colonnes peuvent tourner/s'arreter independamment.
  const [colState, setColState] = useState<Record<string, 'running' | 'stopping'>>({});
  // Ref lue DANS la boucle (le state React n'est pas visible dans une closure
  // deja demarree) : stopColsRef.current[kind] === true => on sort de la boucle
  // AVANT d'emettre la requete suivante.
  const stopColsRef = useRef<Record<string, boolean>>({});
  // Arret demande sur un bouton de ligne : cle `${provider}::${model}::${cap}`.
  const [rowStopping, setRowStopping] = useState<Record<string, boolean>>({});
  const [rowScanStopping, setRowScanStopping] = useState<Record<string, boolean>>({});
  const scanOneStoppingRef = useRef<Record<string, boolean>>({});
  // Blacklist des modeles KO (persistee serveur). Map provider -> [model_ids].
  const [blacklist, setBlacklist] = useState<BlacklistMap>({});
  // Busy pendant un toggle/clear blacklist.
  const [blBusy, setBlBusy] = useState(false);
  // v1.17.76 : busy PAR LIGNE pour l'icone BL du tableau (cle provider::model).
  const [blRowBusy, setBlRowBusy] = useState<Record<string, boolean>>({});
  // v1.17.69 : total de modeles blacklistes, TOUS providers confondus.
  const blTotalCount = useMemo(
    () => Object.values(blacklist).reduce((n, l) => n + (l?.length ?? 0), 0),
    [blacklist],
  );
  // Horodatage (epoch secondes) du dernier test de capacites par modele.
  const [capsLastChecked, setCapsLastChecked] = useState<Record<string, number>>(scanSession.capsLastChecked);

  // Charge la blacklist au montage du tab.
  useEffect(() => {
    let cancelled = false;
    getBlacklist()
      .then((b) => { if (!cancelled) setBlacklist(b); })
      .catch(() => { if (!cancelled) setBlacklist({}); });
    return () => { cancelled = true; };
  }, []);

  // Recharge la blacklist (apres scan terminé ou apres un toggle/clear).
  const reloadBlacklist = React.useCallback(() => {
    getBlacklist()
      .then(setBlacklist)
      .catch(() => setBlacklist({}));
  }, []);

  // Persiste l'horodatage des tests de capacites dans le store module-level
  // (survit au demontage/remontage de l'onglet, comme 'caps').
  useEffect(() => {
    setStore({ capsLastChecked });
  }, [capsLastChecked]);

  // Persiste les capacites dans le store module-level & localStorage
  useEffect(() => {
    setStore({ caps });
  }, [caps]);

  // Persiste les selections DANS le tableau (scan_sel / test_sel).
  useEffect(() => {
    setStore({ scanChecked: [...scanChecked] });
  }, [scanChecked]);
  useEffect(() => {
    setStore({ testChecked: [...testChecked] });
  }, [testChecked]);

  // Tri cliquable sur les en-tetes. Meme colonne -> inverse; sinon -> nouvelle
  // colonne avec direction par defaut (asc pour le nom, desc pour temps/tps).
  const toggleSort = (col: 'provider' | 'model' | 'latency' | 'tps' | 'score' | 'last_checked' | 'caps_checked') => {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col);
      setSortDir(col === 'model' || col === 'provider' ? 'asc' : 'desc');
    }
  };

  // Poll timer ref so we can stop it on cancel/unmount.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // scan_id actifs (tous les scans lances, single ou multi).
  const scanIdsRef = useRef<string[]>(scanSession.scanIds);
  // scan_id -> provider reel (pour tagguer les resultats en mode multi).
  const scanProvRef = useRef<Record<string, string>>(scanSession.scanProv);
  // Etat brut des scans (scan_id -> ScanStatus) pour le merge.
  const scansRef = useRef<Record<string, ScanStatus>>(scanSession.scans);
  // Track previous provider so the "clear view on provider change" effect
  // only fires on a REAL user change, not on mount/restore/catalog-load.
  const prevProviderRef = useRef<string | null>(null);

  // Load the dynamic provider catalog (P3/P6) once.
  useEffect(() => {
    let cancelled = false;
    getModelCatalog()
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        // Ne pas ecraser le provider deja restaure (localStorage/DB) au F5.
        // On ne pose une valeur par defaut QUE si aucun provider n'est restoré.
        // Defaut premiere visite : "Tous les providers" (mode multi), pas un
        // provider specifique. Le fix F5 reste intact car le bloc est gardé
        // sous `if (!scanSession.provider)` -> skippé au F5/restore.
        if (!scanSession.provider) {
          setProvider(ALL_PROVIDERS);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, []);

  // Load provider scan config on mount
  useEffect(() => {
    const loadProviderScanConfig = async () => {
      setProviderScanConfigLoading(true);
      try {
        const resp = await fetch('/api/config/scan_providers');
        if (resp.ok) {
          const data = await resp.json();
          setProviderScanConfig(data.scan_providers || {});
        }
      } catch (e) {
        console.error('Failed to load provider scan config:', e);
      } finally {
        setProviderScanConfigLoading(false);
      }
    };
    loadProviderScanConfig();
  }, []);

  // vRESTORE (2026-08-11) : compteur "Tous les providers (N)" = modèles
  // DISPONIBLES = ok (scannés répondus) + NON blacklistés + provider COCHÉ
  // en Configuration (scan_providers). Source = scanSession.byKey (issu de
  // scan_results.db, avec `ok`), PAS catalog.providers (qui ne porte que les
  // `count` -> affichait 1041 au lieu de ~138). Cohérent avec les modals
  // d'attribution de modèle et le bandeau SCAN "X OK".
  const allModelsAvailable = useMemo(() => {
    if (!providerScanConfig || Object.keys(providerScanConfig).length === 0) {
      // Config pas encore chargée : on ne compte pas (évitons un 0 erroné).
      return 0;
    }
    let n = 0;
    for (const r of Object.values(scanSession.byKey)) {
      const p = (r.provider || '').trim();
      if (!p || !r.model) continue;
      if (providerScanConfig[p] !== true) continue;   // SEULEMENT providers cochés
      if (r.ok !== true) continue;                      // SEULEMENT modèles OK (disponibles)
      const bl = new Set(blacklist[p] || []);
      if (bl.has(r.model)) continue;                     // hors blacklist
      n++;
    }
    return n;
  }, [providerScanConfig, blacklist, merged, scanning]);

  // DEMANDE 1: au montage, restaure les resultats persistes cote serveur
  // (scan_results.db) dans le store module-level `byKey` SI le store local
  // (localStorage / memoire) n'a pas deja des resultats. Cela donne une
  // persistance "vraie base" en plus du localStorage, sans ecraser une
  // session scan en cours. La DB est la source de verite cote serveur.
  // POINT 3 (2026-08-01, DEVELOPPEUR): l'historique doit TOUJOURS s'afficher.
  // AVANT: la restauration depuis scan_results.db etait sautee des que le store
  // module-level `byKey` contenait quoi que ce soit (ou que `merged` existait),
  // ce qui faisait disparaitre l'historique quand le store local etait vide/reset
  // ou partiel. MAINTENANT: on charge la DB a CHAQUE montage et on FUSIONNE.
  // Fusion non destructive: les entrees deja presentes dans byKey (scan en cours,
  // resultats plus recents) gagnent; la DB ne fait que combler les trous.
  // Seul "EFFACER LES RESULTATS" vide le tableau (il purge aussi la DB serveur).
  useEffect(() => {
    let cancelled = false;
    getScanResults()
      .then((resp) => {
        // Normalise au cas ou le backend renverrait un dict (robustesse);
        // le backend renvoie un array, mais on ne fait pas confiance aveugle.
        const fromDbResults = normalizeResults(resp?.results);
        if (cancelled || !fromDbResults.length) return;

        // 1. Toujours fusionner les données de la base dans le cache scanSession.byKey
        // pour ne jamais perdre ni écraser les résultats récents.
        for (const r of fromDbResults) {
          const p = (r.provider || '').trim();
          if (!p || !r.model) continue;
          const key = `${p}::${r.model}`;
          const existing = scanSession.byKey[key];
          scanSession.byKey[key] = {
            ...(existing || {}),
            ...r,
            provider: p,
          };
        }
        setStore({ byKey: { ...scanSession.byKey } });

        // SERVEUR = source primaire des capacites (vision/reasoning/tools) et des dates:
        // on les fusionne dans le store caps/capsLastChecked au montage pour
        // qu'elles reapparaissent apres un F5 (le localStorage reste une source
        // secondaire). cle "provider::model", identique au test-capabilities.
        const newCaps: Record<string, CapabilityResult> = {};
        const newLast: Record<string, number> = {};
        for (const r of fromDbResults) {
          const p = (r.provider || '').trim();
          if (!p || !r.model) continue;
          const key = `${p}::${r.model}`;

          const hasCapCheckDate = typeof r.last_cap_check === 'number' && r.last_cap_check > 0;
          const v = parseCapBoolean(r.vision_supported);
          const re = parseCapBoolean(r.reasoning_supported);
          const t = parseCapBoolean(r.tools_supported);

          if (hasCapCheckDate) {
            newLast[key] = r.last_cap_check!;
          } else if ((v !== undefined || re !== undefined || t !== undefined) && typeof r.last_checked === 'number' && r.last_checked > 0) {
            newLast[key] = r.last_checked;
          }

          const hasTestedCaps = hasCapCheckDate || v !== undefined || re !== undefined || t !== undefined;
          if (hasTestedCaps) {
            // NB: si un flag n'est pas explicite (undefined), on garde
            // undefined (indetermine / a verifier) et NON false. Forcer false
            // faisait afficher "TOUT KO" alors que le test avait donne OK mais
            // que le backend avait expire le TTL 24h (capabilities remises a
            // None). undefined != KO : l'UI affiche "a verifier", pas rouge.
            newCaps[key] = {
              vision_supported: v ?? (undefined as unknown as boolean),
              reasoning_supported: re ?? (undefined as unknown as boolean),
              tools_supported: t ?? (undefined as unknown as boolean),
              error: r.error ?? null,
            };
          }
        }
        if (Object.keys(newCaps).length) {
          setCaps((prev) => ({ ...(prev || {}), ...newCaps }));
        }
        if (Object.keys(newLast).length) {
          setCapsLastChecked((prev) => ({ ...(prev || {}), ...newLast }));
        }
        const items = Object.values(scanSession.byKey);
        if (!items.length) return;
        // Ne pas ecraser un scan EN COURS: on ne (re)construit le merged que si
        // aucun scan ne tourne. Sinon le poll en cours le fera avec ses metas.
        if (scanSession.scanning) return;
        const prev = scanSession.merged;
        const mergedNext = buildMergedFromByKey(
          prev ? prev.provider === ALL_PROVIDERS : true,
          prev && prev.provider !== ALL_PROVIDERS ? prev.provider : '',
          items.length,
          items.length,
          'done',
          true,
          null,
          prev?.raw || {},
        );
        setStore({ merged: mergedNext });
        setMerged(mergedNext);
      })
      .catch(() => { /* pas de DB peuplée -> on ignore */ });
    return () => { cancelled = true; };
  }, []);

  // Liste aplatie de TOUS les modeles du catalogue (mode "Tous les providers").
  const allModels = useMemo<FlatModel[]>(() => {
    if (!catalog) return [];
    const out: FlatModel[] = [];
    for (const [key, meta] of Object.entries(catalog.providers || {})) {
      // Skip provider if not enabled for scan (when config is not empty)
      if (Object.keys(providerScanConfig).length > 0 && !providerScanConfig[key]) {
        continue;
      }
      const models = meta.models || [];
      if (models.length === 0) continue;
      const display = meta.display_name || key;
      for (const m of models) {
        out.push({ provider: key, display, id: m.id, description: m.description });
      }
    }
    return out;
  }, [catalog, providerScanConfig]);

  // Liste des modeles affiches dans la checklist (selon le mode).
  // Chaque entree porte sa cle namespaced et (en mode all) son provider d'origine.
  const flatModels = useMemo(() => {
    if (provider === ALL_PROVIDERS) {
      return allModels.map((m) => ({
        key: `${m.provider}::${m.id}`,
        provider: m.provider,
        display: m.display,
        id: m.id,
        description: m.description,
      }));
    }
    const meta = provider ? catalog?.providers?.[provider] : undefined;
    let models = meta?.models ?? [];
    // If provider scan config is not empty, only include models if provider is enabled
    if (Object.keys(providerScanConfig).length > 0 && !providerScanConfig[provider]) {
      models = [];
    }
    return models.map((m: { id: string; description?: string }) => ({
      key: `${provider}::${m.id}`,
      provider,
      display: provider,
      id: m.id,
      description: m.description,
    }));
  }, [provider, catalog, allModels, providerScanConfig]);

  // Filtre la liste de cases a cocher (id + description + display, mode all).
  const visibleModels = useMemo(() => {
    return filterModels(flatModels, filter);
  }, [flatModels, filter]);

  // ---- When the provider changes (user action), clear previous scan view. ----
  // Garde le provider precedent : on ne vide la vue QUE si le provider a
  // REELLEMENT change (action utilisateur), pas au montage/restore/catalog-load.
  useEffect(() => {
    if (prevProviderRef.current === null) {
      // Premier rendu (montage/restore) : on ne vide PAS les resultats restores.
      prevProviderRef.current = provider;
      return;
    }
    // POINT 3c (2026-08-01, DEVELOPPEUR) : sur un navigateur SANS localStorage
    // (1re visite / profil neuf), l'etat initial du provider est '' puis le
    // chargement du catalogue pose la valeur par defaut (ALL_PROVIDERS). Cette
    // transition '' -> defaut n'est PAS une action utilisateur : la traiter
    // comme telle faisait un setMerged(null) qui effacait l'historique tout
    // juste restaure depuis scan_results.db (tableau vide au 1er affichage).
    if (prevProviderRef.current === '') {
      prevProviderRef.current = provider;
      return;
    }
    if (prevProviderRef.current !== provider) {
      prevProviderRef.current = provider;
      setChecked(new Set());
      stopPolling();
      setScanning(false);
      // BUGFIX (2026-08-06, DEVELOPPEUR) : NE JAMAIS vider l'historique sur un
      // simple changement de provider. Avant, setMerged(null) supprimait tout
      // l'affichage (compteurs + tableau) car tout le rendu est garde par
      // `merged &&`. On reconstruit desormais `merged` depuis scanSession.byKey
      // (historique persistant, alimente par la DB serveur + les scans),
      // de sorte que le tableau reste affiche et se contente de se mettre a
      // jour au fil du scan.
      const hist = Object.values(scanSession.byKey);
      const mergedNext: MergedScan | null = hist.length
        ? {
            provider,
            total: hist.length,
            done: hist.length,
            status: 'done',
            configured: true,
            error: null,
            results: hist,
            raw: {},
          }
        : null;
      // FIX 2026-08-22 (Manager) : persiste le merged reconstruit au changement
      // de provider (setStore ecrit aussi dans localStorage). Sans cela, un F5
      // ulterieur perdait l'affichage des compteurs/tableau car setMerged seul
      // ne serialisait pas l'etat dans le store module-level.
      setStore({ merged: mergedNext });
      setMerged(mergedNext);
    }
  }, [provider]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Clean up the poller on unmount (le module store conserve l'etat pour reprise).
  useEffect(() => () => stopPolling(), []);

  // Restauration au montage : on restitue TOUT l'etat depuis le store module
  // (survit au demontage de l'onglet). Un scan FINI a scanning=false -> on doit
  // TOUT DE MEME restorer merged/caps/checked/provider pour ne pas afficher un
  // ecran vide (BUG1). On reprend le poll SEULEMENT si un scan est encore vivant
  // cote serveur (source de verite), independamment du store/localStorage.
  useEffect(() => {
    if (scanSession.provider) setProvider(scanSession.provider);
    if (Array.isArray(scanSession.checked) && scanSession.checked.length) {
      setChecked(new Set(scanSession.checked));
    }
    if (scanSession.merged) setMerged({
      ...scanSession.merged,
      results: normalizeResults(scanSession.merged.results),
    });
    if (scanSession.caps) setCaps(scanSession.caps);
    if (Array.isArray(scanSession.scanChecked) && scanSession.scanChecked.length) {
      setScanChecked(new Set(scanSession.scanChecked));
    }
    if (Array.isArray(scanSession.testChecked) && scanSession.testChecked.length) {
      setTestChecked(new Set(scanSession.testChecked));
    }
    setFilter(scanSession.filter ?? '');
    setTableFilter(scanSession.tableFilter ?? '');
    setSortKey(scanSession.sortKey ?? null);
    setSortDir(scanSession.sortDir ?? 'desc');
    setOnlyOk(scanSession.onlyOk ?? false);
    // Reprise ROBUSTE : la source de verite est le backend. On interroge
    // /api/scan/active (scans encore running/cancelling cote serveur). Si au
    // moins un scan est vivant, on reprend le poll + on affiche EN COURS +
    // bouton Stop actif. Cela fonctionne meme si le store frontend ou
    // localStorage est dans un etat incoherent (scan en cours mais
    // scanning=false deplace). Sinon on garde merged affiche.
    getActiveScans()
      .then((res) => {
        const live = (res?.scans || []).filter(
          (s) => s && (s.status === 'running' || s.status === 'cancelling'),
        );
        // 2026-08-20 : on ne reprend QUE les scans dont le provider correspond
        // au batch courant (derive de lastBatchKeys), pour ne PAS cumuler d'autres
        // scans encore vivants cote serveur (ex: un ancien gros scan d'un autre
        // provider) dans le compteur de progression. Sinon "X/756" devenait
        // "X/2259/3015".
        const batchProviders = new Set(
          scanSession.lastBatchKeys.map((k) => k.split('::')[0]).filter(Boolean),
        );
        const liveBatch = batchProviders.size > 0
          ? live.filter((s) => batchProviders.has(s.provider))
          : live;
        if (liveBatch.length > 0) {
          const ids = liveBatch.map((s) => s.scan_id);
          const prov: Record<string, string> = {};
          for (const s of liveBatch) prov[s.scan_id] = s.provider;
          scanIdsRef.current = ids;
          scanProvRef.current = prov;
          setStore({ scanIds: ids, scanProv: prov, scans: {}, scanning: true });
          startPolling(ids, prov);
        } else if (scanSession.scanning && scanSession.scanIds?.length) {
          // Repli : pas de scan vivant cote serveur mais store disait en cours
          // -> on synchronise l'affichage (pas de poll fantome).
          setScanning(false);
          setStore({ scanning: false, scanIds: [], scanProv: {} });
        }
      })
      .catch(() => {
        // Erreur reseau : on se rabat sur le store existant.
        if (scanSession.scanning && scanSession.scanIds?.length) {
          resumePollingIfAlive(scanSession.scanIds, scanSession.scanProv);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Verifie cote serveur si les scan_id sont encore vivants (running/done)
  // avant de reprendre le poll. Si l'un est purgé (404 apres >10min) ou
  // inconnu, on NE relance PAS le poll : on garde scanSession.merged affiche
  // et on setScanning(false) pour eviter un ecran vide (BUG1).
  const resumePollingIfAlive = (scanIds: string[], scanProv: Record<string, string>) => {
    let anyAlive = false;
    Promise.all(
      scanIds.map((sid) =>
        getScanStatus(sid)
          .then((st) => {
            // running/done/cancelling -> encore vivant, on peut reprendre.
            if (st && st.status && st.status !== 'cancelled' && st.status !== 'error') {
              anyAlive = true;
            }
            return st;
          })
          .catch(() => null), // 404 ou inconnu : scan purgé -> ignoré
      ),
    ).then((statuses) => {
      const alive = statuses.filter((s): s is ScanStatus => s !== null);
      if (alive.length > 0 && anyAlive) {
        // Au moins un scan vivant : on reprend le poll normal (il mettra a
        // jour merged et s'arretera a la fin).
        startPolling(scanIds, scanProv);
      } else {
        // Tous purgés côté serveur : on garde le merged déjà affiché et on
        // marque le scan comme termine (pas d'écran vide, pas de poll fantôme).
        setScanning(false);
        setStore({ scanning: false, scanIds: [], scanProv: {} });
      }
    });
  };

  // ---- (A) Persistance onglet : on mirrore l'etat dans scanSession (module
  // store qui survit au demontage) a chaque changement pertinent ----
  useEffect(() => {
    setStore({ provider, checked: [...checked] });
  }, [provider, checked]);
  useEffect(() => { setStore({ merged }); }, [merged]);
  useEffect(() => { setStore({ scanning }); }, [scanning]);
  useEffect(() => { setStore({ caps }); }, [caps]);
  useEffect(() => { setStore({ filter }); }, [filter]);
  useEffect(() => { setStore({ tableFilter }); }, [tableFilter]);
  useEffect(() => { setStore({ sortKey }); }, [sortKey]);
  useEffect(() => { setStore({ sortDir }); }, [sortDir]);
  useEffect(() => { setStore({ onlyOk }); }, [onlyOk]);
  // Refs: ecrites explicitement (les refs ne declenchent pas de re-render, on
  // les synchronise aux bons endroits : handlePlay/handleStop + polling).

  const providersRaw = catalog ? Object.entries(catalog.providers) : [];
  let providers = providersRaw;
  if (Object.keys(providerScanConfig).length > 0) {
    // If scan provider config is explicitly set, filter to only those providers that are enabled
    providers = providersRaw.filter(([key]) => providerScanConfig[key] === true);
  }
  const selectedMeta = provider ? catalog?.providers?.[provider] : undefined;
  const isAll = provider === ALL_PROVIDERS;
  const isFreeformProvider = !isAll && !!selectedMeta?.freeform;
  const modelList = isAll ? allModels : (selectedMeta?.models ?? []);

  const toggleOne = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setChecked((prev) => {
      const allKeys = visibleModels.map((m) => m.key);
      // Exclure les modeles blacklistes du "Tout cocher" (par provider::model).
      const keys = allKeys.filter((k) => {
        const idx = k.indexOf('::');
        if (idx < 0) return true;
        const p = k.slice(0, idx);
        const mid = k.slice(idx + 2);
        const bl = blacklist[p] || [];
        return !bl.includes(mid);
      });
      // Si tous les NON-blacklistes visibles sont deja coches -> tout decocher;
      // sinon tout cocher (hors blacklistes).
      const allChecked = keys.length > 0 && keys.every((k) => prev.has(k));
      return allChecked ? new Set() : new Set(keys);
    });
  };

  const handlePlay = async () => {
    if (!provider || scanning) return;
    if (checked.size === 0) {
      setError('Cochez au moins un modele a tester.');
      return;
    }
    // Grouper les cles cochees par provider (split sur "::").
    const byProvider: Record<string, string[]> = {};
    for (const key of checked) {
      const idx = key.indexOf('::');
      if (idx < 0) continue;
      const p = key.slice(0, idx);
      const id = key.slice(idx + 2);
      (byProvider[p] ||= []).push(id);
    }
    const entries = Object.entries(byProvider).filter(([, ids]) => ids.length > 0);
    if (entries.length === 0) {
      setError('Cochez au moins un modele a tester.');
      return;
    }

    setScanning(true);
    setError(null);
    setMerged(null);
    // Re-scan : on CONSERVE les anciens resultats (byKey du store) pour que les
    // modeles re-scannes les ecrasent et les autres restent affiches (merge upsert).

    // Lancer un scan par provider, recuperer tous les scan_id.
    const scanIds: string[] = [];
    const scanProv: Record<string, string> = {};
    let launchError: string | null = null;
    for (const [p, ids] of entries) {
      try {
        const start = await startScan(p, ids);
        scanIds.push(start.scan_id);
        scanProv[start.scan_id] = p;
      } catch (e) {
        launchError = e instanceof Error ? e.message : String(e);
      }
    }
    if (scanIds.length === 0) {
      setError(launchError || 'Aucun scan n\'a pu demarrer.');
      setScanning(false);
      return;
    }
    scanIdsRef.current = scanIds;
    scanProvRef.current = scanProv;
    scansRef.current = {};
    // Miroir module store pour la reprise au remontage de l'onglet.
    // lastBatchKeys = clés "provider::model" du batch courant (pour le
    // compteur "Ce scan" OK/KO, distinct de l'historique persistant).
    const batchKeys: string[] = [];
    for (const [p, ids] of entries) {
      for (const id of ids) batchKeys.push(`${p}::${id}`);
    }
    scanSession.lastBatchKeys = batchKeys;
    setLastBatchKeysState(batchKeys);
    setScannedSession(new Set());
    setStore({ scanIds, scanProv, scans: {}, lastBatchKeys: batchKeys, scanning: true });
    persistScanSession();

    // Initialiser merged pour affichage immediat du compteur
    setMerged({
      provider: provider || ALL_PROVIDERS,
      total: batchKeys.length,
      done: 0,
      status: 'running',
      configured: true,
      error: null,
      results: Object.values(scanSession.byKey),
      raw: {},
    });

    // Lancer la boucle de poll (shared avec la restauration).
    startPolling(scanIds, scanProv);
  };

  // Demande "Exporter PDF": appelle /api/scan/pdf (optionnelement filtre sur le
  // provider courant) et declenche le telechargement du PDF cote navigateur.
  // On passe par un fetch + blob + <a download> pour controler le nom du fichier
  // et car l'endpoint repond en Content-Disposition attachment (window.open ne
  // pose pas de probleme, mais fetch->blob est plus fiable dans les iframes).
  const [pdfBusy, setPdfBusy] = useState(false);
  const exportPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      // Envoie TOUJOURS ok=1 : l'export PDF ne doit JAMAIS contenir les
      // modeles qui n'ont pas repondu (ok=false). Envoyer ok=0 exporterait
      // tout (debug), mais la valeur par defaut du produit = uniquement OK.
      const params = new URLSearchParams();
      if (provider && provider !== ALL_PROVIDERS) {
        params.set('provider', provider);
      }
      params.set('ok', '1');
      const qs = params.toString();
      const res = await fetch(`/api/scan/pdf?${qs}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || `Export PDF echoue (HTTP ${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scan-results-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfBusy(false);
    }
  };

  // DEMANDE 2: scan du STATUT d'UN seul modele (mini-scan a 1 modele).
  // Distinct du bouton "Test" (capacites) : ici on teste ok/ko/latence/tok/s
  // d'un seul modele via l'API de scan async (startScan + poll jusqu'a done).
  // N'ecrase PAS les cases cochees ni le reste du merged : on upsert juste ce
  // modele dans scanSession.byKey (comme le poll, mais pour un seul scan_id).
  const scanOneBusy = useRef<Record<string, boolean>>({});
  const [scanOneBusyState, setScanOneBusyState] = useState<Record<string, boolean>>({});
  const handleScanOne = async (providerArg: string, model: string, batchTotal?: number) => {
    const key = providerArg + '::' + model;
    if (scanOneBusy.current[key]) {
      setRowScanStopping((prev) => ({ ...prev, [key]: true }));
      scanOneStoppingRef.current[key] = true;
      return;
    }
    scanOneBusy.current[key] = true;
    scanOneStoppingRef.current[key] = false;
    setRowScanStopping((prev) => ({ ...prev, [key]: false }));
    setScanOneBusyState((prev) => ({ ...prev, [key]: true }));
    let sid: string | null = null;
    try {
      // 1. Lancement du scan de disponibilité + récupération asynchrone des spécifications du modèle
      const specsPromise = getModelSpecs(providerArg, model).catch((err) => {
        console.warn(`[ScanTab] Échec de la récupération des specs pour ${providerArg}::${model}:`, err);
        return {
          context_length: null,
          architecture: null,
          pricing: null,
          modalities: null,
          error: 'Erreur communication API',
          specs_display: 'Ctx: Non renseigné | API: Erreur de communication',
        };
      });

      const start = await startScan(providerArg, [model]);
      sid = start.scan_id;
      // Poll ce scan_id unique jusqu'a done. Le test de vie serveur peut
      // durer jusqu'a 180 s (_LIFE_TIMEOUT) : la garde cote UI DOIT etre plus
      // longue, sinon l'UI coupe avant la reponse du serveur.
      const deadline = Date.now() + 200_000;
      let st: ScanStatus | null = null;
      while (Date.now() < deadline) {
        if (stopScanRef.current || scanOneStoppingRef.current[key]) {
          if (sid) {
            try {
              await fetch(`/api/scan/cancel/${sid}`, { method: 'POST', credentials: 'same-origin' });
            } catch {}
          }
          break;
        }
        try {
          st = await getScanStatus(sid);
        } catch {
          st = null;
          break;
        }
        if (st && (st.status === 'done' || st.status === 'cancelled' || st.status === 'error')) {
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Attendre la résolution des spécifications réelles depuis l'API
      const specs = await specsPromise;

      if (st && st.results?.length) {
        const rawResults = normalizeResults(st.results);
        const enrichedResults = rawResults.map((r) => ({
          ...r,
          context_length: specs.context_length ?? r.context_length,
          parameter_count: (specs as any).parameter_count ?? r.parameter_count,
          specs_display: specs.specs_display ?? r.specs_display,
          specs_error: specs.error ?? r.specs_error,
        }));

        // Upsert du resultat unique (provider deja taggue sur chaque ligne).
        applyResultsUpsert(enrichedResults, false, providerArg);
        setStore({ byKey: scanSession.byKey });
        // Reconstruit merged depuis byKey pour refleter le nouveau resultat
        // sans perdre les autres (coherent avec le poll de handlePlay).
        const allResults = Object.values(scanSession.byKey);
        setMerged((prev) => {
          const t = batchTotal ?? (prev?.total || allResults.length);
          const d = batchTotal ? Math.min(t, (prev?.done ?? 0) + 1) : allResults.length;
          return {
            provider: prev?.provider ?? providerArg,
            total: t,
            done: d,
            status: batchTotal && d < t ? 'running' : 'done',
            configured: true,
            error: null,
            results: allResults,
            raw: prev?.raw || {},
          };
        });
        setScannedSession((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        setScanChecked((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      } else {
        // Même si le probe serveur a échoué / retourné vide, enrichir le store byKey avec les specs si l'entrée existe
        if (scanSession.byKey[key]) {
          scanSession.byKey[key] = {
            ...scanSession.byKey[key],
            context_length: specs.context_length ?? scanSession.byKey[key].context_length,
            parameter_count: (specs as any).parameter_count ?? scanSession.byKey[key].parameter_count,
            specs_display: specs.specs_display ?? scanSession.byKey[key].specs_display,
            specs_error: specs.error ?? scanSession.byKey[key].specs_error,
          };
          setStore({ byKey: scanSession.byKey });
        }
        setScanChecked((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      scanOneBusy.current[key] = false;
      scanOneStoppingRef.current[key] = false;
      setRowScanStopping((prev) => ({ ...prev, [key]: false }));
      setScanOneBusyState((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Bascule une cle dans l'etat de selection d'une colonne (scan_sel/test_sel).
  const toggleCheck = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
  ) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Lance le scan UNIQUEMENT des modeles coches dans scan_sel, STRICTEMENT
  // SEQUENTIEL (un modele a la fois, jamais Promise.all sur plusieurs).
  const handleScanSelected = async () => {
    if (scanning) return;
    const keys = [...scanChecked];
    if (keys.length === 0) return;
    stopScanRef.current = false;
    setScanning(true);
    setScannedSession(new Set());

    // Initialise merged avec le nombre de modeles coches a scanner
    const hist = Object.values(scanSession.byKey);
    setMerged({
      provider: provider || ALL_PROVIDERS,
      total: keys.length,
      done: 0,
      status: 'running',
      configured: true,
      error: null,
      results: hist,
      raw: {},
    });

    const batchKeys = [...keys];
    scanSession.lastBatchKeys = batchKeys;
    setLastBatchKeysState(batchKeys);
    setStore({ lastBatchKeys: batchKeys });
    persistScanSession();

    try {
      for (const key of keys) {
        if (stopScanRef.current) break;
        const idx = key.indexOf('::');
        if (idx < 0) continue;
        const p = key.slice(0, idx);
        const model = key.slice(idx + 2);
        if (scanOneBusy.current[key]) continue;
        try {
          await handleScanOne(p, model, keys.length);
        } catch {
          // une erreur sur un modele n'arrete pas la serie sequentielle.
        }
      }
    } finally {
      stopScanRef.current = false;
      setScanning(false);
      reloadBlacklist();
    }
  };

  // Boucle de poll unique (handlePlay + restauration au montage). Merge des
  // nouveaux resultats dans scanSession.byKey (upsert "provider::model").
  const startPolling = (scanIds: string[], scanProv: Record<string, string>) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        // Polling resiliente : on interroge CHAQUE scan_id independamment.
        // Un 404 (scan purgé/supprimé cote serveur après >10min) sur un seul
        // scan ne doit PAS tuer le poll des autres scans (mode multi). On
        // collecte les statuts vivants et on ne s'arrête QUE si TOUS les
        // scans sont purgés (plus rien à suivre) -> BUG1 : on garde merged.
        const settled = await Promise.all(
          scanIds.map(async (sid) => {
            try {
              return { sid, status: (await getScanStatus(sid)) as ScanStatus, purged: false };
            } catch (e) {
              const purged = e instanceof Error && /HTTP (404|410)/.test(e.message);
              return { sid, status: null, purged };
            }
          }),
        );
        const alive = settled.filter((x) => x.status !== null) as Array<{ sid: string; status: ScanStatus; purged: boolean }>;
        // BUGFIX (2026-08-20): "allPurged" ne doit etre vrai QUE si TOUS les
        // scan_id sont CONFIRMES purges (404/410). Une simple erreur reseau
        // transitoire (status=null, purged=false) ne doit PAS arreter le poll
        // ni faire revenir l'UI sur "Lancer le scan". Avant ce fix, un seul
        // echec reseau -> alive=[] -> allPurged=true -> scan "fini" apres 1
        // modele. On continue le poll tant qu'un scan n'est pas purge.
        const allConfirmedPurged = settled.length > 0 && settled.every((x) => x.purged);
        if (allConfirmedPurged) {
          // Tous les scan_id sont purgés côté serveur : on garde merged affiché
          // et on arrête le poll (pas d'écran vide, pas de poll fantôme).
          stopPolling();
          setScanning(false);
          setStore({ scanning: false, scanIds: [], scanProv: {} });
          return;
        }
        // Au moins un scan vivant : on merge ses résultats (les scans purgés
        // sont ignorés, leurs anciens résultats restent dans byKey).
        const statuses: ScanStatus[] = alive.map((x) => x.status);
        const raw: Record<string, ScanStatus> = {};
        const tagProvider = scanIds.length > 1; // taggue seulement en multi
        let total = 0;
        let done = 0;
        let configured = true;
        let firstError: string | null = null;
        const results: ScanModelResult[] = [];
        let allFinished = true;
        for (const st of statuses) {
          raw[st.scan_id] = st;
          total += st.total;
          done += st.done;
          if (!st.configured) configured = false;
          if (st.error && firstError === null) firstError = st.error;
          for (const r of normalizeResults(st.results)) {
            // Copie pour ne pas muter l'objet du backend; taggue le provider d'origine.
            results.push(tagProvider ? { ...r, provider: scanProv[st.scan_id] } : r);
          }
          if (st.status === 'running' || st.status === 'cancelling') allFinished = false;
        }
        // (C) merge upsert : les modeles de CE scan ecrasent les anciens, les
        // autres (scans precedents / autres providers) sont conserves.
        applyResultsUpsert(results, tagProvider, statuses[0]?.provider ?? '');
        setStore({ byKey: scanSession.byKey });
        const merged = buildMergedFromByKey(
          tagProvider,
          statuses[0]?.provider ?? '',
          total,
          done,
          allFinished ? 'done' : 'running',
          configured,
          firstError,
          raw,
        );
        setMerged(merged);
        if (allFinished) {
          stopPolling();
          setScanning(false);
          // Les modeles KO detectes ont ete auto-blacklistes cote serveur:
          // on recharge la blacklist pour refleter l'etat dans la checklist.
          reloadBlacklist();
        }
      } catch (e) {
        // Erreur inattendue hors 404 (ex: JSON invalide, reseau). On garde
        // merged affiche et on retente au prochain tick (pas d'ecran vide).
        void e;
      }
    }, 1500);
  };

  const handleStop = async () => {
    stopScanRef.current = true;
    stopPolling();
    try {
      await fetch('/api/scan/cancel-all', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // best effort cancel
    }
    setScanning(false);
    scanIdsRef.current = [];
    scanProvRef.current = {};
    scansRef.current = {};
    setStore({ scanIds: [], scanProv: {}, scans: {}, lastBatchKeys: [], scanning: false });
    setError(null);
    // relancer le polling catalogue pour rafraîchir l'état live
    getModelCatalog().then(setCatalog).catch(() => {});
  };

  // v1.17.60 - merge partiel factorise (utilise par la serie ET par la ligne).
  // 'all' remplace tout; sinon on ne met a jour QUE la capacite visee et on
  // laisse les autres a leur valeur reelle (undefined = jamais teste = gris).
  const mergeCapResult = (
    key: string,
    kind: 'all' | 'vision' | 'reasoning' | 'tools',
    res: CapabilityResult,
  ) => {
    setCaps((prev) => {
      const existing = prev[key];
      if (kind === 'all') return { ...prev, [key]: res };
      return {
        ...prev,
        [key]: {
          vision_supported: kind === 'vision' ? !!res.vision_supported : (existing?.vision_supported ?? undefined),
          reasoning_supported: kind === 'reasoning' ? !!res.reasoning_supported : (existing?.reasoning_supported ?? undefined),
          tools_supported: kind === 'tools' ? !!res.tools_supported : (existing?.tools_supported ?? undefined),
          error: existing?.error ?? res.error ?? null,
        } as CapabilityResult,
      };
    });
    // vFIX (2026-08-13) : marque ce modele comme teste DANS CETTE SESSION.
    setTestedSession((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const mergeCapError = (
    key: string,
    kind: 'all' | 'vision' | 'reasoning' | 'tools',
    msg: string,
  ) => {
    setCaps((prev) => {
      const existing = prev[key];
      const base: CapabilityResult = existing ?? {
        vision_supported: undefined as unknown as boolean,
        reasoning_supported: undefined as unknown as boolean,
        tools_supported: undefined as unknown as boolean,
        error: null,
      };
      const updated: CapabilityResult = { ...base, error: msg };
      if (kind === 'vision') updated.vision_supported = false;
      else if (kind === 'reasoning') updated.reasoning_supported = false;
      else if (kind === 'tools') updated.tools_supported = false;
      return { ...prev, [key]: updated };
    });
  };

  // Bouton de LIGNE: 1er clic lance, 2e clic pendant l'execution demande
  // l'arret propre (le test deja parti finit et son resultat est enregistre;
  // rien de partiel n'est ecrit). Etat suivi PAR MODELE ET PAR CAPACITE.
  const handleRowTest = (providerArg: string, model: string, cap: 'all' | 'vision' | 'reasoning' | 'tools') => {
    const cellKey = providerArg + '::' + model + '::' + cap;
    if (capsBusy[cellKey]) {
      // Deja en cours -> re-clic = arret propre demande.
      setRowStopping((prev) => ({ ...prev, [cellKey]: true }));
      return;
    }
    void handleTest(providerArg, model, cap);
  };

  // SOURCE UNIQUE DE VERITE (2026-08-06). Apres un test de capacites, on
  // RELIT la ligne en base et on ecrase la copie memoire du tableau. Ainsi
  // l'onglet SCAN ne peut plus afficher indefiniment des mesures en memoire
  // divergentes de scan_results.db (c'etait le symptome du bug : SCAN 80/A en
  // memoire vs modale 59/C lue en base). Desormais les deux lisent la meme
  // ligne, et le backend ne touche plus aux mesures lors d'un test de caps.
  const resyncRowFromDb = async (providerArg: string, model: string) => {
    try {
      const resp = await getScanResults(providerArg);
      const rows = normalizeResults(resp?.results);
      const row = rows.find((r) => r.model === model);
      if (!row) return;
      const key = `${row.provider || providerArg}::${row.model}`;
      scanSession.byKey[key] = { ...row, provider: row.provider || providerArg };
      setStore({ byKey: { ...scanSession.byKey } });
      // BUGFIX 2026-08-12 : re-sync des capacites + horodatage depuis la BASE
      // (source primaire), pas uniquement depuis la memoire locale. Sans cela
      // la colonne 'Verif. capacites' pouvait afficher '—' apres un test,
      // meme si les capacites etaient remplies.
      const hasCapCheckDate = typeof row.last_cap_check === 'number' && row.last_cap_check > 0;
      const v = parseCapBoolean(row.vision_supported);
      const re = parseCapBoolean(row.reasoning_supported);
      const t = parseCapBoolean(row.tools_supported);
      const hasTestedCaps = hasCapCheckDate || v !== undefined || re !== undefined || t !== undefined;

      if (hasTestedCaps) {
        setCaps((prev) => ({
          ...(prev || {}),
          [key]: {
            vision_supported: v !== undefined ? v : (hasCapCheckDate ? false : (undefined as unknown as boolean)),
            reasoning_supported: re !== undefined ? re : (hasCapCheckDate ? false : (undefined as unknown as boolean)),
            tools_supported: t !== undefined ? t : (hasCapCheckDate ? false : (undefined as unknown as boolean)),
            error: row.error ?? null,
          },
        }));
      }
      if (typeof row.last_cap_check === 'number') {
        setCapsLastChecked((prev) => ({ ...(prev || {}), [key]: row.last_cap_check as number }));
      }
      persistScanSession();
    } catch {
      // relecture best-effort : ne jamais casser le test de capacites.
    }
  };

  const handleTest = async (providerArg: string, model: string, cap: 'all' | 'vision' | 'reasoning' | 'tools' = 'all') => {
    const key = providerArg + '::' + model;
    const cellKey = key + '::' + cap;
    setCapsBusy((prev) => ({ ...prev, [key]: true, [cellKey]: true }));
    try {
      const res = await testCapabilities(providerArg, model, cap);
      // Resultat COMPLET du test parti: on l'enregistre normalement meme si un
      // arret a ete demande entre-temps (arret propre, jamais de partiel).
      mergeCapResult(key, cap, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mergeCapError(key, cap, msg);
    } finally {
      setCapsBusy((prev) => ({ ...prev, [key]: false, [cellKey]: false }));
      setRowStopping((prev) => ({ ...prev, [cellKey]: false }));
      setCapsLastChecked((prev) => ({ ...prev, [key]: Math.floor(Date.now() / 1000) }));
      setTestChecked((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      void resyncRowFromDb(providerArg, model);
    }
  };

  // Lance la sonde de capacite sur tous les modeles actuellement affiches
  // (displayedModels), pour un type de capacite donne. kind='all' stocke le
  // resultat complet; 'vision'/'reasoning'/'tools' ne met a jour QUE la
  // capacite visee (merge avec le resultat deja present pour les autres).
  const handleTestAll = async (kind: 'all' | 'vision' | 'reasoning' | 'tools') => {
    // v1.17.60 - BASCULE marche/arret par COLONNE.
    // Si cette colonne tourne deja: 2e clic = arret propre (on vide la file,
    // on laisse finir le test deja emis). Les autres colonnes ne sont PAS
    // touchees (etat par colonne, pas de flag global).
    if (colState[kind] === 'running') {
      stopColsRef.current[kind] = true;
      setColState((prev) => ({ ...prev, [kind]: 'stopping' }));
      return;
    }
    if (colState[kind] === 'stopping') return; // arret deja en cours
    if (testChecked.size === 0) return;

    stopColsRef.current[kind] = false;
    setColState((prev) => ({ ...prev, [kind]: 'running' }));
    setTestingAll(kind);
    // vFIX (2026-08-13) : on reinitialise le compteur de session.
    setTestedSession(new Set());
    // FIX COMPTEUR : fige le total AU LANCEMENT (nombre de modeles coches
    // avant tout decochage) => le compteur reste X / total figé, pas X / restant.
    setTestTotal(testChecked.size);
    // File = modeles coches dans test_sel (recuperes via le store byKey).
    const queue: ScanModelResult[] = [...testChecked]
      .map((key) => scanSession.byKey[key])
      .filter((m): m is ScanModelResult => Boolean(m));
    try {
      for (const m of queue) {
        // ARRET PROPRE: on teste le drapeau AVANT d'emettre la requete
        // suivante => aucune nouvelle requete reseau n'est envoyee.
        if (stopColsRef.current[kind]) break;
        const p = m.provider || provider;
        const key = p + '::' + m.model;
        const cellKey = key + '::' + kind;
        setCapsBusy((prev) => ({ ...prev, [key]: true, [cellKey]: true }));
        try {
          const res = await testCapabilities(p, m.model, kind);
          mergeCapResult(key, kind, res);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          mergeCapError(key, kind, msg);
        } finally {
          setCapsBusy((prev) => ({ ...prev, [key]: false, [cellKey]: false }));
          setCapsLastChecked((prev) => ({ ...prev, [key]: Math.floor(Date.now() / 1000) }));
          setTestChecked((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          void resyncRowFromDb(p, m.model);
        }
      }
    } finally {
      stopColsRef.current[kind] = false;
      setColState((prev) => {
        const next = { ...prev };
        delete next[kind];
        return next;
      });
      setTestingAll((cur) => (cur === kind ? null : cur));
    }
  };

  // Libelle/classe d'un bouton d'en-tete selon l'etat de SA colonne.
  const headerBtn = (kind: 'all' | 'vision' | 'reasoning' | 'tools', label: string) => {
    const st = colState[kind];
    const text = st === 'stopping' ? 'Arret…' : st === 'running' ? 'Stop' : label;
    const cls = st === 'stopping'
      ? 'bg-amber-700 text-white cursor-wait'
      : st === 'running'
        ? 'bg-red-600 text-white hover:bg-red-500'
        : 'bg-stone-800 text-stone-200 hover:bg-stone-700';
    return { text, cls, disabled: st === 'stopping', running: st === 'running' };
  };

  // Derive counts from the live status (partial results welcome).
  // FIX RACINE (2026-08-13, Bob): merged.results peut etre un objet (dict)
  // suite a une restauration localStorage d'une ancienne version. On
  // normalise dict -> array via Object.values (historique conserve),
  // avec garde Array.isArray pour la robustesse. Plus aucun .filter sur dict.
  const resultModels: ScanModelResult[] = normalizeResults(merged?.results);
  // Applique le filtre "uniquement les modeles OK" / "uniquement les modeles KO"
  // si actif (AVANT le tri). KO = life_state 'rouge' OU dans la blacklist.
  // Les deux filtres sont combinables (ET). Symetrique au bouton OK existant.
  const isModelKO = (m: ScanModelResult): boolean =>
    lifeStateOf(m) === 'rouge' ||
    (blacklist[m.provider || provider] || []).includes(m.model);
  let okFilteredModels = resultModels;
  if (onlyOk) okFilteredModels = okFilteredModels.filter((m) => m.ok === true);
  if (onlyKo) okFilteredModels = okFilteredModels.filter((m) => isModelKO(m));
  // v1.17.64 - FILTRE TEXTE DU TABLEAU (affichage uniquement).
  // Remplace la recherche AND maison par filterModels (Inclusion/Exclusion,
  // insensible casse, sur nom + provider) comme les autres zones de l'UI.
  // Aucune mutation du store.
  const filteredModels = tableFilter.trim()
    ? filterModels(
        okFilteredModels.map((m) => ({ ...m, id: m.model, provider: m.provider })),
        tableFilter,
      )
    : okFilteredModels;
  // v1.17.141 - Filtres capacites (Vision/Raison/Tools) sur l'HISTORIQUE des resultats.
  // Seules les lignes dont les capacites matchent (AND: tous les coches) sont conservees.
  const capFilteredModels = (capFilter.vision || capFilter.reasoning || capFilter.tools)
    ? filteredModels.filter((m) => {
        const srKey = `${m.provider || provider}::${m.model}`;
        const cap = caps[srKey];
        const vVis = cap?.vision_supported ?? m.vision_supported;
        const vReas = cap?.reasoning_supported ?? m.reasoning_supported;
        const vTool = cap?.tools_supported ?? m.tools_supported;
        if (vVis === undefined && vReas === undefined && vTool === undefined) return false;
        return (!capFilter.vision || !!vVis) &&
               (!capFilter.reasoning || !!vReas) &&
               (!capFilter.tools || !!vTool);
      })
    : filteredModels;
  // Trie une copie apres filtrage. Les valeurs nulles vont a la fin.
  const displayedModels = (() => {
    if (!sortKey) return capFilteredModels;
    const getValue = (m: ScanModelResult): number | string | null => {
      if (sortKey === 'provider') return (m.provider || provider || '').toLowerCase();
      if (sortKey === 'model') return m.model ?? '';
      if (sortKey === 'latency') return typeof m.latency_ms === 'number' ? m.latency_ms : null;
      // Le score suit EXACTEMENT ce qui est affiche : une ligne non mesuree
      // affiche '—' donc n'a pas de score triable (null -> reléguée en fin).
      if (sortKey === 'score') {
        if (isUnmeasured(m)) return null;
        return getModelScore(m, caps[(m.provider || provider) + '::' + m.model]).score;
      }
      if (sortKey === 'last_checked') return typeof m.last_checked === 'number' ? m.last_checked : null;
      if (sortKey === 'caps_checked') {
        const key = (m.provider || provider) + '::' + m.model;
        const v = capsLastChecked[key] ?? m.last_cap_check ?? ((caps[key] || m.vision_supported !== undefined || m.reasoning_supported !== undefined || m.tools_supported !== undefined) ? m.last_checked : null);
        return typeof v === 'number' && v > 0 ? v : null;
      }
      return typeof m.tokens_per_sec === 'number' ? m.tokens_per_sec : null;
    };
    const sorted = [...capFilteredModels].sort((a, b) => {
      const va = getValue(a);
      const vb = getValue(b);
      // Les valeurs nulles (manquantes) vont toujours a la fin.
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      let cmp = 0;
      if (typeof va === 'string' && typeof vb === 'string') cmp = va.localeCompare(vb);
      else cmp = (va as number) - (vb as number);
      const primary = sortDir === 'asc' ? cmp : -cmp;
      if (primary !== 0) return primary;
      // Tri secondaire : a l'interieur d'un meme provider, les modeles
      // restent tries par nom (toujours ascendant, lisible).
      if (sortKey === 'provider') {
        return (a.model ?? '').localeCompare(b.model ?? '');
      }
      return 0;
    });
    return sorted;
  })();
  // Compteurs a 3 etats (vert / orange / rouge). okCount reste le nombre de
  // VERTS stricts pour ne pas changer le sens de l'affichage existant.
  const okCount = resultModels.filter((m) => lifeStateOf(m) === 'vert').length;
  const orangeCount = resultModels.filter((m) => lifeStateOf(m) === 'orange').length;
  const koCount = resultModels.filter((m) => lifeStateOf(m) === 'rouge').length;
  // 2026-08-12 : compteur TIMEOUT (life_state 'time') — ajoute sans casser
  // ok/orange/ko existants.
  const timeCount = resultModels.filter((m) => lifeStateOf(m) === 'time').length;
  // Compteur du filtre KO = rouge OU blackliste (symetrique au filtre OK).
  const koFilteredCount = resultModels.filter((m) => isModelKO(m)).length;
  // Compteur "Ce scan" - OK/KO du batch courant SEULEMENT (clés lancees au
  // dernier handlePlay), distinct de l'historique persistant dans byKey.
  // On lit le statut de chaque cle dans scanSession.byKey (upserté par le poll).
  const batchKeySet = new Set(scanSession.lastBatchKeys);
  const batchResults = resultModels.filter((m) =>
    batchKeySet.has(`${m.provider || ''}::${m.model}`),
  );
  const batchTotal = batchResults.length;
  const batchOkCount = batchResults.filter((m) => lifeStateOf(m) === 'vert').length;
  const batchOrangeCount = batchResults.filter((m) => lifeStateOf(m) === 'orange').length;
  const batchKoCount = batchResults.filter((m) => lifeStateOf(m) === 'rouge').length;
  const allDone = merged?.status === 'done' || merged?.status === 'cancelled'
    || merged?.status === 'error';

  // v1.17.77 - COMPTEURS LIVE (barre de filtre du tableau et bandeau de scan).
  // A) SCAN : modeles du scan en cours (handlePlay ou handleScanSelected)
  const scanCheckedCount = scanChecked.size;
  const scanBatchKeys = scanSession.lastBatchKeys;
  // BUGFIX (2026-08-20): le denominateur du compteur de progression est le
  // batch lance (lastBatchKeys, ex: 756), RESTAURE depuis localStorage apres
  // F5. Le "done" reflete le scan backend EN COURS (merged.done), pas
  // l'historique fusionne depuis scan_results.db (qui ferait afficher
  // "201/756" des le lancement si 201 modeles du batch etaient deja en DB).
  // Le poll ne suit plus que les scans du batch (filtres par provider), donc
  // merged.done = avancement reel de CE scan.
  const scanBatchTotal = scanBatchKeys.length > 0 ? scanBatchKeys.length : 0;
  const scanBatchDone = scanBatchKeys.length > 0
    ? (merged?.done ?? 0)
    : (merged?.done ?? 0);

  // Cle du modele ACTUELLEMENT en cours de scan (pour le badge "EN COURS" dans la checklist et le tableau).
  const activeScanKey = scanning && scanBatchKeys.length > 0
    ? scanBatchKeys[Math.max(0, Math.min(scanBatchDone, scanBatchKeys.length - 1))]
    : null;
  // B) CAPACITES : modeles coches pour les tests + progression des tests.
  const testCheckedCount = testChecked.size;
  const capsActive = testingAll !== null
    || Object.keys(colState).some((k) => colState[k] === 'running');
  // X = nombre de modeles TESTES DANS CETTE SESSION (present dans
  // testedSession). On compte testedSession.size directement (et non
  // l'intersection avec testChecked) car les modeles se decochent apres
  // leur test -> l'ancienne intersection donnait toujours 0. Le total Y
  // est figé dans testTotal (voir handleTestAll).
  const capX = testedSession.size;

  // Indicateur visuel de tri (fleche) + style de l'en-tete actif.
  const sortArrow = (col: 'provider' | 'model' | 'latency' | 'tps' | 'score' | 'last_checked' | 'caps_checked') =>
    sortKey === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const headerClass = (col: 'provider' | 'model' | 'latency' | 'tps' | 'score' | 'last_checked' | 'caps_checked') =>
    `cursor-pointer select-none hover:text-stone-300 transition-colors whitespace-nowrap ${
      sortKey === col ? 'text-orange-400' : ''
    }`;

  // ---- v1.17.63 : TABLEAU DATA-DRIVEN (14 colonnes) ----------------------
  // Une seule source de verite par colonne : largeur (colgroup), en-tete (th)
  // et rendu de cellule (td). Le reordonnancement permute ce tableau, donc
  // colgroup / th / td bougent FORCEMENT ENSEMBLE : l'alignement 14/14/14 est
  // structurellement garanti (plus de JSX duplique).
  interface ColDef {
    id: ColId;
    width: React.CSSProperties;
    thClass: string;
    tdClass: string;
    header: React.ReactNode;
    cell: (m: ScanModelResult, capKey: string) => React.ReactNode;
  }

  // Bouton d'en-tete de tri (le drag ne doit pas declencher le tri).
  const sortHeader = (col: 'provider' | 'model' | 'latency' | 'tps' | 'score' | 'last_checked' | 'caps_checked', label: string, title?: string) => (
    <button
      type="button"
      onClick={() => { if (!draggingRef.current) toggleSort(col); }}
      className="inline-flex items-center justify-center gap-1 whitespace-nowrap hover:text-stone-300"
      title={title}
    >
      {label}{sortArrow(col)}
    </button>
  );

  // Bouton d'en-tete d'action (Test/Vision/Raison./Tools) : agit sur les
  // lignes AFFICHEES (donc filtrees). Ignore un clic issu d'un drag.
  const actionHeader = (kind: 'all' | 'vision' | 'reasoning' | 'tools', label: string) => {
    const b = headerBtn(kind, label);
    return (
      <button
        type="button"
        onClick={() => { if (!draggingRef.current) handleTestAll(kind); }}
        disabled={b.disabled}
        title={b.running
          ? 'Cliquer pour ARRETER la serie (arret propre : le test en cours finit, la file est videe)'
          : `Lancer le test sur les ${testChecked.size} modele(s) COCHE(S) dans la colonne test_sel`}
        className={`inline-flex items-center gap-1 justify-center px-2 py-1 rounded-lg text-[11px] font-medium disabled:cursor-wait ${b.cls}`}
      >
        {b.running ? <Square className="w-3 h-3" /> : b.disabled ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
        {b.text}
      </button>
    );
  };

  const COL_DEFS: Record<ColId, ColDef> = {
    provider: {
      id: 'provider',
      width: { width: '120px' },
      thClass: `px-5 py-3 ${headerClass('provider')}`,
      tdClass: 'px-5 py-3',
      header: sortHeader('provider', 'Provider'),
      cell: (m) => {
        const providerShown = (m.provider || provider || '').trim() || '?';
        const badgeColor = (m.provider || provider || '').trim()
          ? 'bg-orange-500/10 text-orange-300 border-orange-500/30'
          : 'bg-stone-800 text-stone-400 border-stone-700';
        return (
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] uppercase tracking-widest font-semibold border align-middle ${badgeColor}`}>
            {providerShown}
          </span>
        );
      },
    },
    model: {
      id: 'model',
      width: { minWidth: '280px' },
      thClass: `px-5 py-3 ${headerClass('model')}`,
      tdClass: 'px-5 py-3 font-mono text-stone-300 break-all text-left',
      header: sortHeader('model', 'Modele'),
      cell: (m) => {
        const specsText = m.specs_display || getHermesRegistryModel(m.provider || provider, m.model)?.specs_display;
        const isError = m.specs_error && !specsText?.includes('Hermes Local');

        return (
          <div className="flex flex-col items-start gap-1">
            <span className="font-semibold text-stone-100 text-[13px]">{m.model}</span>
            {specsText && (
              <span
                className={`text-[11px] font-mono tracking-tight leading-tight select-all ${
                  isError
                    ? 'text-stone-500/70 italic'
                    : 'text-amber-400/90 font-medium'
                }`}
                title={specsText}
              >
                {specsText}
              </span>
            )}
          </div>
        );
      },
    },
    scan: {
      id: 'scan',
      width: { width: '96px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: (
        <button
          type="button"
          onClick={() => { if (!draggingRef.current) scanning ? handleStop() : handleScanSelected(); }}
          title={
            scanning
              ? 'Scan en cours… (cliquer pour arreter)'
              : `Lancer le scan des ${scanChecked.size} modele(s) COCHE(S) dans la colonne scan_sel (sequentiel)`
          }
          className={
            scanning
              ? 'inline-flex items-center gap-1 justify-center px-2 py-1 rounded-lg text-[11px] font-medium bg-red-600 text-white hover:bg-red-500'
              : 'inline-flex items-center gap-1 justify-center px-2 py-1 rounded-lg text-[11px] font-medium bg-stone-800 text-stone-200 hover:bg-stone-700'
          }
        >
          {scanning ? <Square className="w-3 h-3" /> : <Scan className="w-3 h-3" />}
          {scanning ? 'Stop' : 'Scan'}
        </button>
      ),
      cell: (m) => {
        const p = m.provider || provider;
        const sKey = `${p}::${m.model}`;
        const busy = !!scanOneBusyState[sKey];
        const stopping = !!rowScanStopping[sKey];
        const txt = stopping ? 'Arret…' : busy ? 'Stop' : 'Scan';
        const cls = stopping
          ? 'bg-amber-700 text-white cursor-wait'
          : busy
            ? 'bg-red-600 text-white hover:bg-red-500'
            : 'bg-stone-800 text-stone-200 hover:bg-stone-700';
        return (
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (scanning || busy) return;
                const next = { ...scanSession.byKey };
                delete next[sKey];
                clearScanResults(p, m.model).catch(() => {});
                scanSession.byKey = next;
                setStore({ byKey: next });
                setMerged((prev) => {
                  if (!prev) return null;
                  const items = Object.values(scanSession.byKey);
                  return buildMergedFromByKey(
                    prev.provider === ALL_PROVIDERS,
                    provider,
                    items.length,
                    items.filter((r) => r.ok).length + items.filter((r) => !r.ok).length,
                    prev.status,
                    prev.configured,
                    prev.error,
                    prev.raw || {},
                  );
                });
              }}
              title="Effacer le resultat de ce modele"
              className="inline-flex items-center justify-center p-2 rounded-lg text-[11px] font-medium text-stone-400 hover:text-red-300 hover:bg-stone-800 border border-stone-800 disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleScanOne(p, m.model)}
              disabled={stopping}
              title={busy ? 'Re-cliquer pour annuler le scan de ce modele' : 'Scan du statut (ok/ko/latence/tok/s) de ce modele seul'}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium disabled:cursor-wait ${cls}`}
            >
              {busy && !stopping ? <Square className="w-3 h-3" /> : null}
              {stopping ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {!busy && !stopping ? <Scan className="w-3 h-3" /> : null}
              {txt}
            </button>
          </div>
        );
      },
    },
    scan_sel: {
      id: 'scan_sel',
      width: { width: '44px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: (
        <button
          type="button"
          onClick={() => {
            const next = new Set<string>();
            if (scanChecked.size !== displayedModels.length) {
              for (const m of displayedModels) {
                next.add((m.provider || provider) + '::' + m.model);
              }
            }
            setScanChecked(next);
          }}
          title="Cocher / decocher toutes les lignes VISIBLES dans scan_sel"
          className="cursor-pointer inline-flex items-center justify-center text-orange-300 hover:text-orange-200"
        >
          {scanChecked.size === displayedModels.length && displayedModels.length > 0
            ? <CheckSquare className="w-4 h-4" />
            : <Square className="w-4 h-4" />}
        </button>
      ),
      cell: (m) => {
        const key = (m.provider || provider) + '::' + m.model;
        const isOn = scanChecked.has(key);
        return (
          <button
            type="button"
            onClick={() => toggleCheck(setScanChecked, key)}
            title={isOn ? 'Retirer de la selection scan' : 'Ajouter a la selection scan'}
            className="cursor-pointer inline-flex items-center justify-center text-orange-300 hover:text-orange-200"
          >
            {isOn ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
          </button>
        );
      },
    },
    last_checked: {
      id: 'last_checked',
      width: { width: '225px' },
      thClass: `px-3 py-3 ${headerClass('last_checked')}`,
      tdClass: 'px-3 py-3 text-stone-400 text-xs whitespace-nowrap',
      header: sortHeader('last_checked', 'Derniere verification'),
      cell: (m) => (typeof m.last_checked === 'number'
        ? new Date(m.last_checked * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
        : '—'),
    },
    status: {
      id: 'status',
      width: { width: '175px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3 whitespace-nowrap',
      header: 'Statut',
      // 3 etats. La raison lisible ET le texte reellement recu sont exposes
      // au survol (title) pour TOUS les etats, plus seulement les rouges.
      cell: (m) => {
        const st = lifeStateOf(m);
        const answer = (m as { life_answer?: string }).life_answer || '';
        const tip = [m.reason, answer && `reponse: ${answer}`]
          .filter(Boolean).join(' — ') || LIFE_LABEL[st];
        return (
          <div title={tip} className="cursor-help flex flex-col items-center justify-center">
            {st === 'vert' && (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" /> VERT (OK)
              </span>
            )}
            {st === 'orange' && (
              <span className="inline-flex items-center gap-1 text-amber-400">
                <AlertTriangle className="w-4 h-4" /> ORANGE
              </span>
            )}
            {st === 'rouge' && (
              <span className="inline-flex items-center gap-1 text-red-400">
                <XCircle className="w-4 h-4" /> ROUGE (KO)
              </span>
            )}
            {st === 'time' && (
              <span className="inline-flex items-center gap-1 text-orange-300 bg-orange-900/30 border border-orange-700 rounded-lg px-2 py-0.5">
                <AlertTriangle className="w-4 h-4" /> TIMEOUT
              </span>
            )}
            {(m.reason || answer) && (
              <div className="text-stone-500 text-[10px] mt-0.5 max-w-[150px] truncate text-center">
                {m.reason}{answer ? ` — ${answer}` : ''}
              </div>
            )}
          </div>
        );
      },
    },
    latency: {
      id: 'latency',
      width: { width: '145px' },
      thClass: `px-3 py-3 ${headerClass('latency')}`,
      tdClass: 'px-3 py-3 text-stone-400 text-xs whitespace-nowrap',
      header: sortHeader('latency', 'Temps'),
      cell: (m) => (typeof m.latency_ms === 'number' ? `${m.latency_ms.toFixed(1)} ms` : '—'),
    },
    tps: {
      id: 'tps',
      width: { width: '145px' },
      thClass: `px-3 py-3 ${headerClass('tps')}`,
      tdClass: 'px-3 py-3 text-stone-400 text-xs whitespace-nowrap',
      header: sortHeader('tps', 'Tok/s'),
      cell: (m) => (typeof m.tokens_per_sec === 'number' ? m.tokens_per_sec.toFixed(1) : '—'),
    },
    score: {
      id: 'score',
      width: { width: '92px' },
      thClass: `px-3 py-3 ${headerClass('score')}`,
      tdClass: 'px-3 py-3 whitespace-nowrap',
      header: sortHeader('score', 'Score', 'Score global 0-100 (dispo 40 / latence 30 / debit 15 / capacites 15), normalise sur les seules composantes reellement mesurees'),
      cell: (m, capKey) => <ScoreBadge score={getModelScore(m, caps[capKey])} unmeasured={isUnmeasured(m)} />,
    },
    bl: {
      id: 'bl',
      width: { width: '68px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: (
        <span
          className="inline-flex items-center gap-1"
          title="Blacklist : masquer les modeles trop lents ou sans capacites suffisantes"
        >
          <Ban className="w-3 h-3" /> BL
        </span>
      ),
      cell: (m) => {
        const p = m.provider || provider;
        const key = `${p}::${m.model}`;
        const isBL = (blacklist[p] || []).includes(m.model);
        const busy = !!blRowBusy[key];
        return (
          <div className="flex items-center justify-center">
            <button
              type="button"
              data-testid={`scan-bl-toggle-${key}`}
              data-bl={isBL ? '1' : '0'}
              disabled={busy}
              title={
                isBL
                  ? `Modele BLACKLISTE — cliquer pour le RETIRER de la blacklist (${p} / ${m.model})`
                  : `Blacklister ce modele (trop lent ou capacites insuffisantes) — il sera exclu des scans et du choix de modele (${p} / ${m.model})`
              }
              onClick={() => {
                if (blRowBusy[key]) return;
                setBlRowBusy((prev) => ({ ...prev, [key]: true }));
                toggleBlacklist(p, m.model)
                  // On NE se contente PAS de l'etat local : on relit la
                  // blacklist reelle du serveur apres le toggle.
                  .then(() => getBlacklist())
                  .then((b) => setBlacklist(b))
                  .catch(() => {})
                  .finally(() => setBlRowBusy((prev) => {
                    const next = { ...prev };
                    delete next[key];
                    return next;
                  }));
              }}
              className={`inline-flex items-center justify-center p-2 rounded-lg border transition-colors disabled:cursor-wait disabled:opacity-50 ${
                isBL
                  ? 'text-orange-400 border-orange-700/60 bg-orange-900/25 hover:bg-orange-800/40'
                  : 'text-stone-500 border-stone-800 hover:text-orange-300 hover:bg-stone-800'
              }`}
            >
              {busy
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Ban className="w-3.5 h-3.5" />}
            </button>
          </div>
        );
      },
    },
    test: {
      id: 'test',
      width: { width: '96px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: actionHeader('all', 'Test'),
      cell: (m) => {
        const p2 = m.provider || provider;
        const cellKey = p2 + '::' + m.model + '::all';
        const busy = !!capsBusy[cellKey];
        const stopping = !!rowStopping[cellKey];
        const txt = stopping ? 'Arret…' : busy ? 'Stop' : 'Test';
        const cls = stopping
          ? 'bg-amber-700 text-white cursor-wait'
          : busy
            ? 'bg-red-600 text-white hover:bg-red-500'
            : 'bg-stone-800 text-stone-200 hover:bg-stone-700';
        return (
          <button
            type="button"
            onClick={() => handleRowTest(p2, m.model, 'all')}
            disabled={stopping}
            title={busy ? 'Re-cliquer pour annuler (arret propre : le test en cours finit et est enregistre)' : 'Tester les capacites de ce modele'}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium disabled:cursor-wait ${cls}`}
          >
            {busy && !stopping ? <Square className="w-3 h-3" /> : null}
            {stopping ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            {txt}
          </button>
        );
      },
    },
    test_sel: {
      id: 'test_sel',
      width: { width: '44px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: (
        <button
          type="button"
          onClick={() => {
            const next = new Set<string>();
            if (testChecked.size !== displayedModels.length) {
              for (const m of displayedModels) {
                next.add((m.provider || provider) + '::' + m.model);
              }
            }
            setTestChecked(next);
          }}
          title="Cocher / decocher toutes les lignes VISIBLES dans test_sel"
          className="cursor-pointer inline-flex items-center justify-center text-stone-300 hover:text-stone-200"
        >
          {testChecked.size === displayedModels.length && displayedModels.length > 0
            ? <CheckSquare className="w-4 h-4" />
            : <Square className="w-4 h-4" />}
        </button>
      ),
      cell: (m) => {
        const key = (m.provider || provider) + '::' + m.model;
        const isOn = testChecked.has(key);
        return (
          <button
            type="button"
            onClick={() => toggleCheck(setTestChecked, key)}
            title={isOn ? 'Retirer de la selection test' : 'Ajouter a la selection test'}
            className="cursor-pointer inline-flex items-center justify-center text-stone-300 hover:text-stone-200"
          >
            {isOn ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
          </button>
        );
      },
    },
    caps_checked: {
      id: 'caps_checked',
      width: { width: '225px' },
      thClass: `px-3 py-3 ${headerClass('caps_checked')}`,
      tdClass: 'px-3 py-3 text-stone-400 text-xs whitespace-nowrap',
      header: sortHeader('caps_checked', 'Verif. capacites'),
      cell: (_m, capKey) => {
        const cap = caps[capKey];
        const hasCapsData = (cap !== undefined && (
          cap.vision_supported !== undefined ||
          cap.reasoning_supported !== undefined ||
          cap.tools_supported !== undefined ||
          cap.vision_state !== undefined ||
          cap.reasoning_state !== undefined ||
          cap.tools_state !== undefined
        )) || (
          _m.vision_supported !== undefined ||
          _m.reasoning_supported !== undefined ||
          _m.tools_supported !== undefined
        );

        let ts: number | undefined = undefined;
        if (typeof capsLastChecked[capKey] === 'number' && capsLastChecked[capKey] > 0) {
          ts = capsLastChecked[capKey];
        } else if (typeof _m.last_cap_check === 'number' && _m.last_cap_check > 0) {
          ts = _m.last_cap_check;
        } else if (hasCapsData && typeof _m.last_checked === 'number' && _m.last_checked > 0) {
          ts = _m.last_checked;
        }

        return typeof ts === 'number' && ts > 0
          ? new Date(ts * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
          : '—';
      },
    },
    vision: {
      id: 'vision',
      width: { width: '108px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: actionHeader('vision', 'Vision'),
      cell: (_m, capKey) => {
        const cap = caps[capKey];
        const hasDate = (typeof capsLastChecked[capKey] === 'number' && capsLastChecked[capKey] > 0) ||
                        (typeof _m.last_cap_check === 'number' && _m.last_cap_check > 0);
        let val: boolean | 'time' | undefined = undefined;
        if (cap?.vision_state === 'time') {
          val = 'time';
        } else if (cap?.vision_supported !== undefined) {
          val = parseCapBoolean(cap.vision_supported);
        } else if (_m.vision_supported !== undefined) {
          val = parseCapBoolean(_m.vision_supported);
        } else if (hasDate) {
          val = false;
        }
        return <CapBadge label="Vision" value={val} neterr={_m?.cap_neterr} />;
      },
    },
    reasoning: {
      id: 'reasoning',
      width: { width: '108px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: actionHeader('reasoning', 'Raison.'),
      cell: (_m, capKey) => {
        const cap = caps[capKey];
        const hasDate = (typeof capsLastChecked[capKey] === 'number' && capsLastChecked[capKey] > 0) ||
                        (typeof _m.last_cap_check === 'number' && _m.last_cap_check > 0);
        let val: boolean | 'time' | undefined = undefined;
        if (cap?.reasoning_state === 'time') {
          val = 'time';
        } else if (cap?.reasoning_supported !== undefined) {
          val = parseCapBoolean(cap.reasoning_supported);
        } else if (_m.reasoning_supported !== undefined) {
          val = parseCapBoolean(_m.reasoning_supported);
        } else if (hasDate) {
          val = false;
        }
        return <CapBadge label="Raison." value={val} neterr={_m?.cap_neterr} />;
      },
    },
    tools: {
      id: 'tools',
      width: { width: '102px' },
      thClass: 'px-3 py-3',
      tdClass: 'px-3 py-3',
      header: actionHeader('tools', 'Tools'),
      cell: (_m, capKey) => {
        const cap = caps[capKey];
        const hasDate = (typeof capsLastChecked[capKey] === 'number' && capsLastChecked[capKey] > 0) ||
                        (typeof _m.last_cap_check === 'number' && _m.last_cap_check > 0);
        let val: boolean | 'time' | undefined = undefined;
        if (cap?.tools_state === 'time') {
          val = 'time';
        } else if (cap?.tools_supported !== undefined) {
          val = parseCapBoolean(cap.tools_supported);
        } else if (_m.tools_supported !== undefined) {
          val = parseCapBoolean(_m.tools_supported);
        } else if (hasDate) {
          val = false;
        }
        return <CapBadge label="Tools" value={val} neterr={_m?.cap_neterr} />;
      },
    },
  };

  // Liste ORDONNEE des definitions : unique source du rendu colgroup/th/td.
  const orderedCols: ColDef[] = colOrder.map((id) => COL_DEFS[id]).filter(Boolean);

  // Persiste + applique un nouvel ordre.
  const applyColOrder = (next: ColId[]) => {
    setColOrder(next);
    try { localStorage.setItem(MC_SCAN_COL_ORDER_KEY, JSON.stringify(next)); } catch { /* quota */ }
  };

  // Deplace `from` a la position de `to` (insertion avant/apres selon le sens).
  const moveCol = (from: ColId, to: ColId) => {
    if (from === to) return;
    const next = colOrder.filter((c) => c !== from);
    const idx = next.indexOf(to);
    if (idx < 0) return;
    const targetIdx = colOrder.indexOf(from) < colOrder.indexOf(to) ? idx + 1 : idx;
    next.splice(targetIdx, 0, from);
    applyColOrder(next);
  };

  const resetColOrder = () => {
    try { localStorage.removeItem(MC_SCAN_COL_ORDER_KEY); } catch { /* ignore */ }
    setColOrder([...DEFAULT_COL_ORDER]);
  };

  return (
    <div className="w-full space-y-8">
      <div className="flex items-end justify-between border-b border-stone-800 pb-6">
        <div>
          <h1 className="text-5xl font-serif text-stone-100">Scan.</h1>
          <p className="text-stone-500 mt-2">
            Teste la disponibilite REELLE des modeles d'un provider (vert = OK,
            rouge = quota/credit/mort). Appel reel par modele.
          </p>
        </div>
        <button
          type="button"
          onClick={exportPdf}
          disabled={pdfBusy}
          title="Exporter la liste des resultats de scan en PDF"
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors border ${
            pdfBusy
              ? 'opacity-50 cursor-wait'
              : 'bg-stone-800 text-stone-200 border-stone-700 hover:bg-stone-700 hover:text-white'
          }`}
        >
          {pdfBusy
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <FileDown className="w-4 h-4" />}
          Exporter PDF
        </button>
      </div>

      {/* Provider + Filter same row, EQUAL width (grid 50/50) + EQUAL height (grid stretch) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Provider (gauche) */}
        <div className="bg-stone-900 border border-stone-800 rounded-2xl p-6 flex flex-col">
          <label className="text-[10px] uppercase tracking-widest text-stone-500">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="mt-1 w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-stone-200 text-sm focus:outline-none focus:border-orange-500"
          >
            {catalog && (
              <option value={ALL_PROVIDERS}>Tous les providers ({allModelsAvailable} modèles)</option>
            )}
            {providers.length === 0 && <option value="">(chargement…)</option>}
            {providers.map(([key, meta]) => (
              <option key={key} value={key}>{meta.display_name} ({key}) — {meta.count} modele{meta.count > 1 ? 's' : ''}</option>
            ))}
          </select>
          <div className="mt-4">
            {scanning ? (
              <button onClick={handleStop} className="w-full flex items-center justify-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-red-700 text-white hover:bg-red-600 transition-colors">
                <Square className="w-4 h-4" /> Stop
              </button>
            ) : (
              <button
                onClick={handlePlay}
                disabled={!provider || modelList.length === 0 || checked.size === 0}
                className={`w-full flex items-center justify-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-colors ${
                  !provider || checked.size === 0 ? 'bg-stone-700 text-stone-400 cursor-not-allowed' : 'bg-orange-600 text-white hover:bg-orange-500'
                }`}
              >
                <Play className="w-4 h-4" />
                Lancer le scan {checked.size > 0 ? `(${checked.size})` : ''}
              </button>
            )}
          </div>
        </div>
        {/* Filtrer (droite) — meme largeur (grid 50/50) + meme hauteur (grid stretch) */}
        {provider && (
          <div className="bg-stone-900 border border-stone-800 rounded-2xl p-6 flex flex-col">
            <label className="text-[10px] uppercase tracking-widest text-stone-500">Filtrer</label>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrer par nom / description…"
              className="mt-1 w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-stone-200 text-sm focus:outline-none focus:border-orange-500"
            />
            <div className="mt-4 text-[11px] uppercase tracking-widest text-stone-500">
              {visibleModels.length} modele{visibleModels.length > 1 ? 's' : ''} affiche{visibleModels.length > 1 ? 's' : ''}
            </div>
          </div>
        )}
      </div>

      {!provider && !scanning && (
        <p className="text-stone-500 text-sm">Selectionnez un provider.</p>
      )}

      {error && (
        <div className="text-red-400 text-sm bg-red-900/20 border border-red-900/50 rounded-xl p-4">
          Erreur : {error}
        </div>
      )}

      {/* Model checklist (full catalog, checkboxes) */}
      {provider && (isAll || (!isFreeformProvider && modelList.length > 0)) && (
        <div className="bg-stone-900 border border-stone-800 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-stone-800">
            <div className="text-[11px] uppercase tracking-widest text-stone-400">
              Modeles ({checked.size}/{visibleModels.length} affiches
              {isAll ? ` / ${flatModels.length} total` : ''} coches)
            </div>
            <button
              onClick={toggleAll}
              disabled={scanning}
              className="text-[11px] uppercase tracking-widest text-orange-400 hover:text-orange-300 disabled:opacity-40"
            >
              {visibleModels.length > 0 && visibleModels.every((m) => checked.has(m.key))
                ? 'Tout decocher'
                : 'Tout cocher'}
            </button>
            {!isAll && (blacklist[provider]?.length ?? 0) > 0 && (
              <button
                onClick={async () => {
                  if (blBusy) return;
                  setBlBusy(true);
                  try {
                    const b = await clearBlacklist(provider);
                    setBlacklist(b);
                  } catch { /* ignore */ } finally { setBlBusy(false); }
                }}
                disabled={blBusy || scanning}
                title={`Retirer les ${blacklist[provider]?.length ?? 0} modele(s) blackliste(s) de ${provider}`}
                className="text-[11px] uppercase tracking-widest text-red-400 hover:text-red-300 disabled:opacity-40 flex items-center gap-1"
              >
                <Ban className="w-3 h-3" /> Tout deblacklister ({blacklist[provider]?.length ?? 0})
              </button>
            )}
            {/* v1.17.69 : en mode "Tous les providers", deblacklistage GLOBAL
                (backend /api/scan/blacklist/clear accepte provider="" = tout). */}
            {isAll && blTotalCount > 0 && (
              <button
                onClick={async () => {
                  if (blBusy) return;
                  const provCount = Object.keys(blacklist).filter(
                    (p) => (blacklist[p]?.length ?? 0) > 0,
                  ).length;
                  if (
                    !window.confirm(
                      `Deblacklister TOUS les modeles ?\n\n` +
                        `${blTotalCount} modele(s) blackliste(s) reparti(s) sur ${provCount} provider(s).\n\n` +
                        `Cette action est globale et irreversible.`,
                    )
                  )
                    return;
                  setBlBusy(true);
                  try {
                    const b = await clearBlacklist(''); // "" => tous les providers
                    setBlacklist(b);
                  } catch { /* ignore */ } finally { setBlBusy(false); }
                }}
                disabled={blBusy || scanning}
                title={`Retirer les ${blTotalCount} modele(s) blackliste(s) de tous les providers`}
                className="text-[11px] uppercase tracking-widest text-red-400 hover:text-red-300 disabled:opacity-40 flex items-center gap-1"
              >
                <Ban className="w-3 h-3" /> {blBusy ? 'Deblacklistage...' : `Tout deblacklister (${blTotalCount}) - tous providers`}
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-stone-800/60">
            {visibleModels.map((m) => {
              const isChecked = checked.has(m.key);
              // live result for this model, if already probed
              const live = resultModels.find(
                (r) => r.model === m.id && (isAll ? r.provider === m.provider : true),
              );
              // blacklist status (provider-aware)
              const blModels = blacklist[m.provider] || [];
              const isBL = blModels.includes(m.id);
              return (
                <label
                  key={m.key}
                  className={`flex items-start gap-3 px-5 py-2.5 text-sm cursor-pointer hover:bg-stone-800/40 ${
                    isBL ? 'bg-red-950/30' : ''
                  } ${scanning ? 'pointer-events-none opacity-70' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={scanning}
                    onChange={() => toggleOne(m.key)}
                    className="mt-1 accent-orange-500"
                  />
                  <div className="flex-1 min-w-0">
                    {isAll ? (
                      <>
                        <div className="font-mono text-stone-300 break-all">
                          {m.display} / {m.id}
                        </div>
                        {m.description && (
                          <div className="text-stone-500 text-xs break-words">
                            {m.description}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="font-mono text-stone-300 break-all">{m.id}</div>
                        {m.description && (
                          <div className="text-stone-500 text-xs break-words">
                            {m.description}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {isBL && (
                    <button
                      type="button"
                      title="Retirer de la blacklist"
                      onClick={(e) => {
                        e.preventDefault();
                        if (blBusy || scanning) return;
                        setBlBusy(true);
                        toggleBlacklist(m.provider, m.id)
                          .then(setBlacklist)
                          .catch(() => {})
                          .finally(() => setBlBusy(false));
                      }}
                      disabled={blBusy || scanning}
                      className="shrink-0 mt-1 text-red-400 hover:text-red-300 disabled:opacity-40"
                    >
                      <Ban className="w-4 h-4" />
                    </button>
                  )}
                  {activeScanKey === `${m.provider || provider}::${m.id}` && scanning && (
                    <span className="shrink-0 inline-flex items-center gap-1 text-amber-300">
                      EN COURS
                    </span>
                  )}
                  {activeScanKey !== `${m.provider || provider}::${m.id}` && isChecked && (
                    <span className="shrink-0 inline-flex items-center gap-1 text-orange-300 border border-orange-700 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-semibold">
                      SCAN
                    </span>
                  )}
                  {live && !scanning && (
                    <span className={`shrink-0 inline-flex items-center gap-1 ${
                      live.ok ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {live.ok
                        ? <CheckCircle2 className="w-4 h-4" />
                        : <XCircle className="w-4 h-4" />}
                    </span>
                  )}
                </label>
              );
            })}
            {visibleModels.length === 0 && (
              <div className="px-5 py-3 text-stone-500 text-xs">
                Aucun modele ne correspond au filtre.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Freeform provider: no fixed list */}
      {!isAll && provider && isFreeformProvider && (
        <div className="flex items-center gap-3 text-amber-300 bg-amber-900/20 border border-amber-900/50 rounded-xl p-4 text-sm">
          <AlertTriangle className="w-5 h-5" />
          Provider « {provider} » : modele libre (pas de liste fixe). Le scan
          par selection de modeles n'est pas disponible pour ce provider.
        </div>
      )}

      {/* Provider non configure */}
      {merged && !merged.configured && (
        <div className="flex items-center gap-3 text-amber-300 bg-amber-900/20 border border-amber-900/50 rounded-xl p-4 text-sm">
          <AlertTriangle className="w-5 h-5" />
          Provider{merged.provider === ALL_PROVIDERS ? 's' : ` « ${merged.provider} »`} non
          configure(e) (pas de cle/URL) — impossible de tester les modeles.
          Ajoutez la cle dans ~/.hermes/.env.
        </div>
      )}

      {/* Live progress */}
      {scanning && (
        <div className="flex items-center gap-3 text-stone-300 text-sm bg-stone-900 border border-stone-800 rounded-xl p-4">
          <Loader2 className="w-4 h-4 animate-spin text-orange-400" />
          Scan en cours… {scanBatchDone} / {scanBatchTotal} modeles testes
        </div>
      )}

      {/* Toggle (gauche, empile verticalement) + Summary (droite, 3 cartes) SUR LA MEME LIGNE, meme hauteur */}
      {merged && (
        <div className="flex flex-col md:flex-row md:items-stretch gap-4">
          {/* Toggle: bouton + liens empiles verticalement (gauche) */}
          {resultModels.length > 0 && (
            <div className="flex flex-col justify-center gap-1.5 md:py-1">
              <button
                onClick={() => { setOnlyOk((v) => !v); setOnlyKo(false); }}
                aria-pressed={onlyOk}
                className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  onlyOk
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : 'bg-stone-800 text-stone-300 hover:bg-stone-700 border border-stone-700'
                }`}
              >
                <CheckCircle2 className="w-4 h-4" />
                Uniquement les modeles OK
                {onlyOk && (
                  <span className="text-[11px] bg-emerald-800/60 rounded-full px-2 py-0.5">
                    {okCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => { setOnlyKo((v) => !v); setOnlyOk(false); }}
                aria-pressed={onlyKo}
                className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  onlyKo
                    ? 'bg-red-600 text-white hover:bg-red-500'
                    : 'bg-stone-800 text-stone-300 hover:bg-stone-700 border border-stone-700'
                }`}
              >
                <XCircle className="w-4 h-4" />
                Uniquement les modeles KO
                {onlyKo && (
                  <span className="text-[11px] bg-red-800/60 rounded-full px-2 py-0.5">
                    {koFilteredCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => { setOnlyOk(false); setOnlyKo(false); }}
                className="text-[11px] uppercase tracking-widest text-stone-400 hover:text-stone-200 text-left"
              >
                Reinitialiser
              </button>
              <button
                type="button"
                onClick={() => {
                  if (scanning) return;
                  stopPolling();
                  // POINT 3b: purge AUSSI la DB serveur, sinon la restauration
                  // au montage (POINT 3a) reafficherait tout l'historique.
                  clearScanResults().catch(() => { /* best effort */ });
                  clearScanSession();
                  setMerged(null);
                  setScanning(false);
                  setChecked(new Set());
                  setCaps({});
                  setCapsLastChecked({});
                  setTestedSession(new Set());
                  setScannedSession(new Set());
                  setOnlyOk(false);
                  setOnlyKo(false);
                }}
                disabled={scanning}
                title="Vide l'historique de resultats persiste (localStorage)"
                className="text-[11px] uppercase tracking-widest text-red-400 hover:text-red-300 disabled:opacity-40 text-left"
              >
                Effacer les resultats
              </button>
            </div>
          )}
          {/* Summary: 3 cartes resume a droite, meme hauteur que le bloc toggle (h-full).
              FIX 2026-08-22 (Manager) : on affiche des qu'il y a des resultats
              (resultModels.length > 0), PAS uniquement a la fin du scan (allDone).
              Sinon pendant un scan en cours (status 'running') les compteurs
              OK/KO/ORANGE/TIMEOUT disparaissaient. */}
          {resultModels.length > 0 && (
            <div className="grid grid-cols-4 gap-3 flex-1 md:h-full">
              <div className="bg-stone-900 border border-emerald-900/40 rounded-2xl flex items-center justify-center px-3 h-16 md:h-full">
                <div className="text-center">
                  <div className="text-2xl font-serif text-emerald-400">{okCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-emerald-600/70 mt-0.5">
                    Tous (OK)
                  </div>
                </div>
              </div>
              {/* 3 etats : carte ORANGE intercalee entre VERT et ROUGE + carte TIMEOUT. */}
              <div className="bg-stone-900 border border-amber-900/40 rounded-2xl flex items-center justify-center px-3 h-16 md:h-full">
                <div className="text-center">
                  <div className="text-2xl font-serif text-amber-400">{orangeCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-amber-600/70 mt-0.5">
                    Tous (ORANGE)
                  </div>
                </div>
              </div>
              <div className="bg-stone-900 border border-red-900/40 rounded-2xl flex items-center justify-center px-3 h-16 md:h-full">
                <div className="text-center">
                  <div className="text-2xl font-serif text-red-400">{koCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-red-600/70 mt-0.5">
                    Tous (KO)
                  </div>
                </div>
              </div>
              <div className="bg-stone-900 border border-orange-800/50 rounded-2xl flex items-center justify-center px-3 h-16 md:h-full">
                <div className="text-center">
                  <div className="text-2xl font-serif text-orange-300">{timeCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-orange-500/70 mt-0.5">
                    TIMEOUT
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Compteur "Ce scan" - OK/KO du batch courant.
              FIX 2026-08-22 (Manager) : affiche des qu'il y a des resultats
              (meme pendant le scan en cours), pas seulement a la fin. */}
          {resultModels.length > 0 && batchTotal > 0 && (
            <div className="grid grid-cols-4 gap-3 flex-1 md:h-full mt-2">
              <div className="bg-stone-900/50 border border-stone-800/50 rounded-xl flex items-center justify-center px-3 h-14 md:h-full">
                <div className="text-center">
                  <div className="text-lg font-serif text-stone-300">{batchTotal}</div>
                  <div className="text-[10px] uppercase tracking-widest text-stone-500 mt-0.5">
                    Ce scan
                  </div>
                </div>
              </div>
              <div className="bg-stone-900/50 border border-emerald-900/40 rounded-xl flex items-center justify-center px-3 h-14 md:h-full">
                <div className="text-center">
                  <div className="text-lg font-serif text-emerald-400">{batchOkCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-emerald-600/70 mt-0.5">
                    OK
                  </div>
                </div>
              </div>
              <div className="bg-stone-900/50 border border-amber-900/40 rounded-xl flex items-center justify-center px-3 h-14 md:h-full">
                <div className="text-center">
                  <div className="text-lg font-serif text-amber-400">{batchOrangeCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-amber-600/70 mt-0.5">
                    ORANGE
                  </div>
                </div>
              </div>
              <div className="bg-stone-900/50 border border-red-900/40 rounded-xl flex items-center justify-center px-3 h-14 md:h-full">
                <div className="text-center">
                  <div className="text-lg font-serif text-red-400">{batchKoCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-red-600/70 mt-0.5">
                    KO
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}



      {/* Results table (live partials + final) — vrai <table> en table-fixed :
          garantit l'alignement parfait header/lignes et des largeurs de
          colonnes FIXES (colgroup). v1.17.63 : colgroup/th/td sont TOUS
          generes depuis `orderedCols` (data-driven) -> alignement 14/14/14
          garanti quelle que soit la permutation. */}
      {merged && resultModels.length > 0 && (
        <div className="bg-stone-900 border border-stone-800 rounded-2xl overflow-hidden">
          {/* v1.17.63 - BARRE DE FILTRE DU TABLEAU (distincte du champ
              "Filtrer" de la liste de selection en haut de page).
              AFFICHAGE UNIQUEMENT : ne modifie ni le store ni la base. */}
          <div className="border-b border-stone-800 bg-stone-950/60 px-5 py-4 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[260px]">
              <label
                htmlFor="mc-scan-table-filter"
                className="text-[10px] uppercase tracking-widest text-orange-400/80"
              >
                Filtrer les resultats du tableau
              </label>
              <input
                id="mc-scan-table-filter"
                data-testid="scan-table-filter"
                type="text"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                placeholder="Filtrer par nom de modele…"
                className="mt-1 w-full bg-stone-950 border border-orange-800/50 rounded-lg px-3 py-2 text-stone-200 text-sm focus:outline-none focus:border-orange-500"
              />
              <div className="mt-3 flex flex-wrap gap-3">
                <label className="flex items-center gap-1.5 text-xs text-stone-300 cursor-pointer">
                  <input type="checkbox" checked={capFilter.vision} onChange={() => setCapFilter((p) => ({ ...p, vision: !p.vision }))} className="accent-orange-500" />
                  Vision
                </label>
                <label className="flex items-center gap-1.5 text-xs text-stone-300 cursor-pointer">
                  <input type="checkbox" checked={capFilter.reasoning} onChange={() => setCapFilter((p) => ({ ...p, reasoning: !p.reasoning }))} className="accent-orange-500" />
                  Raisonnement
                </label>
                <label className="flex items-center gap-1.5 text-xs text-stone-300 cursor-pointer">
                  <input type="checkbox" checked={capFilter.tools} onChange={() => setCapFilter((p) => ({ ...p, tools: !p.tools }))} className="accent-orange-500" />
                  Tools
                </label>
              </div>
            </div>
            <div
              data-testid="scan-table-filter-count"
              className="text-xs text-stone-400 whitespace-nowrap"
            >
              <span className="text-stone-200 font-medium">{displayedModels.length}</span>
              {' / '}
              {resultModels.length} resultats affiches
            </div>
            {/* v1.17.77 - COMPTEURS LIVE SCAN + CAPACITES */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="bg-stone-900/50 border border-orange-900/40 rounded-xl flex items-center justify-center px-3 h-12">
                <div className="text-center">
                  <div className="text-lg font-serif text-orange-300">{scanCheckedCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-orange-600/70 mt-0.5">
                    Cochés (scan)
                  </div>
                </div>
              </div>
              {scanning && scanBatchTotal > 0 && (
                <div className="bg-stone-900/50 border border-stone-800/50 rounded-xl flex items-center justify-center px-3 h-12">
                  <div className="text-center">
                    <div className="text-lg font-serif text-stone-300">{scanBatchDone} / {scanBatchTotal}</div>
                    <div className="text-[10px] uppercase tracking-widest text-stone-500 mt-0.5">
                      Scannés
                    </div>
                  </div>
                </div>
              )}
              <div className="bg-stone-900/50 border border-emerald-900/40 rounded-xl flex items-center justify-center px-3 h-12">
                <div className="text-center">
                  <div className="text-lg font-serif text-emerald-400">{testCheckedCount}</div>
                  <div className="text-[10px] uppercase tracking-widest text-emerald-600/70 mt-0.5">
                    Cochés (tests)
                  </div>
                </div>
              </div>
              {capsActive && testCheckedCount > 0 && (
                <div className="bg-stone-900/50 border border-stone-800/50 rounded-xl flex items-center justify-center px-3 h-12">
                  <div className="text-center">
                    <div className="text-lg font-serif text-stone-300">{capX} / {testTotal > 0 ? testTotal : testCheckedCount}</div>
                    <div className="text-[10px] uppercase tracking-widest text-stone-500 mt-0.5">
                      Testés
                    </div>
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              data-testid="scan-table-filter-clear"
              onClick={() => setTableFilter('')}
              disabled={tableFilter === ''}
              className="px-3 py-2 rounded-lg text-xs font-medium bg-stone-800 text-stone-200 border border-stone-700 hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Vider le filtre
            </button>
            <button
              type="button"
              data-testid="scan-col-order-reset"
              onClick={resetColOrder}
              title="Remettre les 14 colonnes dans leur ordre d'origine"
              className="px-3 py-2 rounded-lg text-xs font-medium bg-stone-800 text-stone-200 border border-stone-700 hover:bg-stone-700"
            >
              Reinitialiser l'ordre des colonnes
            </button>
            <p className="w-full text-[11px] text-stone-500">
              Glisser-deposer un en-tete pour reordonner les colonnes. Les boutons
              d'en-tete (Test / Vision / Raison. / Tools) agissent sur les
              {' '}{displayedModels.length} ligne(s) AFFICHEE(S).
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="table-fixed w-full min-w-[1470px] border-collapse text-sm">
              <colgroup>
                {orderedCols.map((c) => (
                  <col key={c.id} data-col-id={c.id} style={c.width} />
                ))}
              </colgroup>
              <thead>
                <tr className="border-b border-stone-800 text-[10px] uppercase tracking-widest text-stone-500">
                  {orderedCols.map((c) => {
                    const isDragged = dragCol === c.id;
                    const isOver = dragOverCol === c.id && dragCol !== c.id;
                    return (
                      <th
                        key={c.id}
                        data-col-id={c.id}
                        draggable
                        onDragStart={(e) => {
                          draggingRef.current = true;
                          setDragCol(c.id);
                          e.dataTransfer.effectAllowed = 'move';
                          try { e.dataTransfer.setData('text/plain', c.id); } catch { /* ignore */ }
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dragOverCol !== c.id) setDragOverCol(c.id);
                        }}
                        onDragLeave={() => {
                          setDragOverCol((cur) => (cur === c.id ? null : cur));
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const from = (dragCol
                            || (e.dataTransfer.getData('text/plain') as ColId)) as ColId;
                          if (from) moveCol(from, c.id);
                          setDragCol(null);
                          setDragOverCol(null);
                          // Laisse React traiter le clic parasite eventuel.
                          setTimeout(() => { draggingRef.current = false; }, 0);
                        }}
                        onDragEnd={() => {
                          setDragCol(null);
                          setDragOverCol(null);
                          setTimeout(() => { draggingRef.current = false; }, 0);
                        }}
                        className={`${c.thClass} text-center align-middle cursor-grab active:cursor-grabbing ${
                          isDragged ? 'opacity-40 bg-orange-900/20' : ''
                        } ${isOver ? 'border-l-2 border-l-orange-500 bg-stone-800/50' : ''}`}
                      >
                        {c.header}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {displayedModels.map((m, i) => {
                  const capKey = (m.provider || provider) + '::' + m.model;
                  return (
                    <tr
                      key={((m.provider || provider) || '') + '::' + m.model + i}
                      className="border-b border-stone-800/60 last:border-0 hover:bg-stone-800/30"
                    >
                      {orderedCols.map((c) => (
                        <td key={c.id} data-col-id={c.id} className={`${c.tdClass} text-center align-middle`}>
                          {c.cell(m, capKey)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {displayedModels.length === 0 && (
                  <tr>
                    <td
                      colSpan={orderedCols.length}
                      className="px-5 py-6 text-center text-stone-500 text-sm"
                    >
                      Aucun resultat ne correspond au filtre « {tableFilter} ».
                      L'historique ({resultModels.length} entrees) est intact.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {scanning && !merged && (
        <p className="text-stone-500 text-sm animate-pulse">
          <Scan className="w-4 h-4 inline mr-1" />
          Demarrage du scan (appels reels, timeout 20-60s/modele)…
        </p>
      )}
    </div>
  );
};
