import React, { useEffect, useRef, useState } from 'react';
import { ChevronUp, Terminal } from 'lucide-react';
import { subscribeSse, subscribeSseOpen, subscribeSseError } from '../../lib/sse';

interface FleetLogEntry {
  id: string;
  timestamp: string;
  agent?: string;
  task?: string;
  status: string;
  model?: string;
  error?: string;
}

interface FleetLivePanelProps {
  visible: boolean;
  onToggle: () => void;
}

const MAX_LINES = 200;

export const FleetLivePanel: React.FC<FleetLivePanelProps> = ({ visible, onToggle }) => {
  const [lines, setLines] = useState<FleetLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lineSeq = useRef(0);

  // Clé stable (seq + timestamp) — evite les key={idx} sur des lignes
  // ajoutees en tete (mauvaise reconciliation React, audit 2026-08-07).
  const nextId = () => `line-${++lineSeq.current}-${Date.now()}`;

  // Auto-scroll : on ne colle au bas QUE si l'utilisateur y est deja.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - (el.scrollTop + el.clientHeight) < 60;
  };

  const append = (entry: Omit<FleetLogEntry, 'id'>) => {
    setLines((prev) => {
      const next = [...prev, { ...entry, id: nextId() }];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
    // Scroll au bas apres le paint si l'utilisateur est deja en bas.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
  };

  // Flux SSE PARTAGE (une seule connexion /events pour toute l'app).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    const onState = (ev: MessageEvent) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(ev.data as string);
        const working = data?.working_agents || [];
        const waiting = (data as any)?.waiting_agents || [];
        const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
        append({
          timestamp,
          agent: 'SYSTEM',
          task: 'État de la flotte actualisé',
          status: working.length > 0 ? 'working' : waiting.length > 0 ? 'waiting' : 'idle',
        });
        setConnected(true);
        setError(null);
      } catch {
        // Ignore les payloads mal formes.
      }
    };

    const onLog = (ev: MessageEvent) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(ev.data as string);
        append({
          timestamp: new Date().toISOString().split('T')[1].slice(0, 8),
          agent: data.agent,
          task: data.task,
          status: data.status,
          model: data.model,
          error: data.error,
        });
      } catch {
        // Ignore.
      }
    };

    const onOpen = () => { if (!cancelled) { setConnected(true); setError(null); } };
    const onError = () => { if (!cancelled) { setConnected(false); setError('Déconnexion du flux SSE'); } };

    const unsubState = subscribeSse('state', onState);
    const unsubLog = subscribeSse('log', onLog);
    const unsubOpen = subscribeSseOpen(onOpen);
    const unsubError = subscribeSseError(onError);

    return () => {
      cancelled = true;
      unsubState();
      unsubLog();
      unsubOpen();
      unsubError();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  const formatStatus = (status: string) => {
    const cls =
      status === 'completed'
        ? 'text-emerald-400'
        : status === 'running' || status === 'working'
          ? 'text-blue-400'
          : status === 'waiting'
            ? 'text-amber-400'
            : status === 'error' || status === 'ko'
              ? 'text-red-400'
              : 'text-stone-400';
    return `${cls} ${status}`;
  };

  return (
    <div className="fixed bottom-0 right-0 z-40 w-full max-w-2xl h-80 bg-stone-900 border border-stone-800 rounded-t-2xl shadow-2xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-800 bg-stone-950">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-orange-500" />
          <h3 className="font-medium text-stone-200">Flux en temps réel de la flotte</h3>
          {connected && <span className="text-[10px] text-emerald-400">✓ connecté</span>}
          {error && <span className="text-[10px] text-red-400">⚠ {error}</span>}
        </div>
        <button
          onClick={onToggle}
          className="p-1.5 text-stone-400 hover:text-stone-200 hover:bg-stone-800 rounded-lg transition-colors"
          title="Fermer"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs"
      >
        {lines.length === 0 ? (
          <div className="text-center text-stone-600 py-8">
            <Terminal className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>Le flux SSE démarre...</p>
          </div>
        ) : (
          <div className="space-y-1">
            {lines.map((line) => (
              <div
                key={line.id}
                className="flex items-start gap-2 px-2 py-1 rounded hover:bg-stone-800/50 transition-colors"
              >
                <span className="text-stone-600 italic">[{line.timestamp}]</span>
                {line.agent && <span className="text-orange-400 font-medium">[{line.agent}]</span>}
                {line.task && <span className="text-stone-300">{line.task}</span>}
                <span className={`ml-auto ${formatStatus(line.status)}`}>{line.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Hook for managing the live panel state
export function useLivePanel() {
  const [visible, setVisible] = useState(false);

  const toggle = () => setVisible((v) => !v);
  const show = () => setVisible(true);
  const hide = () => setVisible(false);

  return { visible, toggle, show, hide };
}
