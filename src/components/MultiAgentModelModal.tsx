import React, { useEffect, useMemo, useState } from 'react';
import { filterModels } from '../lib/filterModels';
import {
  getModelCatalog,
  getProviderModels,
  type ModelCatalog,
  type CatalogProvider,
  type ProviderModels,
  getAgentModelBatch,
  setAgentModelBatch,
  type AgentModel,
  type AgentModelBatchResult,
  type AgentModelBatchResponse,
  getBlacklist,
  type BlacklistMap,
  getState,
  getScanResults,
  type ScanModelResult,
  calculateModelScore,
  type ModelScore,
} from '../api';
import { FLEET_STATIC, type FleetMeta } from '../types';
import { Check, X, Ban, Eye, Brain, Wrench, Zap } from 'lucide-react';
import { favKey, sortFavFirst } from '../modelFavorites';
import { getMcFavs, setMcFavs } from '../api';

const ALL_PROVIDERS = '__all__';

interface Props {
  open: boolean;
  onClose: () => void;
}

export const MultiAgentModelModal: React.FC<Props> = ({ open, onClose }) => {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [provider, setProvider] = useState<string>(ALL_PROVIDERS);
  const [model, setModel] = useState<string>('');
  const [modelProvider, setModelProvider] = useState<string>('');
  const [freeformModel, setFreeformModel] = useState<string>('');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AgentModelBatchResult>>({});
  const [live, setLive] = useState<ProviderModels | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [filter, setFilter] = useState<string>('');
  // v1.17.141 - Filtres capacites Vision/Raison/Tools (AND).
  const [capFilter, setCapFilter] = useState<{ vision: boolean; reasoning: boolean; tools: boolean }>({
    vision: false, reasoning: false, tools: false
  });
  // v2026-08-11 — Tri optionnel par tokens/sec (bouton sur la meme ligne que
  // les filtres capacite). Quand actif, liste triee par tok/s decroissant.
  const [sortTps, setSortTps] = useState(false);
  const [blacklist, setBlacklist] = useState<BlacklistMap>({});
  // Providers cochés dans l'onglet Configuration (scan_providers).
  const [scanProviders, setScanProviders] = useState<Record<string, boolean>>({});
  const [currentModels, setCurrentModels] = useState<Record<string, AgentModel | null>>({});
  const [scanResults, setScanResults] = useState<Record<string, ScanModelResult>>({});

  // POINT 1 (2026-08-01, DEVELOPPEUR) — liste d'agents DYNAMIQUE.
  // La modale listait FLEET_STATIC (constante figee) : tout agent cree apres
  // coup (ex: `agentique`) etait invisible. On lit desormais la flotte REELLE
  // depuis /api/state (`fleet`, alimente par fleet_keys_ordered() cote
  // serveur, donc toujours a jour si un agent est ajoute/supprime).
  // FLEET_STATIC ne sert plus que de repli hors-ligne (fetch KO).
  const [dynFleet, setDynFleet] = useState<FleetMeta[] | null>(null);
  const fleetList = useMemo<FleetMeta[]>(
    () => (dynFleet && dynFleet.length ? dynFleet : FLEET_STATIC),
    [dynFleet],
  );

  // Favoris: agent de reference = 1er agent selectionne (ordre de la flotte).
  const agentRef = useMemo(
    () => fleetList.map((m) => m.agent).find((a) => selectedAgents.has(a)) ?? '',
    [selectedAgents, fleetList],
  );
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!agentRef) {
      setFavs([]);
      return;
    }
    getMcFavs(agentRef).then((ids) => {
      if (!cancelled) setFavs(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [agentRef, open]);
  const favSet = useMemo(() => new Set(favs), [favs]);
  const toggleFavorite = (key: string) => {
    setFavs((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    // Le favori est stocke pour CHAQUE agent selectionne (par agent, pas global).
    for (const a of Array.from(selectedAgents)) {
      void (async () => {
        const cur = await getMcFavs(a);
        const upd = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
        await setMcFavs(a, upd);
      })();
    }
  };

  // Load catalog + per-agent current model + blacklist when modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setErr(null);
    setResults({});
    setSelectedAgents(new Set());
    setModel('');
    setModelProvider('');
    setFreeformModel('');
    setFilter('');
    setBlacklist({});
    setCurrentModels({});
    setScanResults({});
    setProvider('');
    Promise.all([
      getModelCatalog(),
      getBlacklist(),
      getScanResults(),
    ])
      .then(async ([cat, bl, sr]) => {
        if (cancelled) return;
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
        // Index scan results by "provider::model" for fast lookup
        const srMap: Record<string, ScanModelResult> = {};
        for (const r of sr.results || []) {
          const key = `${r.provider || ''}::${r.model}`;
          srMap[key] = r;
        }
        setScanResults(srMap);
        setProvider(ALL_PROVIDERS);
      })
      .catch(() => !cancelled && setErr('lecture catalogue impossible'));
    // POINT 1b: flotte reelle (11 agents au 2026-08-01, dont `agentique`).
    getState()
      .then((st) => {
        if (cancelled) return;
        const fl = (st.fleet || [])
          .filter((a) => a && a.agent)
          .map((a) => {
            const stat = FLEET_STATIC.find((m) => m.agent === a.agent);
            return {
              agent: a.agent,
              name: a.name || stat?.name || a.agent,
              role: a.role || stat?.role || a.agent,
              description: stat?.description ?? '',
            } as FleetMeta;
          });
        if (fl.length) setDynFleet(fl);
      })
      .catch(() => { /* repli silencieux sur FLEET_STATIC */ });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Live-fetch models for selected provider.
  useEffect(() => {
    if (!open || !provider || provider === ALL_PROVIDERS) {
      setLive(null);
      return;
    }
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

  const providerMeta: CatalogProvider | undefined = useMemo(
    () => (catalog && provider ? catalog.providers[provider] : undefined),
    [catalog, provider],
  );

  const providerBlacklist = useMemo(() => new Set(blacklist[provider] || []), [blacklist, provider]);

  const isFreeform = useMemo(() => {
    if (provider === ALL_PROVIDERS) return true;
    if (live && live.provider === provider) return !!live.freeform;
    return !!providerMeta?.freeform;
  }, [live, provider, providerMeta]);

  const normProv = (p?: string | null): string => {
    const s = (p || '').replace(/^custom:/i, '').trim().toLowerCase();
    if (s === 'omni route' || s === 'omni_route' || s === 'omniroute') {
      return 'omni-route';
    }
    return s.replace(/\s+/g, '-').replace(/_/g, '-');
  };

  const providerModels = useMemo(() => {
    if (provider === ALL_PROVIDERS) {
      return [];
    }
    const key = normProv(provider);
    const out: { id: string; description?: string; provider?: string; display?: string }[] = [];
    for (const r of Object.values(scanResults)) {
      if (normProv(r.provider) !== key) continue;
      if (r.ok !== true) continue;
      const bl = new Set(blacklist[provider] || []);
      if (bl.has(r.model)) continue;
      out.push({ id: r.model, description: r.reason, provider, display: providerMeta?.display_name || provider, ...(r as any) });
    }
    return out;
  }, [scanResults, provider, providerMeta, blacklist]);

  // vRESTORE (2026-08-11) : source = scan_results.db (via getScanResults,
  // deja charge dans `scanResults`), PAS catalog.providers (qui ne porte que
  // les `count`, jamais la liste réelle -> donnait 0 modèle). "Tous les
  // providers" = modèles OK des providers cochés en Configuration, hors
  // blacklist. ~140 modèles dispo (cohérent avec le bandeau SCAN "X OK").
  const allModels = useMemo(() => {
    if (!scanResults) return [];
    const out: { provider: string; id: string; description?: string; tokens_per_sec?: number; latency_ms?: number; ok?: boolean; reason?: string; vision_supported?: boolean; reasoning_supported?: boolean; tools_supported?: boolean }[] = [];
    for (const r of Object.values(scanResults)) {
      const key = (r.provider || '').trim();
      if (!key || !r.model) continue;
      if (!(scanProviders[key] === true)) continue;   // SEULEMENT providers cochés
      if (r.ok !== true) continue;                     // SEULEMENT modèles OK (disponibles)
      const bl = new Set(blacklist[key] || []);
      if (bl.has(r.model)) continue;                    // hors blacklist
      out.push({ provider: key, id: r.model, ...(r as any) });
    }
    return out;
  }, [scanResults, scanProviders, blacklist]);

  const displayedModels = useMemo(() => {
    if (provider === ALL_PROVIDERS) {
      const src = allModels;
      let list = filterModels(src, filter);
      // v1.17.141 - Filtres capacites Vision/Raison/Tools (AND).
      if (capFilter.vision || capFilter.reasoning || capFilter.tools) {
        list = list.filter((m) => {
          const srKey = `${m.provider}::${m.id}`;
          const res = scanResults[srKey];
          if (!res) return false;
          return (!capFilter.vision || res.vision_supported) &&
                 (!capFilter.reasoning || res.reasoning_supported) &&
                 (!capFilter.tools || res.tools_supported);
        });
      }
      let sortedAll = sortFavFirst(list.map((m) => ({ ...m, label: `${m.provider} / ${m.id}` })), (m) => favKey(m.provider, m.id), favSet);
      // v2026-08-11 — tri par tokens/sec decroissant (non mesures -> fin)
      if (sortTps) {
        sortedAll = [...sortedAll].sort((a, b) => {
          const ta = a.tokens_per_sec ?? -1;
          const tb = b.tokens_per_sec ?? -1;
          return tb - ta;
        });
      }
      return sortedAll;
      }
    const src = providerModels;
    let list = filterModels(src, filter);
    // v1.17.141 - Filtres capacites Vision/Raison/Tools (AND).
    if (capFilter.vision || capFilter.reasoning || capFilter.tools) {
      list = list.filter((m) => {
        const srKey = `${provider}::${m.id}`;
        const res = scanResults[srKey];
        if (!res) return false;
        return (!capFilter.vision || res.vision_supported) &&
               (!capFilter.reasoning || res.reasoning_supported) &&
               (!capFilter.tools || res.tools_supported);
      });
    }
    let sortedProv = sortFavFirst(list.map((m) => ({ ...m, label: m.id })), (m) => favKey(provider, m.id), favSet);
    // v2026-08-11 — tri par tokens/sec decroissant (non mesures -> fin)
    if (sortTps) {
      sortedProv = [...sortedProv].sort((a, b) => {
        const ta = scanResults[`${provider}::${a.id}`]?.tokens_per_sec ?? -1;
        const tb = scanResults[`${provider}::${b.id}`]?.tokens_per_sec ?? -1;
        return tb - ta;
      });
    }
    return sortedProv;
  }, [providerModels, allModels, provider, filter, favSet, capFilter, scanResults, sortTps]);

  const toggleAgent = (agent: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedAgents(new Set(fleetList.map((m) => m.agent)));
  };

  const selectNone = () => {
    setSelectedAgents(new Set());
  };

  const apply = async () => {
    let selModel = model.trim() || freeformModel.trim();
    if (!selModel) {
      setErr('indiquez un modèle');
      return;
    }
    if (selectedAgents.size === 0) {
      setErr('sélectionnez au moins un agent');
      return;
    }
    let selProvider = provider === ALL_PROVIDERS ? modelProvider : provider;
    if (!selProvider && selModel.includes(' / ')) {
      const [maybeProvider, maybeModel] = selModel.split(' / ');
      if (maybeProvider && maybeModel) {
        selProvider = maybeProvider.trim();
        selModel = maybeModel.trim();
      }
    }
    if (selProvider === ALL_PROVIDERS) {
      setErr('sélectionnez un modèle valide dans la liste');
      return;
    }
    if (!selProvider) {
      setErr('sélectionnez un provider ou un modèle');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await setAgentModelBatch(
        Array.from(selectedAgents),
        selProvider,
        selModel,
      );
      // L'API renvoie un TABLEAU [{agent, ok, ...}] ; l'etat attend une MAP
      // agent -> resultat (le rendu fait `results[meta.agent]`). Conversion
      // explicite (audit 2026-08-07 : typecheck echouait).
      setResults(
        Object.fromEntries(
          res.results
            .filter((r) => r.agent)
            .map((r) => [r.agent as string, r]),
        ),
      );
      if (res.results.some((r) => r.ok)) {
        setTimeout(onClose, 400);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'erreur réseau');
    } finally {
      setBusy(false);
    }
  };

  // Per-agent live status (optional load-on-open)
  useEffect(() => {
    if (!open || selectedAgents.size === 0) {
      setResults({});
      return;
    }
    let cancelled = false;
    getAgentModelBatch(Array.from(selectedAgents))
      .then((res) => {
        if (cancelled) return;
        // Not displayed directly, but we could show current state if needed.
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, selectedAgents]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-stone-900 border border-stone-800 rounded-3xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <span className="text-base font-medium text-stone-200">
            Modèle multi-agent
          </span>
          <button
            onClick={onClose}
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
            {/* Provider + Model */}
            <label className="text-[10px] uppercase tracking-widest text-stone-500 block">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel('');
                setFreeformModel('');
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
                   const okCount = Object.values(scanResults).filter(
                     (r) => normProv(r.provider) === normProv(key) && r.ok === true && !(blacklist[key] || []).includes(r.model)
                   ).length;
                   return (
                     <option key={key} value={key}>
                       {p.display_name || key} · {okCount}
                     </option>
                   );
                 })}
            </select>

            {/* Filter */}
            <label className="text-[10px] uppercase tracking-widest text-stone-500 mt-3 block">
              Filtrer les modèles
            </label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="tapez pour filtrer…"
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
            {/* v1.17.141 - Filtres capacites + v2026-08-11 tri tok/s (meme ligne) */}
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

            {/* Live list */}
            <label className="text-[10px] uppercase tracking-widest text-stone-500 mt-3 block">
              Modèle {liveBusy ? '(chargement…)' : ''}
              {filter && !liveBusy ? ` — ${displayedModels.length} résultat(s)` : ''}
            </label>
            <div className="max-h-48 overflow-y-auto mt-1 space-y-1 pr-1">
              {displayedModels.map((m) => {
                const mProvider = (m as any).provider ?? provider;
                const displayLabel = (m as any).label || m.id;
                const selected = model === m.id && (provider === ALL_PROVIDERS ? modelProvider === mProvider : true);
                const fkey = favKey(mProvider, m.id);
                const isFav = favSet.has(fkey);
                return (
                  <button
                    key={`${mProvider}::${m.id}`}
                    disabled={busy || liveBusy}
                    onClick={() => {
                      setModel(m.id);
                      setModelProvider(mProvider);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between transition-colors ${
                      selected
                        ? 'bg-orange-900/30 border border-orange-700/50 text-orange-200'
                        : 'hover:bg-stone-800 text-stone-300'
                    }`}
                  >
                    <span className="truncate">
                      <span
                        role="button"
                        title={
                          agentRef
                            ? isFav
                              ? 'retirer des favoris'
                              : 'ajouter aux favoris'
                            : 'selectionnez un agent pour gerer les favoris'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          if (agentRef) toggleFavorite(fkey);
                        }}
                        className={`mr-2 text-xs cursor-pointer ${
                          isFav ? 'text-amber-400' : 'text-stone-600 hover:text-amber-300'
                        }`}
                      >
                        {isFav ? '\u2605' : '\u2606'}
                      </span>
                      {displayLabel}
                      {m.description ? (
                        <span className="block text-[10px] text-stone-500 truncate">
                          {m.description}
                        </span>
                      ) : null}
                    </span>
                    {/* Scan data: tokens/sec + score + V/R/T — from scanResults (provider-specific) OR model's own data */}
                    {(() => {
                      const srKey = `${mProvider}::${m.id}`;
                      const srFromStore = scanResults[srKey];
                      const mAny = m as any;
                      // Prefer scanResults (enriched via provider-specific endpoint), fall back to model's own data
                      const sr = srFromStore || (mAny.tokens_per_sec != null || mAny.vision_supported != null ? mAny : null);
                      if (!sr) return selected ? <Check className="w-3.5 h-3.5 shrink-0" /> : null;
                      const score = calculateModelScore({
                        latency_ms: sr.latency_ms ?? null,
                        ok: sr.ok ?? false,
                        error: sr.reason ?? null,
                        tokens_per_sec: sr.tokens_per_sec ?? null,
                        vision_supported: sr.vision_supported,
                        reasoning_supported: sr.reasoning_supported,
                        tools_supported: sr.tools_supported,
                      });
                      const letterColor = ({ A: 'text-emerald-400', B: 'text-blue-400', C: 'text-amber-400', D: 'text-red-400' } as Record<string, string>)[score.score_letter] ?? 'text-stone-400';
                      const tps = typeof sr.tokens_per_sec === 'number' ? sr.tokens_per_sec : null;
                      return (
                        <span className="flex items-center gap-1.5 shrink-0">
                          {tps !== null && (
                            <span className="text-[10px] text-stone-400 font-mono tabular-nums" title="Tokens par seconde">
                              {tps.toFixed(1)}<span className="opacity-60"> tok/s</span>
                            </span>
                          )}
                          <span className={`text-[10px] font-medium ${letterColor}`} title={`Score: ${score.score}${score.score_letter}`}>
                            {score.score}{score.score_letter}
                          </span>
                          {sr.vision_supported && <span className="text-[10px] text-teal-400" title="Vision">V</span>}
                          {sr.reasoning_supported && <span className="text-[10px] text-teal-400" title="Raisonnement">R</span>}
                          {sr.tools_supported && <span className="text-[10px] text-teal-400" title="Tools">T</span>}
                          {sr.cap_neterr === true && (
                            <>
                              {!sr.vision_supported && <span className="text-[10px] text-amber-500" title="Vision : à revérifier (réseau)">⟳</span>}
                              {!sr.reasoning_supported && <span className="text-[10px] text-amber-500" title="Raisonnement : à revérifier (réseau)">⟳</span>}
                              {!sr.tools_supported && <span className="text-[10px] text-amber-500" title="Tools : à revérifier (réseau)">⟳</span>}
                            </>
                          )}
                          {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
                        </span>
                      );
                    })()}
                  </button>
                );
              })}
              {!liveBusy && displayedModels.length === 0 && (
                <p className="text-[10px] text-stone-600 py-1">
                  {filter
                    ? 'Aucun modèle ne correspond au filtre.'
                    : 'Aucune liste disponible pour ce provider.'}
                </p>
              )}
            </div>

            {/* Freeform model field */}
            <label className="text-[10px] uppercase tracking-widest text-stone-500 mt-3 block">
              Id exact{isFreeform ? '' : ' — option'}
            </label>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                value={freeformModel}
                onChange={(e) => setFreeformModel(e.target.value)}
                placeholder="ex: gemini-2.5-flash ou tencent/hy3:free"
                className="flex-1 bg-stone-950 border border-stone-800 text-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500"
              />
            </div>

            {/* Agent list */}
            <div className="flex items-center justify-between mt-5 mb-2">
              <label className="text-[10px] uppercase tracking-widest text-stone-500">
                Agents à modifier
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  disabled={busy}
                  className="px-2 py-1 text-[10px] text-stone-400 hover:text-stone-200 border border-stone-800 rounded transition-colors disabled:opacity-50"
                >
                  Tout cocher
                </button>
                <button
                  type="button"
                  onClick={selectNone}
                  disabled={busy}
                  className="px-2 py-1 text-[10px] text-stone-400 hover:text-stone-200 border border-stone-800 rounded transition-colors disabled:opacity-50"
                >
                  Tout décocher
                </button>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto space-y-1 pr-1 bg-stone-950/50 border border-stone-800 rounded-xl p-2">
              {fleetList.map((meta) => {
                const checked = selectedAgents.has(meta.agent);
                return (
                  <label
                    key={meta.agent}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                      checked
                        ? 'bg-orange-900/20 border border-orange-900/40'
                        : 'hover:bg-stone-800 border border-transparent'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAgent(meta.agent)}
                      disabled={busy}
                      className="h-4 w-4 rounded border-stone-600 bg-stone-800 text-orange-500 focus:ring-orange-500 disabled:opacity-50"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-stone-200 truncate">
                        {meta.name}
                      </p>
                      <p className="text-[10px] text-stone-500 truncate">
                        {meta.role}
                      </p>
                    </div>
                    {results[meta.agent] && (
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${
                          results[meta.agent].ok
                            ? 'text-green-400'
                            : 'text-red-400'
                        }`}
                      >
                        {results[meta.agent].ok ? (
                          <>
                            <Check className="w-3 h-3" /> ok
                          </>
                        ) : (
                          <>
                            <X className="w-3 h-3" /> erreur
                          </>
                        )}
                      </span>
                    )}
                    {results[meta.agent]?.error && (
                      <span className="text-[10px] text-red-500 max-w-[160px] truncate">
                        {results[meta.agent].error}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            {/* Apply button */}
            <div className="flex justify-end mt-5 gap-3">
              <button
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 border border-stone-800 rounded-lg transition-colors disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={apply}
                disabled={busy || selectedAgents.size === 0}
                className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-500 disabled:opacity-50 transition-colors"
              >
                {busy ? 'Application…' : 'Appliquer'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
