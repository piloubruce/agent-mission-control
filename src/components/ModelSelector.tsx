import React, { useEffect, useMemo, useState } from 'react';
import { filterModels } from '../lib/filterModels';
import {
  getAgentModel,
  getModelCatalog,
  getProviderModels,
  getBlacklist,
  getScanResults,
  startScan,
  getScanStatus,
  calculateModelScore,
  isUnmeasured,
  setAgentModel,
  type AgentModel,
  type FallbackModel,
  type BlacklistMap,
  type ModelCatalog,
  type CatalogProvider,
  type ProviderModels,
  type ScanModelResult,
  type ModelScore,
  type ScanStatus,
} from '../api';
import { Cpu, Zap, Check, Ban, Eye, Brain, Wrench } from 'lucide-react';
import { toggleFav, favKey, sortFavFirst } from '../modelFavorites';
import { getMcFavs } from '../api';

const ALL_PROVIDERS = '__all__';

// ---------------------------------------------------------------------------
// v1.17.76 — Indice de score + capacites V/R/T sur chaque ligne de modele.
// Source unique de verite : la base du scan (scan_results.db via getScanResults)
// et calculateModelScore (le MEME calcul que la colonne Score de l'onglet SCAN).
// Un modele JAMAIS SCANNE n'invente rien : score '—' et lettres V/R/T grisees.
// ---------------------------------------------------------------------------
type ScanIndex = Record<string, ScanModelResult>;
const scanKey = (provider: string, model: string) => `${provider}::${model}`;

const scoreOf = (r: ScanModelResult): ModelScore =>
  calculateModelScore({
    latency_ms: r.latency_ms ?? null,
    ok: r.ok ?? false,
    error: r.reason ?? null,
    tokens_per_sec: r.tokens_per_sec ?? null,
    vision_supported: r.vision_supported,
    reasoning_supported: r.reasoning_supported,
    tools_supported: r.tools_supported,
  });

/** Pastille de score identique (couleurs/lettres) a ScoreBadge de l'onglet SCAN. */
const MsScoreBadge: React.FC<{ res?: ScanModelResult }> = ({ res }) => {
  if (!res || isUnmeasured(res)) {
    return (
      <span
        data-testid="ms-score"
        data-score="none"
        title="Modele jamais scanne — aucun score disponible (lancez un scan dans l'onglet SCAN)"
        className="inline-flex items-center justify-center w-9 px-1 py-0.5 rounded border border-stone-800 text-stone-600 text-[10px] font-mono cursor-help"
      >
        —
      </span>
    );
  }
  const s = scoreOf(res);
  const color = ({
    A: 'text-emerald-400 bg-emerald-900/20 border-emerald-800',
    B: 'text-blue-400 bg-blue-900/20 border-blue-800',
    C: 'text-amber-400 bg-amber-900/20 border-amber-800',
    D: 'text-red-400 bg-red-900/20 border-red-800',
  } as Record<string, string>)[s.score_letter] ?? 'text-stone-400 bg-stone-800/50 border-stone-700';
  return (
    <span
      data-testid="ms-score"
      data-score={String(s.score)}
      title={s.detail}
      className={`inline-flex items-center justify-center gap-0.5 w-9 px-1 py-0.5 rounded border text-[10px] font-mono tabular-nums cursor-help ${color}`}
    >
      {s.score}
      <span className="opacity-70">{s.score_letter}</span>
    </span>
  );
};

/** V / R / T : VERT si la capacite est PROUVEE, gris sinon (ou jamais scanne).
 *  AMBRE « à revérifier (réseau) » si la sonde capa est tombée en erreur réseau
 *  (cap_neterr) et que la capacité est donc inconnue. */
const MsCaps: React.FC<{ res?: ScanModelResult }> = ({ res }) => {
  const neterr = res?.cap_neterr === true;
  const items: Array<[string, boolean | undefined, string]> = [
    ['V', res?.vision_supported, 'Vision'],
    ['R', res?.reasoning_supported, 'Raisonnement'],
    ['T', res?.tools_supported, 'Tools'],
  ];
  return (
    <span data-testid="ms-caps" className="inline-flex items-center gap-0.5 font-mono text-[10px] font-bold">
      {items.map(([letter, val, label]) => {
        const color = val === true
          ? 'text-emerald-400'
          : neterr
            ? 'text-amber-500'
            : 'text-stone-600';
        const title = !res
          ? `${label} : modele jamais scanne`
          : val === true
            ? `${label} : PROUVE`
            : val === false
              ? `${label} : teste, non supporte`
              : neterr
                ? `${label} : a revérifier (réseau)`
                : `${label} : non teste`;
        return (
          <span
            key={letter}
            data-cap={letter}
            data-val={val === true ? 'yes' : val === false ? 'no' : 'unknown'}
            title={title}
            className={`w-3.5 text-center cursor-help ${color}`}
          >
            {neterr && val !== true && val !== false ? '⟳' : letter}
          </span>
        );
      })}
    </span>
  );
};

/**
 * ModelSelector — clickable "puce" (Cpu) that opens a provider -> model picker
 * for ONE agent (mirrors Hermes Agent: pick provider, then model). On change it
 * calls POST /api/agent/model which writes ~/.hermes/profiles/<agent>/config.yaml.
 * Source of truth = the REAL Hermes registry + LIVE provider model discovery
 * (backend delegates to Hermes' own provider_model_ids()). Every provider that
 * exposes a model list (OpenRouter, Nous — incl. the :free tier, Anthropic,
 * Gemini, DeepSeek, Fireworks, LM Studio / custom, ...) renders clickable
 * model buttons. A FREE-FORM text field is ALWAYS available as a fallback so
 * the user can still type an exact id when the live list is empty (no API key,
 * unreachable endpoint) or when they want to force a specific name.
 */
export const ModelSelector: React.FC<{ agent: string }> = ({ agent }) => {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [model, setModel] = useState<AgentModel | null>(null);
  const [provider, setProvider] = useState<string>('');
  const [freeformModel, setFreeformModel] = useState<string>('');
  // Search box that filters the live model list shown above (req: filter list).
  const [filter, setFilter] = useState<string>('');
  // v1.17.141 - Filtres capacites Vision/Raison/Tools (AND).
  const [capFilter, setCapFilter] = useState<{ vision: boolean; reasoning: boolean; tools: boolean }>({
    vision: false, reasoning: false, tools: false
  });
  // v2026-08-11 — Tri optionnel par tokens/sec (bouton sur la meme ligne que
  // les filtres capacite). Quand actif, la liste est triee par tok/s
  // decroissant (non mesures en fin), avec OU sans filtre capacite.
  const [sortTps, setSortTps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Live model list for the currently-selected provider (from ?provider=X).
  const [live, setLive] = useState<ProviderModels | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  // Fallback manager (2026-08-03, MANAGER): défaut + 3 fallbacks de l'agent,
  // réordonnables par drag & drop, avec cible d'application.
  const [fallbacks, setFallbacks] = useState<FallbackModel[]>([]);
  const [applyTarget, setApplyTarget] = useState(0); // 0=default, 1..3=fallback i
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  // Mémorise le provider du modèle sélectionné dans la liste (pour BUG A: utiliser ce provider
  // au lieu du filtre PROVIDER qui peut être "__all__" quand l'utilisateur filtre "Tous les providers")
  const [selectedModelProvider, setSelectedModelProvider] = useState<string | null>(null);

  // vMODE-AGENT-SCAN (2026-08-12) : scan depuis la modale.
  // `scanBusyKey` marque un modele (provider::model) en cours de scan.
  // `scanSeq` -> scan sequentiel du defaut + fallbacks (bouton "Scanner cet agent").
  // `scanErr` -> message d'erreur non bloquant (API indispo, timeout, ...).
  const [scanBusyKey, setScanBusyKey] = useState<string | null>(null);
  const [scanSeqBusy, setScanSeqBusy] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);

  /** Normalise un nom de provider pour les appels SCAN + la lecture d'index.
   *  Le profil Hermes stocke `custom:omni-route` (nom complet), mais le
   *  backend MC n'autorise que `omni-route` (sans prefixe) -> sinon 403
   *  "provider non autorise" et le resultat n'est jamais enregistre
   *  (symptome: "Jamais scanne" sur les agents distants apres le scan).
   *  On strippe le prefixe `custom:` et on lowercase pour matcher exactement
   *  le nom que le backend utilise et persiste dans scan_results.db. */
  const normProv = (p?: string | null): string => {
    const s = (p || '').replace(/^custom:/i, '').trim().toLowerCase();
    if (s === 'omni route' || s === 'omni_route' || s === 'omniroute') {
      return 'omni-route';
    }
    return s.replace(/\s+/g, '-').replace(/_/g, '-');
  };

  /** Formate une date epoch (secondes, float) en JJ/MM/AA HH:MM local. */
  const fmtScan = (epoch?: number | null): string => {
    if (epoch === undefined || epoch === null || epoch === 0) return 'Jamais scanne';
    const d = new Date(epoch * 1000);
    if (Number.isNaN(d.getTime())) return 'Jamais scanne';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /** Scan SEQUENTIEL d'un seul modele (startScan + poll jusqu'a done).
   *  Reutilise le meme mecanisme que handleScanOne de l'onglet SCAN. */
  const scanOneModel = async (prov: string, mdl: string) => {
    const np = normProv(prov);
    const key = `${np}::${mdl}`;
    setScanBusyKey(key);
    setScanErr(null);
    try {
      const start = await startScan(np, [mdl]);
      const sid = start.scan_id;
      const deadline = Date.now() + 200_000;
      let st: ScanStatus | null = null;
      while (Date.now() < deadline) {
        try {
          st = await getScanStatus(sid);
        } catch {
          st = null;
          break;
        }
        if (st && (st.status === 'done' || st.status === 'cancelled' || st.status === 'error')) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      // L'API /api/scan/results est la source de verite : on la re-lit pour
      // rafraichir last_checked + score + capacites de CE modele scanne.
      if (st) {
        const r = await getScanResults(np);
        const idx: ScanIndex = {};
        for (const res of r.results ?? []) {
          const p = (res.provider || '').trim();
          if (!p || !res.model) continue;
          idx[scanKey(p, res.model)] = res;
        }
        // vFIX (2026-08-13) : MERGE dans l'index existant au lieu d'ecraser —
        // sinon un scan d'un seul provider vide l'historique des autres
        // (symptome "tout l'historique des modeles distants disparait").
        setScanIdx((prev) => ({ ...prev, ...idx }));
        // Merge aussi la liste globale (utilisee par allModels / providerModels).
        setScanList((prev) => {
          const seen = new Set(prev.map((x) => `${x.provider}::${x.model}`));
          const add = (r.results ?? []).filter((x) => !seen.has(`${x.provider}::${x.model}`));
          return [...prev, ...add];
        });
      }
    } catch (e) {
      setScanErr(e instanceof Error ? e.message : 'erreur scan (API indispo ?)');
    } finally {
      setScanBusyKey(null);
    }
  };

  /** Scan SEQUENTIEL du modele par defaut + tous les fallbacks (un par un,
   *  PAS Promise.all). Bouton "Scanner cet agent" en haut de la section. */
  const scanSequentialAgent = async () => {
    if (scanSeqBusy) return;
    setScanSeqBusy(true);
    setScanErr(null);
    const def = model;
    const targets: { prov: string; mdl: string }[] = [];
    if (def?.provider && def?.model) targets.push({ prov: normProv(def.provider), mdl: def.model });
    for (const f of fallbacks.slice(0, 3)) {
      if (f.provider && f.model) targets.push({ prov: normProv(f.provider), mdl: f.model });
    }
    for (const t of targets) {
      try {
        await scanOneModel(t.prov, t.mdl);
      } catch {
        /* une erreur sur un modele n'arrete pas la serie sequentielle */
      }
    }
    setScanSeqBusy(false);
  };

  // Blacklist des modeles KO (persistee serveur). Map provider -> [model_ids].
  const [blacklist, setBlacklist] = useState<BlacklistMap>({});
  // Providers cochés dans l'onglet Configuration (scan_providers).
  const [scanProviders, setScanProviders] = useState<Record<string, boolean>>({});

  // v1.17.76 : index des resultats de scan (scan_results.db) charge a
  // l'OUVERTURE de la modale. Cle = provider::model. Un modele absent de cet
  // index n'a JAMAIS ete scanne -> affichage '—' + V/R/T grisees.
  const [scanIdx, setScanIdx] = useState<ScanIndex>({});
  // vRESTORE (2026-08-11) : liste plate des resultats de scan (source de
  // "Tous les providers" dans cette modale, car catalog.providers ne porte
  // que les `count`, pas la liste réelle des modèles). Filtree ensuite par
  // providers cochés + ok + hors blacklist -> ~140 modeles dispo (cohérent
  // avec le bandeau SCAN "X OK").
  const [scanList, setScanList] = useState<ScanModelResult[]>([]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getScanResults()
      .then((r) => {
        if (cancelled) return;
        const idx: ScanIndex = {};
        for (const res of r.results ?? []) {
          const p = (res.provider || '').trim();
          if (!p || !res.model) continue;
          idx[scanKey(p, res.model)] = res;
        }
        setScanIdx(idx);
        setScanList(r.results ?? []);
      })
      .catch(() => { if (!cancelled) { setScanIdx({}); setScanList([]); } });
    return () => { cancelled = true; };
  }, [open]);

  // Favoris de modeles pour CET agent (persistes cote serveur: mc_favs.json).
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!agent) {
      setFavs([]);
      return;
    }
    getMcFavs(agent).then((ids) => {
      if (!cancelled) setFavs(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [agent, open]);
  const favSet = useMemo(() => new Set(favs), [favs]);

  // Load current model + catalog when opened.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr(null);
    setLive(null);
    Promise.all([getAgentModel(agent), getModelCatalog(), getBlacklist()])
      .then(async ([m, cat, bl]) => {
        if (cancelled) return;
        setModel(m);
        setFallbacks(m?.fallbacks ?? []);
        setCatalog(cat);
        setBlacklist(bl);
        // Charge scan_providers (providers cochés en Configuration).
        let sp: Record<string, boolean> = {};
        try {
          const resp = await fetch('/api/config/scan_providers');
          if (resp.ok) {
            const data = await resp.json();
            sp = (data.scan_providers || {}) as Record<string, boolean>;
          }
        } catch { /* ignore */ }
        const hasCfg = Object.keys(sp).length > 0;
        const next: Record<string, boolean> = {};
        for (const key of Object.keys(cat.providers || {})) {
          next[key] = hasCfg ? sp[key] === true : true;
        }
        setScanProviders(next);
        // Providers VISIBLES = seulement ceux cochés (et avec au moins 1 modele).
        const visibleProviders = Object.keys(cat.providers).filter(
          (k) => !(cat.providers[k].count === 0) && next[k] === true,
        );
        const firstProvider = visibleProviders[0] ?? '';
        // Keep the agent's current provider if present in the catalog AND visible (coché).
        const initProvider =
          m?.provider && cat.providers[m.provider] && next[m.provider] === true
            ? m.provider
            : firstProvider;
        setProvider(initProvider);
        if (m?.model) setFreeformModel(m.model);
      })
      .catch(() => !cancelled && setErr('lecture modele impossible'));
    return () => {
      cancelled = true;
    };
  }, [open, agent]);

  const providerMeta: CatalogProvider | undefined = useMemo(
    () => (catalog && provider ? catalog.providers[provider] : undefined),
    [catalog, provider],
  );

  // When the provider changes, live-fetch its model list (fresh for that
  // provider). Falls back gracefully: an empty/failed list just means the
  // free-form field is the only option — which is always shown anyway.
  useEffect(() => {
    if (!open || !provider || provider === ALL_PROVIDERS) return;
    let cancelled = false;
    setLiveBusy(true);
    getProviderModels(provider)
      .then((data) => {
        if (!cancelled) setLive(data);
      })
      .catch(() => {
        if (!cancelled) setLive({ provider, freeform: true, count: 0, models: [] });
      })
      .finally(() => !cancelled && setLiveBusy(false));
    return () => {
      cancelled = true;
    };
  }, [open, provider]);

  // The model list to display. Priorite : la liste live du provider (fetch
  // frais), sinon le catalogue scanne (scanList) filtre par provider — qui
  // porte la VRAIE liste (ex: omni-route = 148, pas un sous-ensemble de 9).
  // Le fetch /api/models?provider=X renvoie 0 modele (bug backend connu), donc
  // on s'appuie sur scanList quand live est vide.
  const providerModels = useMemo(() => {
    if (provider === ALL_PROVIDERS) {
      return [];
    }
    const key = normProv(provider);
    let base: { id: string; display_name?: string; description?: string }[] = [];
    if (scanList.length) {
      const seen = new Set<string>();
      for (const r of scanList) {
        const pk = normProv(r.provider || '');
        if (pk !== key || !r.model) continue;
        if (r.ok !== true) continue;
        if (seen.has(r.model)) continue;
        seen.add(r.model);
        base.push({ id: r.model, display_name: r.model, description: r.reason });
      }
    } else {
      let b: { id: string; display_name?: string; description?: string }[] = [];
      if (live && live.provider === provider && (live.models?.length ?? 0) > 0) {
        b = live.models;
      } else if (providerMeta?.models?.length) {
        b = providerMeta.models;
      }
      base = b;
    }
    const bl = new Set(blacklist[provider] || []);
    return base.filter((m) => !bl.has(m.id));
  }, [live, provider, providerMeta, blacklist, scanList]);

  const isFreeform = useMemo(() => {
    if (provider === ALL_PROVIDERS) return true;
    if (live && live.provider === provider) return !!live.freeform;
    return !!providerMeta?.freeform;
  }, [live, provider, providerMeta]);

  // Nom d'affichage du provider courant (utilise pour la recherche + liste).
  const displayName = providerMeta?.display_name || provider;

  // vRESTORE (2026-08-11) : source = scan_results.db (via getScanResults),
  // PAS catalog.providers (qui ne porte que les `count`, jamais la liste
  // réelle des modèles -> donnait 0 modèle). "Tous les providers" = modèles
  // OK (scannés répondus) des providers cochés en Configuration, hors
  // blacklist. ~140 modèles dispo (cohérent avec le bandeau SCAN "X OK").
  const allModels = useMemo(() => {
    if (!scanList.length) return [];
    const out: { provider: string; display: string; id: string; description?: string }[] = [];
    for (const r of scanList) {
      const key = (r.provider || '').trim();
      if (!key || !r.model) continue;
      if (!(scanProviders[key] === true)) continue;   // SEULEMENT providers cochés
      if (r.ok !== true) continue;                     // SEULEMENT modèles OK (disponibles)
      const bl = new Set(blacklist[key] || []);
      if (bl.has(r.model)) continue;                    // hors blacklist
      const display = catalog?.providers[key]?.display_name || key;
      out.push({ provider: key, display, id: r.model });
    }
    return out;
  }, [scanList, scanProviders, catalog, blacklist]);

  // Search box that filters the model list.
  // Scoped to the SELECTED provider by default; ONLY global when provider
  // is ALL_PROVIDERS. A non-empty filter does NOT switch to global search.
  const filteredModels = useMemo(() => {
    if (provider === ALL_PROVIDERS) {
      let list = allModels
        .map((m) => ({
          id: m.id,
          description: m.description,
          provider: m.provider,
          display: m.display,
        }));
      list = filterModels(list, filter);
      // v1.17.141 - Filtres capacites Vision/Raison/Tools (AND).
      if (capFilter.vision || capFilter.reasoning || capFilter.tools) {
        list = list.filter((m) => {
          const res = scanIdx[scanKey(normProv(m.provider), m.id)];
          if (!res) return false;
          return (!capFilter.vision || res.vision_supported) &&
                 (!capFilter.reasoning || res.reasoning_supported) &&
                 (!capFilter.tools || res.tools_supported);
        });
      }
      let __sorted = sortFavFirst(list, (m) => favKey(m.provider ?? provider, m.id), favSet);
      // v2026-08-11 — tri par tokens/sec decroissant (non mesures -> fin)
      if (sortTps) {
        __sorted = [...__sorted].sort((a, b) => {
          const ta = scanIdx[scanKey(normProv(a.provider ?? provider), a.id)]?.tokens_per_sec ?? -1;
          const tb = scanIdx[scanKey(normProv(b.provider ?? provider), b.id)]?.tokens_per_sec ?? -1;
          return tb - ta;
        });
      }
      return __sorted;
    }
    let list = providerModels
      .map((m) => ({
        id: m.id,
        description: m.description,
        provider: provider as string | undefined,
        display: displayName as string | undefined,
      }));
    list = filterModels(list, filter);
    // v1.17.141 - Filtres capacites Vision/Raison/Tools (AND).
    if (capFilter.vision || capFilter.reasoning || capFilter.tools) {
      list = list.filter((m) => {
        const res = scanIdx[scanKey(normProv(provider), m.id)];
        if (!res) return false;
        return (!capFilter.vision || res.vision_supported) &&
               (!capFilter.reasoning || res.reasoning_supported) &&
               (!capFilter.tools || res.tools_supported);
      });
    }
    let __sorted2 = sortFavFirst(list, (m) => favKey(provider, m.id), favSet);
    // v2026-08-11 — tri par tokens/sec decroissant (non mesures -> fin)
    if (sortTps) {
      __sorted2 = [...__sorted2].sort((a, b) => {
        const ta = scanIdx[scanKey(normProv(provider), a.id)]?.tokens_per_sec ?? -1;
        const tb = scanIdx[scanKey(normProv(provider), b.id)]?.tokens_per_sec ?? -1;
        return tb - ta;
      });
    }
    return __sorted2;
  }, [providerModels, allModels, provider, filter, favSet, displayName, capFilter, scanIdx, sortTps]);

  const apply = async (selProvider: string, selModel: string, target?: number) => {
    const tgt = target ?? applyTarget;
    if (!selModel.trim()) {
      setErr('indiquez un modele');
      return;
    }
    // BUG A (2026-08-11, MANAGER fix) : en mode "Tous les providers",
    // `selProvider` vaut '__all__'. On utilise le provider REEL du modele
    // (memorise via setSelectedModelProvider au clic liste) — comme SCAN.
    // Si rien n'est memorise (champ libre tape sans clic), on refuse
    // proprement plutot que d'envoyer la sentinelle '__all__' au serveur
    // (Unknown provider, casserait le runtime Hermes).
    const effectiveProvider = selProvider === ALL_PROVIDERS ? (selectedModelProvider || '') : selProvider;
    if (!effectiveProvider) {
      setErr('selectionnez un provider dans la liste (ou cliquez un modele)');
      setBusy(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Fallback manager: construit l'ordre complet [défaut, fb1, fb2, fb3].
      // La cible tgt reçoit le modèle sélectionné ; les autres positions
      // conservent leur modèle courant (ordre réordonné par drag & drop).
      const fbToSend: FallbackModel[] = [];
      for (let i = 0; i < 3; i++) {
        const cur = fallbacks[i];
        if (tgt === i + 1) {
          fbToSend.push({ provider: effectiveProvider, model: selModel.trim() });
        } else {
          fbToSend.push(
            cur && cur.model
              ? { provider: cur.provider, model: cur.model, ...(cur.base_url ? { base_url: cur.base_url } : {}) }
              : { provider: effectiveProvider, model: selModel.trim() },
          );
        }
      }
      // BUG FIX: garder le modèle défaut actuel quand on modifie un fallback
      const defaultModel = model?.model || '';
      const defaultProvider = model?.provider || effectiveProvider;
      // Si la cible est le DÉFAUT (0), le model sélectionné devient default
      // et les 3 fallbacks sont envoyés tels quels (ordre réordonné).
      // SINON: garder le default actuel, envoyer les fallbacks mis à jour.
      const fbFinal = tgt === 0
        ? fallbacks.map((f) => ({ provider: f.provider, model: f.model, ...(f.base_url ? { base_url: f.base_url } : {}) }))
        : fbToSend;
      const res = await setAgentModel(
        agent,
        tgt === 0 ? effectiveProvider : defaultProvider,
        tgt === 0 ? selModel.trim() : defaultModel,
        tgt === 0 ? undefined : fbFinal,
      );
      if (!res.ok) {
        setErr(res.error || 'echec ecriture modele');
      } else {
        setModel(res.model ?? { provider: effectiveProvider, model: selModel.trim(), fallbacks: fbFinal });
        setOpen(false);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'erreur reseau');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Changer le modele IA de cet agent"
        className="p-2 bg-stone-950 rounded-lg text-stone-500 hover:text-orange-400 transition-colors"
      >
        <Cpu className="w-4 h-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div
            data-testid="model-selector-modal"
            /* v1.17.76 : largeur +25% (max-w-2xl = 672px -> 840px) pour loger
               le score + V/R/T sans tasser. `w-full` + le padding p-4 du
               parent gardent la modale DANS le viewport sur petit ecran. */
            className="w-full max-w-[840px] max-h-[85vh] overflow-y-auto bg-stone-900 border border-stone-800 rounded-3xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-base font-medium text-stone-200">
                Modele — {agent}
              </span>
              <button
                onClick={() => setOpen(false)}
                className="text-stone-500 hover:text-stone-300 text-xs"
              >
                fermer
              </button>
            </div>

          {err && <p className="text-xs text-red-400 mb-2">{err}</p>}

          {!catalog ? (
            <p className="text-xs text-stone-500">Chargement…</p>
          ) : (
            <>
              <label className="text-[10px] uppercase tracking-widest text-stone-500">
                Provider
              </label>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setSelectedModelProvider(null); // BUG A: réinitialiser le provider mémorisé
                  setErr(null);
                  setLive(null);
                  setFilter('');
                }}
                className="w-full bg-stone-950 border border-stone-800 text-stone-200 rounded-lg px-3 py-2 mt-1 text-sm focus:outline-none focus:border-orange-500"
              >
                {/* vRESTORE (2026-08-11, MANAGER) : ligne "Tous les providers"
                    supprimee lors d'une correction. Recopie du motif ScanTab.
                    Permet d'afficher/choisir tous les modeles agreges des
                    providers cochés en Configuration (ALL_PROVIDERS). */}
                <option value={ALL_PROVIDERS}>Tous les providers ({allModels.length} modèles)</option>
                {Object.entries(catalog.providers)
                  .filter(([k, p]) =>
                    !(p.count === 0) &&                                    // masque TOUT provider sans modele dispo
                    !p.all_blacklisted &&                                  // masque si TOUT blackliste
                    scanProviders[k] === true                              // SEULEMENT providers cochés
                  )
                  .map(([key, p]) => {
                    const okCount = scanList.filter(
                      (r) => normProv(r.provider) === normProv(key) && r.ok === true && !(blacklist[key] || []).includes(r.model)
                    ).length;
                    return (
                      <option key={key} value={key}>
                        {p.display_name || key} · {okCount}
                      </option>
                    );
                  })}
              </select>

              {/* Filter box — live-filters the model list below. */}
              <label className="text-[10px] uppercase tracking-widest text-stone-500 mt-3 block">
                Filtrer
              </label>
              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="tapez pour filtrer la liste…"
                  className="flex-1 bg-stone-950 border border-stone-800 text-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="px-2 text-stone-500 hover:text-stone-300 text-xs"
                    title="effacer le filtre"
                  >
                    x
                  </button>
                )}
              </div>
              {/* v1.17.141 - Filtres capacites + v2026-08-11 tri tok/s (meme ligne)
                  + vMODE-AGENT-SCAN (2026-08-12) : bouton "Scan" a droite qui
                  scanne UNIQUEMENT le modele surligne (defaut) dans la liste. */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 cursor-pointer text-sm text-stone-200">
                    <input
                      type="checkbox"
                      checked={capFilter.vision}
                      onChange={(e) => setCapFilter((prev) => ({ ...prev, vision: e.target.checked }))}
                      className="w-4 h-4 rounded border-stone-600 text-orange-600 focus:ring-orange-500 bg-stone-800"
                    />
                    <Eye className="w-3.5 h-3.5 text-orange-500" /> Vision
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-sm text-stone-200">
                    <input
                      type="checkbox"
                      checked={capFilter.reasoning}
                      onChange={(e) => setCapFilter((prev) => ({ ...prev, reasoning: e.target.checked }))}
                      className="w-4 h-4 rounded border-stone-600 text-blue-500 focus:ring-blue-400 bg-stone-800"
                    />
                    <Brain className="w-3.5 h-3.5 text-blue-400" /> Raison
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-sm text-stone-200">
                    <input
                      type="checkbox"
                      checked={capFilter.tools}
                      onChange={(e) => setCapFilter((prev) => ({ ...prev, tools: e.target.checked }))}
                      className="w-4 h-4 rounded border-stone-600 text-green-500 focus:ring-green-400 bg-stone-800"
                    />
                    <Wrench className="w-3.5 h-3.5 text-green-400" /> Tools
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (model?.provider && model?.model) scanOneModel(model.provider, model.model);
                    }}
                    disabled={
                      busy ||
                      liveBusy ||
                      scanSeqBusy ||
                      !model?.provider ||
                      !model?.model ||
                      scanBusyKey === `${model.provider}::${model.model}`
                    }
                    title={
                      model?.provider && model?.model
                        ? `Scanner le modele surligne (${model.provider} / ${model.model})`
                        : 'Selectionnez un modele'
                    }
                    className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                      model?.provider && model?.model
                        ? 'bg-orange-600 border-orange-700 text-white hover:bg-orange-500'
                        : 'bg-stone-950 border-stone-800 text-stone-600 cursor-not-allowed'
                    }`}
                  >
                    {scanBusyKey === `${model?.provider}::${model?.model}` ? (
                      <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    Scan
                  </button>
                  {model?.provider && model?.model && (
                    <span className="text-[10px] text-stone-500 whitespace-nowrap">
                      Dernier scan : {fmtScan(scanIdx[scanKey(normProv(model.provider), model.model)]?.last_checked)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSortTps((v) => !v)}
                    className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                      sortTps
                        ? 'bg-orange-900/30 border-orange-700/60 text-orange-200'
                        : 'bg-stone-950 border-stone-800 text-stone-400 hover:text-stone-200'
                    }`}
                    title="Trier les modeles par tokens/seconde (du plus rapide au plus lent)"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    {sortTps ? 'Tri: tok/s ↓' : 'Tri: tok/s'}
                  </button>
                </div>
              </div>

              {/* Modele list (clickable) — shown whenever a live/known list exists. */}
              <label className="text-[10px] uppercase tracking-widest text-stone-500 mt-3 block">
                Modele {liveBusy ? '(chargement…)' : ''}
                {filter && !liveBusy
                  ? ` — ${filteredModels.length} resultat(s)`
                  : ''}
              </label>
              <div className="max-h-48 overflow-y-auto mt-1 space-y-1 pr-1">
                {filteredModels.map((m) => {
                  const mProvider = m.provider ?? provider;
                  const selected = model?.model === m.id && model?.provider === mProvider;
                  // Si ce modele (selectionne) est dans la blacklist, on le marque.
                  const blHere = selected && (blacklist[mProvider] || []).includes(m.id);
                  const fkey = favKey(mProvider, m.id);
                  const isFav = favSet.has(fkey);
                  return (
                    <button
                      key={`${mProvider}::${m.id}`}
                      disabled={busy || liveBusy}
                      onClick={() => {
                        // Fallback manager: le clic met a jour la LIGNE CIBLE
                        // (radio: Defaut / Fallback 1/2/3) en memoire, sans
                        // fermer. La sauvegarde disque ne se fait qu'au OK.
                        // BUG A FIX: mémoriser le provider réel du modèle sélectionné
                        // (pas celui du filtre qui peut être "__all__")
                        const mProvider = m.provider ?? provider;
                        const mdl = m.id;
                        setSelectedModelProvider(mProvider); // mémorise pour l'appel apply()
                        if (applyTarget === 0) {
                          setModel((prev) => ({ ...(prev || {}), provider: mProvider, model: mdl }));
                        } else {
                          setFallbacks((prev) => {
                            const next = (prev || []).slice(0, 3);
                            while (next.length < 3) next.push({ provider: '', model: '' });
                            next[applyTarget - 1] = { provider: mProvider, model: mdl };
                            return next;
                          });
                        }
                        setFreeformModel(mdl);
                      }}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between transition-colors ${
                        selected
                          ? 'bg-orange-900/30 border border-orange-700/50 text-orange-200'
                          : 'hover:bg-stone-800 text-stone-300'
                      }`}
                    >
                      <span className="truncate flex-1 min-w-0">
                        <span
                          role="button"
                          title={isFav ? 'retirer des favoris' : 'ajouter aux favoris'}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setFavs((prev) => toggleFav(agent, prev, fkey));
                          }}
                          className={`mr-2 text-xs cursor-pointer ${
                            isFav ? 'text-amber-400' : 'text-stone-600 hover:text-amber-300'
                          }`}
                        >
                          {isFav ? '★' : '☆'}
                        </span>
                        {m.provider ? `${m.provider} / ${m.id}` : m.id}
                        {m.description ? (
                          <span className="block text-[10px] text-stone-500 truncate">
                            {m.description}
                          </span>
                        ) : null}
                      </span>
                      {/* v1.17.76 : tokens/sec + score du scan + capacites prouvees V/R/T */}
                      <span className="flex items-center gap-2 shrink-0 ml-2">
                        {(() => {
                          const sr = scanIdx[scanKey(mProvider, m.id)];
                          const tps = sr?.tokens_per_sec;
                          return typeof tps === 'number' ? (
                            <span className="text-[10px] text-stone-400 font-mono tabular-nums whitespace-nowrap" title="Tokens par seconde">
                              {tps.toFixed(1)}<span className="opacity-60"> tok/s</span>
                            </span>
                          ) : null;
                        })()}
                        <MsScoreBadge res={scanIdx[scanKey(mProvider, m.id)]} />
                        <MsCaps res={scanIdx[scanKey(mProvider, m.id)]} />
                      </span>
                      {blHere ? (
                        <Ban className="w-3.5 h-3.5 shrink-0 text-red-400" />
                      ) : selected ? (
                        <Check className="w-3.5 h-3.5 shrink-0" />
                      ) : null}
                    </button>
                  );
                })}
                {!liveBusy && filteredModels.length === 0 && (
                  <p className="text-[10px] text-stone-600 py-1">
                    {filter
                      ? 'Aucun modele ne correspond au filtre.'
                      : 'Aucune liste disponible pour ce provider (pas de cle/api ou endpoint injoignable).'}
                  </p>
                )}
              </div>

              {/* Free-form field — ALWAYS available as a fallback / override. */}
              <label className="text-[10px] uppercase tracking-widest text-stone-500 mt-3 block">
                Id exact (fallback){isFreeform ? '' : ' — option'}
              </label>
              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  value={freeformModel}
                  onChange={(e) => setFreeformModel(e.target.value)}
                  placeholder="ex: gemini-2.5-flash ou tencent/hy3:free"
                  className="flex-1 bg-stone-950 border border-stone-800 text-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500"
                />
                <button
                  disabled={busy || !freeformModel.trim()}
                  onClick={() => apply(selectedModelProvider ?? provider, freeformModel)}
                  className="bg-orange-600 text-white rounded-lg px-3 py-2 text-sm hover:bg-orange-500 disabled:opacity-50 transition-colors"
                >
                  OK
                </button>
              </div>
              {/* Fallback manager (2026-08-03, MANAGER): défaut + 3 fallbacks,
                  réordonnables par glisser-déposer, cible d'application par radio
                  + vMODE-AGENT-SCAN (2026-08-12): bouton "Scanner cet agent"
                  (scan SEQUENTIEL defaut + fallbacks) + date/heure dernier scan. */}
              <div className="mt-4 border-t border-stone-800 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] uppercase tracking-widest text-stone-400 font-semibold">
                    Modele par defaut + fallbacks
                  </span>
                  <span className="text-[10px] text-stone-500">
                    glisser pour reordonner · radio = cible
                  </span>
                </div>
                {scanErr && (
                  <p className="text-[10px] text-amber-400 mb-2">
                    Scan : {scanErr}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => scanSequentialAgent()}
                  disabled={busy || liveBusy || scanSeqBusy}
                  title="Scan sequentiel du modele par defaut + de tous les fallbacks (un par un)"
                  className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors mb-2 ${
                    busy || liveBusy || scanSeqBusy
                      ? 'bg-orange-900/30 border-orange-700/60 text-orange-300 animate-pulse cursor-not-allowed'
                      : 'bg-orange-600 border-orange-700 text-white hover:bg-orange-500'
                  }`}
                >
                  {scanSeqBusy ? (
                    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                  ) : (
                    <Zap className="w-3.5 h-3.5" />
                  )}
                  Scanner cet agent
                </button>
                {(() => {
                  const def = model;
                  const rows: { label: string; prov: string; mdl: string; idx: number }[] = [
                    {
                      label: 'Defaut',
                      prov: def?.provider || '',
                      mdl: def?.model || '',
                      idx: 0,
                    },
                    ...fallbacks.slice(0, 3).map((f, i) => ({
                      label: `Fallback ${i + 1}`,
                      prov: f.provider || '',
                      mdl: f.model || '',
                      idx: i + 1,
                    })),
                  ];
                  const move = (from: number, to: number) => {
                    if (from === to) return;
                    const defModel = model;
                    
                    // Promotion: fallback at slot 'from' becomes new default (slot 0),
                    // old default gets pushed to that fallback slot
                    if (to === 0) {
                      const promotedItem = fallbacks[from - 1];
                      if (!promotedItem) return;
                      // Build new fallbacks array: insert old default at position from-1
                      const newFallbacks = [...fallbacks.slice(0, 3)];
                      newFallbacks[from - 1] = { provider: defModel?.provider || '', model: defModel?.model || '' };
                      setFallbacks(newFallbacks);
                      // Set promoted item as new default
                      setModel({ provider: promotedItem.provider, model: promotedItem.model, fallbacks: newFallbacks });
                    } else if (from === 0) {
                      // Rétrogradation: default descends to slot 'to', promoted FB1 becomes new default
                      const movedItem = defModel;
                      if (!movedItem) return;
                      // Push old default to the target fallback slot
                      setFallbacks([movedItem, ...fallbacks.slice(0, 2)]);
                      // Set the fallback that was at slot 'to' as new default
                      setModel(fallbacks[to - 1]);
                    } else {
                      // Déplacement entre fallbacks: case existing
                      const arr = fallbacks.slice(0, 3);
                      const [it] = arr.splice(from - 1, 1);
                      arr.splice(to - 1, 0, it);
                      setFallbacks(arr);
                    }
                  };
                  return (
                    <div className="space-y-1.5">
                      {rows.map((r) => (
                        <div
                          key={r.idx}
                          draggable={r.idx > 0}
                          onDragStart={() => setDragIdx(r.idx)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (r.idx > 0) setDropIdx(r.idx);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragIdx !== null && dropIdx !== null && dragIdx > 0 && dropIdx > 0) {
                              move(dragIdx, dropIdx);
                            }
                            setDragIdx(null);
                            setDropIdx(null);
                          }}
                          onDragEnd={() => {
                            setDragIdx(null);
                            setDropIdx(null);
                          }}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                            dropIdx === r.idx
                              ? 'border-orange-500 bg-orange-900/20'
                              : r.idx === applyTarget
                                ? 'border-orange-800/60 bg-orange-900/10'
                                : 'border-stone-800 hover:bg-stone-800/40'
                          } ${r.idx > 0 ? 'cursor-grab active:cursor-grabbing' : ''}`}
                        >
                          <input
                            type="radio"
                            name="applyTargetMs"
                            checked={applyTarget === r.idx}
                            onChange={() => setApplyTarget(r.idx)}
                            className="h-3.5 w-3.5 accent-orange-500"
                            title="Appliquer la selection du haut a cette position"
                          />
                          <span className="text-[11px] text-stone-400 w-20 shrink-0">
                            {r.idx > 0 ? `⇕ ${r.label}` : r.label}
                          </span>
                          <div className="flex-1 min-w-0 font-mono text-[11px] text-stone-300 truncate">
                            {r.prov ? (
                              <>
                                <span className="text-orange-400/80">{r.prov}</span>
                                <span className="text-stone-500"> / </span>
                                {r.mdl}
                              </>
                            ) : (
                              <span className="text-stone-600 italic">(vide)</span>
                            )}
                            {/* vMODE-AGENT-SCAN (2026-08-12) : double ligne —
                                sous-ligne grise = date/heure du dernier scan (permanent). */}
                            <span className="block text-[10px] text-stone-500 normal-case font-sans truncate">
                              Dernier scan : {fmtScan(scanIdx[scanKey(r.prov, r.mdl)]?.last_checked)}
                            </span>
                          </div>
                          {/* v1.17.76 : tokens/sec + score + V/R/T sur les lignes
                              Defaut / Fallback 1..3 (vide -> rien). */}
                          {r.prov && r.mdl ? (
                            <span className="flex items-center gap-2 shrink-0">
                              {(() => {
                                const sr = scanIdx[scanKey(r.prov, r.mdl)];
                                const tps = sr?.tokens_per_sec;
                                return typeof tps === 'number' ? (
                                  <span className="text-[10px] text-stone-400 font-mono tabular-nums whitespace-nowrap" title="Tokens par seconde">
                                    {tps.toFixed(1)}<span className="opacity-60"> tok/s</span>
                                  </span>
                                ) : null;
                              })()}
                              <MsScoreBadge res={scanIdx[scanKey(r.prov, r.mdl)]} />
                              <MsCaps res={scanIdx[scanKey(r.prov, r.mdl)]} />
                            </span>
                          ) : null}
                          {(() => {
                            const rfkey = r.prov && r.mdl ? favKey(r.prov, r.mdl) : '';
                            const rIsFav = rfkey ? favSet.has(rfkey) : false;
                            return (
                              rfkey && (
                                <button
                                  type="button"
                                  title={rIsFav ? 'retirer des favoris' : 'ajouter aux favoris'}
                                  onClick={() => setFavs((prev) => toggleFav(agent, prev, rfkey))}
                                  className={`text-sm shrink-0 ${rIsFav ? 'text-amber-400' : 'text-stone-600 hover:text-amber-300'}`}
                                >
                                  {rIsFav ? '★' : '☆'}
                                </button>
                              )
                            );
                          })()}
                          {r.idx > 0 && (
                            <div className="flex gap-1 shrink-0">
                              <button
                                type="button"
                                title="Monter"
                                disabled={r.idx === 1 || busy}
                                onClick={() => move(r.idx, r.idx - 1)}
                                className="px-1.5 text-stone-500 hover:text-stone-200 disabled:opacity-30"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                title="Descendre"
                                disabled={r.idx === 3 || busy}
                                onClick={() => move(r.idx, r.idx + 1)}
                                className="px-1.5 text-stone-500 hover:text-stone-200 disabled:opacity-30"
                              >
                                ↓
                              </button>
                            </div>
                          )}
                          {r.idx === 0 && (
                            <div className="flex gap-1 shrink-0">
                              <button
                                type="button"
                                title="Descendre en fallback 1"
                                disabled={busy}
                                onClick={() => move(0, 1)}
                                className="px-1.5 text-stone-500 hover:text-stone-200 disabled:opacity-30"
                              >
                                ↓
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                      <p className="text-[10px] text-stone-600 pt-1">
                        Selectionnez un modele en haut, choisissez la cible (radio) puis
                        « OK ». Le glisser-deposer permute les fallbacks.
                      </p>
                    </div>
                  );
                })()}
              </div>

              <p className="text-[10px] text-stone-600 mt-2 leading-relaxed">
                Liste live des modeles du provider quand disponible; sinon
                saisissez l'id exact (ex: tencent/hy3:free).
              </p>
            </>
          )}
          </div>
        </div>
      )}
    </div>
  );
};