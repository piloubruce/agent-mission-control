import React, { useState } from 'react';
import { useApiState } from '../../api';
import { FLEET_STATIC } from '../../types';
import { Activity, Cpu, Database, Network, X, GripVertical, RotateCcw } from 'lucide-react';
import { formatEpochShort } from '../../lib/datetime';
import { useDndOrder } from '../../lib/useDndOrder';

// Pill color per real agent status.
function statusDot(working: boolean, waiting = false): string {
  if (waiting) return 'bg-blue-500 animate-pulse';
  return working ? 'bg-red-500 animate-pulse' : 'bg-green-500';
}

// #1 — Widgets réordonnables par drag-and-drop. L'ordre est persisté dans
// localStorage (`mc_overview_widgets`), aucun appel backend requis.
const WIDGETS_KEY = 'mc_overview_widgets';
const WIDGET_IDS = ['fleet', 'metrics', 'production', 'logs'];

export const OverviewTab: React.FC = () => {
  const { state, connected } = useApiState();
  const [showLogs, setShowLogs] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const dnd = useDndOrder(WIDGETS_KEY, WIDGET_IDS);

  const fleet = state?.fleet ?? [];
  const workingAgents = state?.working_agents ?? [];
  const waitingAgents = (state as any)?.waiting_agents ?? [];
  const logs = state?.agentlogs ?? [];
  const logsStats = state?.agentlogs_stats;
  const vps = state?.vps;
  const fmtTs = (ts?: number) =>
    ts
      ? new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
  const gatewayStartStr = fmtTs((vps as any)?.gateway_start_time);
  const mcStartStr = fmtTs((vps as any)?.mc_start_time);

  const activeMissions = workingAgents.length;
  const cpuPct = vps?.cpu_pct ?? 0;
  // Per spec: "Jetons / Sec" surface = vps.mem_pct (front-end label choice).
  const tokensPerSec = vps?.mem_pct ?? 0;
  const tasksDone = logsStats?.total ?? 0;

  // Poignée de drag affichée en haut à droite de chaque widget.
  const Handle = () => (
    <div
      className="mc-drag-handle absolute top-3 right-3 z-20 p-1 rounded-md text-stone-500 hover:text-orange-500 hover:bg-stone-800/60 transition-colors"
      title="Glisser pour réordonner"
    >
      <GripVertical className="w-4 h-4" />
    </div>
  );

  const widgets: Record<string, React.ReactNode> = {
    fleet: (
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-stone-900 to-stone-950 border border-stone-800 p-8 flex flex-col justify-between h-full">
        <Handle />
        <div className="absolute top-0 right-0 p-8 opacity-20">
          <Network className="w-64 h-64 text-orange-500" />
        </div>
        <div className="relative z-10">
          <h1 className="text-4xl font-serif text-stone-100 tracking-tight leading-tight">
            Un manager.<br />
            <span className="text-stone-400">quatre spécialistes.</span>
          </h1>
          <p className="mt-4 text-stone-500 max-w-md">
            Votre force de travail IA autonome est en ligne. Surveillance de la santé de la flotte, de l'exécution des tâches et des performances.
          </p>
        </div>

        <div className="grid grid-cols-5 gap-4 mt-12 relative z-10">
          {FLEET_STATIC.map((meta) => {
            const live = fleet.find((f) => f.agent === meta.agent);
            const working = !!live && workingAgents.includes(live.agent);
            const waiting = !!live && waitingAgents.includes(live.agent);
            return (
              <div key={meta.agent} className="flex flex-col items-center">
                <div className={`w-3 h-3 rounded-full mb-2 ${statusDot(working, waiting)}`} />
                <span className="text-xs font-medium text-stone-400 uppercase tracking-wider">{meta.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    ),

    metrics: (
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-stone-900 to-stone-950 border border-stone-800 p-8 flex flex-col justify-center h-full">
        <Handle />
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-stone-900/60 border border-stone-800 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-stone-500 uppercase tracking-wider">Disque</span>
                <span className="text-xs text-stone-400">{vps?.disk_pct ?? 0}%</span>
              </div>
              <div className="text-lg font-serif text-stone-200 mt-1">
                {vps?.disk_used_gb ?? 0} / {vps?.disk_total_gb ?? 0} Go
              </div>
            </div>
            <div className="bg-stone-900/60 border border-stone-800 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-stone-500 uppercase tracking-wider">Mémoire</span>
                <span className="text-xs text-stone-400">{vps?.mem_pct ?? 0}%</span>
              </div>
              <div className="text-lg font-serif text-stone-200 mt-1">
                {vps?.mem_used_gb ?? 0} / {vps?.mem_total_gb ?? 0} Go
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-stone-900/60 border border-stone-800 rounded-xl p-4">
              <div className="flex items-center">
                <Cpu className="w-3.5 h-3.5 mr-1.5 text-orange-500" />
                <span className="text-xs text-stone-500 uppercase tracking-wider">Charge CPU</span>
              </div>
              <div className="text-2xl font-serif text-stone-200 mt-1">{Math.round(cpuPct)}%</div>
            </div>
            <div className="bg-stone-900/60 border border-stone-800 rounded-xl p-4">
              <span className="text-xs text-stone-500 uppercase tracking-wider">Dernier démarrage Hermes Gateway</span>
              <div className="text-lg font-serif text-stone-200 mt-1">{gatewayStartStr}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-stone-900/60 border border-stone-800 rounded-xl p-4">
              <div className="flex items-center">
                <Database className="w-3.5 h-3.5 mr-1.5 text-orange-500" />
                <span className="text-xs text-stone-500 uppercase tracking-wider">Missions actives</span>
              </div>
              <div className="text-2xl font-serif text-stone-200 mt-1">{String(activeMissions).padStart(2, '0')}</div>
            </div>
            <div className="bg-stone-900/60 border border-stone-800 rounded-xl p-4">
              <span className="text-xs text-stone-500 uppercase tracking-wider">Jetons / Sec</span>
              <div className="text-2xl font-serif text-stone-200 mt-1">{Math.round(tokensPerSec)}</div>
            </div>
          </div>
        </div>
      </div>
    ),

    production: (
      <div className="relative rounded-3xl bg-orange-600 p-8 text-orange-50 flex flex-col justify-between h-full">
        <Handle />
        <div>
          <h2 className="text-2xl font-medium mb-2">Des agents qui produisent.</h2>
          <p className="text-orange-200/80 text-sm">
            Synchronisation en temps réel des tâches, documentation automatisée et livraison de code.
          </p>
        </div>
        <div className="space-y-4 mt-8">
          <div className="bg-orange-700/50 rounded-xl p-4 flex items-center justify-between">
            <span className="text-sm font-medium">Dernier démarrage Hermes MC</span>
            <span className="text-sm font-bold">{mcStartStr}</span>
          </div>
          <div className="bg-orange-700/50 rounded-xl p-4 flex items-center justify-between cursor-pointer hover:bg-orange-600/60 transition-colors" onClick={() => setShowTasks(true)} title="Voir le détail des tâches terminées">
            <span className="text-sm font-medium">Tâches terminées</span>
            <span className="text-xl font-bold">{tasksDone.toLocaleString('fr-FR')}</span>
          </div>
          <div className="bg-orange-700/50 rounded-xl p-4 flex items-center justify-between">
            <span className="text-sm font-medium">Disponibilité</span>
            <span className="text-xl font-bold">{connected ? '100%' : 'HORS-LIGNE'}</span>
          </div>
        </div>
      </div>
    ),

    logs: (
      <div className="relative bg-stone-900 border border-stone-800 rounded-3xl p-6 h-full">
        <Handle />
        <h3 className="text-stone-300 font-medium mb-4 flex items-center">
          <Activity className="w-4 h-4 mr-2 text-orange-500" /> Activité récente de la flotte
        </h3>
        <div className="space-y-3 font-mono text-xs">
          {logs.length === 0 && (
            <div className="text-stone-600">Aucune activité enregistrée pour le moment.</div>
          )}
          {logs.slice(0, 12).map((log, i) => (
            <div key={i} className="flex items-start text-stone-400">
              <span className="text-stone-600 w-24 shrink-0">{log.time ? formatEpochShort(Number(log.time)) : '—'}</span>
              <span className={`${log.status === 'completed' ? 'text-cyan-400' : 'text-stone-400'}`}>
                [{log.agent}] {log.task ?? '(sans description)'}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 pt-4 border-t border-stone-800 flex justify-between items-center text-xs">
          <span className="text-stone-500">
            Flux en direct {connected ? 'connecté.' : '— API indisponible.'}
          </span>
          <button
            onClick={() => setShowLogs(true)}
            className="text-orange-500 hover:text-orange-400"
          >
            Voir tous les journaux &rarr;
          </button>
        </div>
      </div>
    ),
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {dnd.isCustom && (
          <button
            onClick={dnd.reset}
            className="flex items-center gap-1.5 text-xs text-stone-500 hover:text-orange-500 transition-colors"
            title="Rétablir la disposition par défaut"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Réinitialiser la disposition
          </button>
        )}
      </div>

      {/* Grille de widgets réordonnables (drag & drop natif, ordre persisté). */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
        {dnd.ordered.map((id) => {
          const props = dnd.itemProps(id);
          // Le widget "logs" occupe toute la largeur.
          const span = id === 'logs' ? 'lg:col-span-3' : '';
          return (
            <div key={id} {...props} className={`${props.className} ${span}`}>
              {widgets[id]}
            </div>
          );
        })}
      </div>

      {showTasks && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowTasks(false)}
        >
          <div
            className="bg-stone-950 border border-stone-800 rounded-3xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-stone-800">
              <h3 className="text-stone-200 font-medium flex items-center">
                <Activity className="w-4 h-4 mr-2 text-orange-500" /> Tâches terminées aujourd'hui
                <span className="ml-2 text-xs text-stone-500">({tasksDone} au total{tasksDone !== logs.length ? `, ${logs.length} lignes affichées` : ''})</span>
              </h3>
              <button
                onClick={() => setShowTasks(false)}
                className="p-1.5 text-stone-500 hover:text-stone-200 rounded-lg hover:bg-stone-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-5 space-y-2 font-mono text-xs">
              {logs.length === 0 && (
                <div className="text-stone-600">Aucune tâche terminée pour le moment.</div>
              )}
              {logs.map((log, i) => (
                <div key={i} className="flex items-start text-stone-400">
                  <span className="text-stone-600 w-24 shrink-0">{log.time ? formatEpochShort(Number(log.time)) : '—'}</span>
                  <span className={`${log.status === 'completed' ? 'text-cyan-400' : 'text-red-400'}`}>
                    [{log.agent}] {log.task ?? '(sans description)'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showLogs && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowLogs(false)}
        >
          <div
            className="bg-stone-950 border border-stone-800 rounded-3xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-stone-800">
              <h3 className="text-stone-200 font-medium flex items-center">
                <Activity className="w-4 h-4 mr-2 text-orange-500" /> Tous les journaux de la flotte
              </h3>
              <button
                onClick={() => setShowLogs(false)}
                className="p-1.5 text-stone-500 hover:text-stone-200 rounded-lg hover:bg-stone-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-5 space-y-2 font-mono text-xs">
              {logs.length === 0 && (
                <div className="text-stone-600">Aucune activité enregistrée pour le moment.</div>
              )}
              {logs.map((log, i) => (
                <div key={i} className="flex items-start text-stone-400">
                  <span className="text-stone-600 w-24 shrink-0">{log.time ? formatEpochShort(Number(log.time)) : '—'}</span>
                  <span className={`${log.status === 'completed' ? 'text-cyan-400' : 'text-stone-400'}`}>
                    [{log.agent}] {log.task ?? '(sans description)'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
