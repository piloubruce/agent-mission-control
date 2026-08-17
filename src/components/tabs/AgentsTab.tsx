import React, { useEffect, useMemo, useState } from 'react';
import { useApiState } from '../../api';
import { getAgentsOrder, setAgentsOrder } from '../../api';
import { FLEET_STATIC } from '../../types';
import { Zap } from 'lucide-react';
import { ModelSelector } from '../ModelSelector';
import { MultiAgentModelModal } from '../MultiAgentModelModal';
import { CreateAgentModal } from '../CreateAgentModal';
import { SkillManagerModal } from '../SkillManagerModal';
import { agentStatusFromStrings, agentStatusClasses } from '../../types';
import { useDndOrder } from '../../lib/useDndOrder';

export const AgentsTab: React.FC<{ onAgentClick?: (agent: string) => void }> = ({ onAgentClick }) => {
  const { state, connected, error, refresh } = useApiState();
  const [multiModalOpen, setMultiModalOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [skillAgent, setSkillAgent] = useState<string | null>(null);
  const [batchModels, setBatchModels] = useState<Record<string, { model?: string; provider?: string }>>({});

  const fleet = state?.fleet ?? [];
  const workingAgents = state?.working_agents ?? [];
  const waitingAgents = state?.waiting_agents ?? [];
  const logsStats = state?.agentlogs_stats;

  // Backfill models: if a fleet card has no defaultModel/modelProvider, try the
  // dedicated /api/agent/model endpoint to read the Hermes profile config.
  // This avoids "—" when /api/state has no cached model yet.
  useEffect(() => {
    let cancelled = false;
    const agents = Array.from(new Set((fleet.length ? fleet : FLEET_STATIC).map((m) => m.agent)));
    if (!agents.length) return;
    fetch('/api/agent/model/batch')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (cancelled) return;
        const next: Record<string, { model?: string; provider?: string }> = {};
        const items = Array.isArray(data?.results) ? data.results : [];
        for (const item of items) {
          if (!item || typeof item.agent !== 'string') continue;
          const model = typeof item.model === 'string' && item.model.trim() ? item.model.trim() : undefined;
          const provider = typeof item.provider === 'string' && item.provider.trim() ? item.provider.trim() : undefined;
          if (model || provider) next[item.agent] = { model, provider };
        }
        setBatchModels(next);
      })
      .catch(() => { if (!cancelled) setBatchModels({}); });
    return () => { cancelled = true; };
  }, [fleet.length ? fleet.map((m) => m.agent).join(',') : '']);

  const enrichedFleet = useMemo(() => {
    const source = fleet.length ? fleet : FLEET_STATIC;
    return source.map((item) => {
      const existingModel = typeof item.defaultModel === 'string' ? item.defaultModel : undefined;
      const existingProvider = typeof item.modelProvider === 'string' ? item.modelProvider : undefined;
      const extra = batchModels[item.agent];
      return {
        ...item,
        defaultModel: existingModel || extra?.model,
        modelProvider: existingProvider || extra?.provider,
      };
    });
  }, [fleet, batchModels]);

  // #2 — ordre des cartes agents persisté (drag & drop natif).
  // v1.17.141 : l'ordre est désormais persisté COTE SERVEUR (mc_config.json
  // via /api/fleet/agents_order) pour survivre à une navigation privée et
  // être partagé entre tous les navigateurs. Fallback localStorage si le
  // serveur ne répond pas. Le drag & drop natif reste géré par useDndOrder.
  const baseList = enrichedFleet.length ? enrichedFleet : FLEET_STATIC;
  // v1.17.141 : onCommit persiste l'ordre côté serveur (mc_config.json via
  // /api/fleet/agents_order) pour survivre à une navigation privée et être
  // partagé entre tous les navigateurs. Fallback localStorage dans le hook.
  const dnd = useDndOrder('mc_agents_order', baseList.map((m) => m.agent), (next) => {
    setAgentsOrder(next);
  });

  // Au montage : charge l'ordre serveur et l'applique (préempte le localStorage).
  useEffect(() => {
    let cancelled = false;
    getAgentsOrder().then((serverOrder) => {
      if (cancelled) return;
      if (Array.isArray(serverOrder) && serverOrder.length) {
        // On ne conserve que les ids encore présents dans la flotte courante.
        const valid = serverOrder.filter((id) => baseList.some((m) => m.agent === id));
        // Les nouveaux agents (découverts après le dernier ordre) vont en fin.
        const known = new Set(valid);
        const rest = baseList.map((m) => m.agent).filter((id) => !known.has(id));
        dnd.setOrder([...valid, ...rest]);
      }
    }).catch(() => { /* fallback localStorage déjà actif */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const successRate =
    logsStats && logsStats.total > 0
      ? (logsStats.completed / logsStats.total) * 100
      : 0;

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-serif text-stone-100">La Flotte</h2>
          <p className="text-stone-500 mt-1">Statut et métriques pour tous les agents actifs.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMultiModalOpen((o) => !o)}
            className="bg-stone-800 hover:bg-stone-700 text-stone-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Modèle multi-agent
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="bg-orange-600 hover:bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Déployer un agent
          </button>
        </div>
      </div>

      <div className="agents-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* 2026-07-30: itère sur la flotte DYNAMIQUE (state.fleet issue du scan
            des profils Hermes) afin qu'un agent créé via la modale apparaisse
            immédiatement. */}
        {/* #2 : l'ordre des cartes est réordonnable au drag & drop et persisté
            dans localStorage (`mc_agents_order`). Les agents nouvellement
            découverts apparaissent en fin de liste. */}
        {dnd.ordered.map((agentId) => {
          const meta = baseList.find((m) => m.agent === agentId);
          if (!meta) return null;
          const live = enrichedFleet.find((f) => f.agent === meta.agent);
          const working = !!live && workingAgents.includes(live.agent);
          const waiting = !!live && waitingAgents.includes(live.agent);
          const status = agentStatusFromStrings(working, waiting);
          const props = dnd.itemProps(agentId);
          return (
            <div key={meta.agent} {...props} className={`${props.className} mc-drag-handle`}>
              <AgentCard
                meta={meta}
                live={live}
                status={status}
                onAgentClick={onAgentClick}
                onSkillClick={setSkillAgent}
                onDeleted={refresh}
              />
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
        <div className="bg-stone-900 border border-stone-800 rounded-3xl p-8">
          <h3 className="text-stone-300 font-medium mb-6">Débit à travers la flotte spécialisée</h3>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-6xl font-serif text-stone-200">
                {successRate.toFixed(1)}<span className="text-2xl text-stone-500">%</span>
              </p>
              <p className="text-sm text-stone-500 mt-2">Taux de réussite global</p>
            </div>
            {/* 
              Bars = number of messages sent to each agent (msgCount, from
              sessions). Height is scaled relative to the busiest agent so the
              chart stays readable. The big % stays the global success rate.
            */}
            <div className="w-1/2 h-24 flex items-end justify-between space-x-1">
              {fleet.length > 0 && (() => {
                const maxMsg = Math.max(1, ...fleet.map((a) => a.msgCount ?? 0));
                return fleet.map((a) => {
                  const m = a.msgCount ?? 0;
                  const pct = m > 0 ? Math.max(8, Math.round((m / maxMsg) * 100)) : 8;
                  return (
                    <div
                      key={a.agent}
                      className="w-full bg-orange-500 rounded-t-sm"
                      style={{ height: `${pct}%` }}
                      title={`${a.name}: ${m} messages`}
                    />
                  );
                });
              })()}
              {fleet.length === 0 && [40, 60, 45, 80, 50].map((h, i) => (
                <div key={i} className="w-full bg-stone-800 rounded-t-sm" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
          {/* "API indisponible" conditionnel (req #3) */}
          {error && (
            <p className="text-xs text-stone-600 mt-4">API indisponible — données non actualisées.</p>
          )}
          {!error && connected && (
            <p className="text-xs text-cyan-900/70 mt-4">Données en direct.</p>
          )}
        </div>
      </div>

      <MultiAgentModelModal
        open={multiModalOpen}
        onClose={() => setMultiModalOpen(false)}
      />
      <CreateAgentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => refresh()}
      />
      <SkillManagerModal
        agent={skillAgent}
        open={!!skillAgent}
        onClose={() => setSkillAgent(null)}
      />
    </div>
  );
};

// Carte d'agent extraite en sous-composant pour que les hooks (useState/
// useEffect) soient au top-level (et NON dans la boucle .map() d'AgentsTab).
// Avant ce refactor, les hooks étaient dans le .map() : ça "marchait" tant que
// le nombre d'agents restait constant, mais l'ajout d'un agent découvert
// changeait le nombre de hooks par render et plantait React (#310 persistant).
const AgentCard: React.FC<{
  meta: any;
  live?: any;
  status: 'idle' | 'working' | 'waiting';
  onAgentClick?: (agent: string) => void;
  onSkillClick?: (agent: string) => void;
  onDeleted?: () => void;
}> = ({ meta, live, status, onAgentClick, onSkillClick, onDeleted }) => {
  const classes = agentStatusClasses(status);
  const tasksToday = live?.tasksToday ?? 0;
  const success = live?.success ?? 0;
  const modelLabel = typeof live?.defaultModel === 'string' ? live.defaultModel : undefined;
  const providerLabel = typeof live?.modelProvider === 'string' ? live.modelProvider : undefined;

  const usage = live?.tokenUsage ?? {};
  const rate = live?.tokenRate ?? {};
  const activeModel = modelLabel ?? undefined;
  const u = usage[activeModel ?? ''] ?? { day: 0, week: 0, month: 0 };
  const [liveRate, setLiveRate] = useState<number | null>(
    activeModel != null ? (rate[activeModel] ?? null) : null,
  );
  useEffect(() => {
    setLiveRate(activeModel != null ? (rate[activeModel] ?? null) : null);
  }, [activeModel]);
  const frozenRate =
    activeModel != null && liveRate != null
      ? liveRate
      : activeModel != null && rate[activeModel] != null
        ? rate[activeModel]
        : null;

  const [confirmAgent, setConfirmAgent] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const deleteAgent = async (agent: string) => {
    setDeleting(true);
    try {
      const res = await fetch('/api/fleet/agent/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ agent }),
      });
      const body = (await res.json().catch(() => ({ ok: false, error: `${res.status}` }))) as {
        ok?: boolean;
        error?: string;
      };
      if (body.ok) {
        setConfirmAgent(null);
        if (onDeleted) onDeleted();
      } else {
        alert(typeof body.error === 'string' ? body.error : `Echec HTTP ${res.status}`);
      }
    } catch (e) {
      alert((e as Error).message || 'Erreur réseau');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      onClick={() => onAgentClick?.(meta.agent)}
      className="agent-card bg-stone-900 border border-stone-800 rounded-2xl p-6 hover:border-stone-700 transition-all cursor-pointer group"
    >
      <div className="flex justify-between items-start mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-medium text-stone-200 group-hover:text-orange-500 transition-colors flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${classes.dot}`} />
              {meta.name}
            </h3>
          </div>
          <p className="text-xs text-stone-500 uppercase tracking-wider mt-1">{meta.role}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className={`px-2 py-1 rounded text-[10px] font-bold tracking-wider flex items-center ${classes.pill}`}>
            {classes.label}
          </div>
          {meta.agent !== 'manager' && meta.agent !== 'default' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmAgent(meta.agent);
              }}
              title="Supprimer l'agent"
              className="px-2 py-1 text-[10px] rounded-md bg-red-900/40 text-red-300 border border-red-800/50 hover:bg-red-800/60 transition-colors"
            >
              Supprimer
            </button>
          )}
        </div>
      </div>

      <div className="agent-card-metrics flex justify-between items-end pt-4 border-t border-stone-800">
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center">
            <p className="text-[10px] uppercase tracking-widest text-stone-500">Tâches aujourd'hui</p>
            <p className="text-2xl font-serif text-stone-300">{tasksToday}</p>
          </div>
          <div className="flex justify-between items-center mt-2">
            <p className="text-[10px] uppercase tracking-widest text-stone-500">Réussite</p>
            <p className="text-sm font-medium text-stone-300">{success}%</p>
          </div>
          <p className="text-[10px] uppercase tracking-widest text-stone-500 mt-2">
            Modèle IA :{' '}
            <span className="inline-block max-w-full align-bottom text-xs font-mono text-orange-300/90 truncate" title={modelLabel ?? ''}>
              {modelLabel ?? '—'}
            </span>
          </p>
          {providerLabel && (
            <p className="text-[10px] uppercase tracking-widest text-stone-600 mt-1">
              PROVIDER :{' '}
              <span className="inline-block max-w-full align-bottom text-xs font-mono text-stone-400 truncate" title={providerLabel}>{providerLabel}</span>
            </p>
          )}
          <div className="grid grid-cols-3 gap-2 pt-3 mt-2 border-t border-stone-800">
            <div>
              <p className="text-[10px] text-stone-500 uppercase tracking-widest">Jour</p>
              <p className="text-sm font-mono text-stone-300">{u.day}</p>
            </div>
            <div>
              <p className="text-[10px] text-stone-500 uppercase tracking-widest">Sem</p>
              <p className="text-sm font-mono text-stone-300">{u.week}</p>
            </div>
            <div>
              <p className="text-[10px] text-stone-500 uppercase tracking-widest">Mois</p>
              <p className="text-sm font-mono text-stone-300">{u.month}</p>
            </div>
          </div>
          <p className="text-[10px] text-stone-500 uppercase tracking-widest mt-2">Débit (est.)</p>
          <p className="text-sm font-mono text-cyan-300/90">
            {frozenRate != null ? `${frozenRate} tok/s` : '—'}
          </p>
        </div>
        <div className="flex space-x-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          <ModelSelector agent={meta.agent} />
          <button
            onClick={() => onSkillClick?.(meta.agent)}
            title="Gérer les skills"
            className="p-2 bg-stone-950 rounded-lg text-stone-500 hover:text-stone-300 hover:text-orange-400 transition-colors"
          >
            <Zap className="w-4 h-4" />
          </button>
        </div>
      </div>

      {confirmAgent && (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setConfirmAgent(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-stone-800 bg-stone-950 p-6 shadow-2xl text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-stone-200 mb-2">
              Supprimer l'agent <span className="font-mono text-orange-300">{confirmAgent}</span> ?
            </p>
            <p className="text-xs text-stone-500 mb-4">
              Le profil sera sauvegardé dans ~/.hermes/profiles_trash/ puis supprimé, et toutes ses traces nettoyées du dashboard (logs, tâches). Action irréversible hors sauvegarde.
            </p>
            <div className="flex justify-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmAgent(null)}
                disabled={deleting}
                className="px-4 py-2 text-xs rounded-md text-stone-400 hover:text-stone-200 hover:bg-stone-900/50 transition-colors"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => deleteAgent(confirmAgent)}
                disabled={deleting}
                className="px-4 py-2 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Suppression...' : 'Confirmer la suppression'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};