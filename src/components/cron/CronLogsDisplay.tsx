import React, { useState, useEffect } from 'react';
import { getCronExecutionLogs, deleteCronExecution, type ExecutionLog } from '../../api';
import { X, Trash2 } from 'lucide-react';

interface CronLogsProps {
  jobId: string;
  maxLogs?: number;
}

export const CronLogsDisplay: React.FC<CronLogsProps> = ({ jobId, maxLogs = 10 }) => {
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExecutionLog | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchLogs = async () => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getCronExecutionLogs(jobId, maxLogs);
      if (result.ok) {
        setLogs(result.executions || []);
      } else {
        setError(result.error || 'Erreur de chargement');
      }
    } catch (e) {
      setError('Echec de la requete');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [jobId]);

  const formatTimestamp = (ts: string | null) => {
    if (!ts) return '-';
    try {
      return new Date(ts).toLocaleString('fr-FR');
    } catch {
      return ts;
    }
  };

  const getStatusColor = (status: string) => {
    const s = status.toLowerCase();
    if (s === 'completed' || s === 'ok') return 'text-green-400';
    if (s === 'failed' || s === 'error') return 'text-red-400';
    if (s === 'running') return 'text-blue-400';
    return 'text-yellow-400';
  };

  const formatDuration = (dur: number | null) => {
    if (dur === null) return '-';
    if (dur < 1) return `${Math.round(dur * 1000)}ms`;
    return `${dur.toFixed(2)}s`;
  };

  const handleDeleteExecution = async (executionId: string) => {
    if (!confirm('Supprimer cette exécution de l\'historique ?')) return;
    setDeletingId(executionId);
    const res = await deleteCronExecution(executionId);
    if (res.ok) {
      setLogs(prev => prev.filter(l => l.id !== executionId));
      if (selected?.id === executionId) setSelected(null);
    } else {
      alert(res.error || 'Suppression impossible');
    }
    setDeletingId(null);
  };

  // Helper function to clean error messages for display
  const cleanError = (err: string | null, status: string): string | null => {
    if (!err) return null;
    const errLower = err.toLowerCase();

    // Don't show raw Python tracebacks to users - show user-friendly message
    if (errLower.includes('unsupported operand') ||
        errLower.includes('traceback') ||
        errLower.includes('file ') ||
        errLower.includes('line ') && err.includes('  ')) {
      return 'Erreur interne lors de l\'execution (voir logs serveur)';
    }

    // If job completed but has an error, it's likely a warning
    if (status === 'completed' || status === 'ok') {
      // Don't show non-critical errors for completed jobs
      if (errLower.includes('warning') || errLower.includes('deprecated')) {
        return null;
      }
    }

    return err;
  };

  // Compute the finish timestamp from start + duration (backend gives duration).
  const finishTimestamp = (log: ExecutionLog): string | null => {
    if (!log.timestamp) return null;
    if (log.duration === null || log.duration === undefined) return null;
    try {
      const start = new Date(log.timestamp).getTime();
      return new Date(start + log.duration * 1000).toISOString();
    } catch {
      return null;
    }
  };

  const SourceBadge: React.FC<{ source?: string | null }> = ({ source }) => {
    const isManual = source === 'direct';
    const label = isManual ? 'Manuel' : source === 'builtin' ? 'Auto' : (source || 'Auto');
    return (
      <span
        className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
          isManual
            ? 'text-blue-300 border-blue-700/60 bg-blue-900/30'
            : 'text-stone-400 border-stone-700 bg-stone-800/60'
        }`}
        title={isManual ? 'Lancé manuellement (bouton Play)' : 'Exécution automatique (scheduler)'}
      >
        {label}
      </span>
    );
  };

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400">Dernieres executions:</span>
        <button
          onClick={fetchLogs}
          disabled={loading}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          {loading ? '...' : 'Actualiser'}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 p-1">{error}</div>
      )}

      {/* Don't show "Pas de logs disponibles" when there's an error to display */}
      {logs.length === 0 && !loading && !error && (
        <div className="text-xs text-gray-500 p-1">Pas de logs disponibles</div>
      )}

      {logs.map((log) => (
        <button
          key={log.id}
          onClick={() => setSelected(log)}
          title="Voir le détail de l'exécution"
          className={`w-full text-left text-xs p-1 rounded border border-gray-700 mb-1 cursor-pointer transition-colors hover:border-blue-600 ${
            log.status === 'completed' ? 'bg-gray-800' :
            log.status === 'failed' ? 'bg-red-900/20' : 'bg-gray-800'
          }`}
        >
          <div className="flex justify-between items-start gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={getStatusColor(log.status)}>
                {log.status.toUpperCase()}
              </span>
              <SourceBadge source={log.source} />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteExecution(log.id); }}
                disabled={deletingId === log.id}
                className="text-stone-500 hover:text-red-400 disabled:opacity-50"
                title="Supprimer cette exécution"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <span className="text-gray-500 whitespace-nowrap">
                {formatDuration(log.duration)} • {formatTimestamp(log.timestamp)}
              </span>
            </div>
          </div>
          {cleanError(log.error, log.status) && (
            <div className="text-red-300 mt-1 text-xs">
              Erreur: {cleanError(log.error, log.status)}
            </div>
          )}
        </button>
      ))}

      {/* Modal de détail d'une exécution */}
      {selected && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-stone-900 border border-stone-700 rounded-2xl p-5 max-w-md w-full">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-medium text-stone-200 flex items-center gap-2">
                Détail de l'exécution
                <SourceBadge source={selected.source} />
              </h4>
              <button
                onClick={() => setSelected(null)}
                className="text-stone-500 hover:text-stone-300"
                title="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">ID exécution</dt>
                <dd className="text-stone-200 font-mono break-all text-right">{selected.id}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">Job ID</dt>
                <dd className="text-stone-200 font-mono break-all text-right">{selected.job_id}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">Source</dt>
                <dd className="text-stone-200 text-right">
                  {selected.source === 'direct' ? 'Exécution manuelle' : selected.source === 'builtin' ? 'Exécution automatique' : (selected.source || '-')}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">Statut</dt>
                <dd className={`${getStatusColor(selected.status)} text-right`}>{selected.status}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">Début</dt>
                <dd className="text-stone-200 text-right">{formatTimestamp(selected.timestamp)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">Fin</dt>
                <dd className="text-stone-200 text-right">{formatTimestamp(finishTimestamp(selected))}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">Durée</dt>
                <dd className="text-stone-200 text-right">{formatDuration(selected.duration)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500 shrink-0">Return code</dt>
                <dd className="text-stone-200 text-right">{selected.returncode}</dd>
              </div>
              {selected.error && (
                <div className="pt-2 border-t border-stone-800">
                  <dt className="text-stone-500 mb-1">Erreur</dt>
                  <dd className="text-red-300 font-mono break-words bg-stone-950 rounded p-2 max-h-40 overflow-y-auto">
                    {selected.error}
                  </dd>
                </div>
              )}
            </dl>
            <div className="flex justify-end mt-5">
              <button
                onClick={() => setSelected(null)}
                className="px-4 py-2 text-sm text-stone-300 border border-stone-700 rounded-lg hover:border-stone-500"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
