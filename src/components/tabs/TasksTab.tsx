import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardTask } from '../../api';
import { FLEET_STATIC } from '../../types';
import type { TaskStatus } from '../../types';
import { createBoardTask, deleteBoardTask, getBoard, updateBoardTask, useApiState, sendMessage } from '../../api';
import { Play, Square, Pause, RotateCcw, Trash2, X } from 'lucide-react';

const AGENT_RE = /@([A-Za-z0-9_]+)/;

function resolveAgentFromTitle(title: string, knownAgents: Set<string>): { title: string; agent: string } {
  const m = title.match(AGENT_RE);
  if (!m) return { title, agent: 'manager' };
  const raw = m[1].toLowerCase();
  const agent = knownAgents.has(raw) ? raw : 'manager';
  const cleaned = title.replace(AGENT_RE, '').replace(/\s+/g, ' ').trim();
  return { title: cleaned || 'Nouvelle mission', agent };
}

// Front status <-> API board status mapping.
const API_TO_FRONT: Record<'todo' | 'doing' | 'done', TaskStatus> = {
  todo: 'todo',
  doing: 'doing',
  done: 'done',
};
// Drag column ids use the front vocabulary.
const FRONT_TO_API: Record<string, 'todo' | 'doing' | 'done'> = {
  todo: 'todo',
  'in-progress': 'doing',
  done: 'done',
};

export const TasksTab: React.FC = () => {
  const { state } = useApiState();
  const fleet = state?.fleet ?? [];
  const workingAgents = state?.working_agents ?? [];
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [draggedTask, setDraggedTask] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const newTitleRef = useRef<HTMLTextAreaElement | null>(null);

  const agentsList = useMemo(() => {
    const map = new Map<string, string>();
    FLEET_STATIC.forEach(f => map.set(f.agent, f.name));
    fleet.forEach(f => {
      if (f.agent && !map.has(f.agent)) {
        map.set(f.agent, f.name || f.agent);
      }
    });
    return Array.from(map.entries()).map(([agent, name]) => ({ agent, name }));
  }, [fleet]);

  const KNOWN_AGENTS = useMemo(() => new Set(agentsList.map(a => a.agent)), [agentsList]);

  // Auto-grow the new-mission box so the whole text stays visible while typing.
  const autoGrowNew = () => {
    const el = newTitleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  };
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detailTask, setDetailTask] = useState<BoardTask | null>(null);

  const load = () => {
    getBoard()
      .then((data) => setTasks(data))
      .catch((e) => console.error('load board failed', e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const toggleSelected = (id: number, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const handleDragStart = (e: React.DragEvent, id: number) => {
    setDraggedTask(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, frontStatus: string) => {
    e.preventDefault();
    if (draggedTask == null) return;
    const apiStatus = FRONT_TO_API[frontStatus] ?? 'todo';
    const target = tasks.find((t) => t.id === draggedTask);
    setDraggedTask(null);
    if (!target || target.status === apiStatus) return;

    // Optimistic UI update
    setTasks((prev) => prev.map((t) => (t.id === draggedTask ? { ...t, status: apiStatus } : t)));
    updateBoardTask(draggedTask, { status: apiStatus }).catch((err) => {
      console.error('update failed', err);
      load(); // rollback to server truth
    });
  };

  const handleAdd = (status: 'todo' | 'doing' | 'done') => {
    const raw = (status === 'todo' ? newTitle : '').trim() || 'Nouvelle mission';
    const { title, agent } = status === 'todo' ? resolveAgentFromTitle(raw, KNOWN_AGENTS) : { title: raw, agent: 'manager' };
    if (status === 'todo') setNewTitle('');
    createBoardTask({ title, status, agent })
      .then(() => load())
      .catch((e) => console.error('create failed', e));
  };

  const updateTask = (id: number, fields: Partial<Pick<BoardTask, 'status' | 'notes'>>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...fields } : t)));
    updateBoardTask(id, fields).catch((err) => {
      console.error('update failed', err);
      load();
    });
  };

  const handleDelete = (id: number) => {
    deleteBoardTask(id)
      .then(() => setTasks((prev) => prev.filter((t) => t.id !== id)))
      .catch((e) => console.error('delete failed', e));
  };

  // Execute a board task via the agent. Flow (user spec):
  //   1. flip to "doing" (EN COURS) immediately,
  //   2. fire the message through the MESSAGES pipeline (backend launches
  //      hermes -p <agent> chat in a daemon thread and returns session_id at
  //      once — NOT the reply),
  //   3. poll /api/messages/status until running=false (agent actually worked),
  //   4. read the finished session to grab the REAL agent reply, store it in
  //      notes, then flip to "done" (TERMINÉ).
  // The card therefore pauses in EN COURS while the agent works, and notes
  // ends up holding the agent's reply text — not the session_id.
  const execBoardTask = (task: BoardTask) => {
    const agent = (task.agent || 'manager');
    updateTask(task.id, { status: 'doing' });
    sendMessage(agent, '', task.title, [], false)
      .then((res: any) => {
        const sid = res && res.session_id ? res.session_id : '';
        if (!sid) { updateTask(task.id, { status: 'todo' }); return; }
        // poll status until running=false
        const poll = (tries: number) => {
          if (tries <= 0) { updateTask(task.id, { status: 'done', notes: '(terminé, réponse non lue)' }); return; }
          fetch(`/api/messages/status?agent=${encodeURIComponent(agent)}&session_id=${encodeURIComponent(sid)}`)
            .then(r => r.json())
            .then((st: any) => {
              if (st.running === false) {
                // agent done: the reply lives only in the live status text
                // (we sent persist=false, so it is NOT in the message history).
                const replyText = st.text || (st.error ? ('ERREUR: ' + st.error) : '');
                updateTask(task.id, { status: 'done', notes: String(replyText).slice(0, 4000) });
              } else {
                setTimeout(() => poll(tries - 1), 1500);
              }
            })
            .catch(() => setTimeout(() => poll(tries - 1), 1500));
        };
        poll(80); // ~120s max
      })
      .catch((err: any) => {
        console.error(err);
        updateTask(task.id, { status: 'todo' });
      });
  };

  const bulkSetStatus = (status: 'todo' | 'doing' | 'done' | 'remove') => {
    if (selected.size === 0) return;

    // BULK RUN ("Démarrer") : on EXÉCUTE réellement chaque tâche sélectionnée
    // via l'agent (au lieu de laisser la tâche en "doing" sans jamais lancer
    // l'agent). execBoardTask() gère le cycle complet :
    //   doing -> lance l'agent -> poll /api/messages/status -> done (réponse
    //   stockée dans notes). On ne fait DONC PAS d'updateTask ici.
    // On ne (re)lance que les tâches "todo" (les "doing" tournent déjà, les
    // "done" ne sont pas redémarrées en masse) — évite un double-lancement.
    if (status === 'doing') {
      const targets = tasks.filter((t) => selected.has(t.id) && t.status === 'todo');
      setSelected(new Set());
      targets.forEach((t) => execBoardTask(t));
      return;
    }

    // 'todo' (Arrêter) et 'remove' (Supprimer) : comportement inchangé.
    setTasks((prev) => {
      const next = [...prev];
      const keep: typeof next = [];
      for (const t of next) {
        if (!selected.has(t.id)) { keep.push(t); continue; }
        if (status === 'remove') continue;
        // Ici status ne peut plus etre que 'todo' (le cas 'doing' est deja
        // retourne plus haut ; 'done' ne fait rien). 'todo' = "Arrêter" :
        // fait passer doing -> todo.
        if (status === 'todo' && t.status === 'doing') {
          updateBoardTask(t.id, { status }).catch(() => load());
          keep.push({ ...t, status });
        }
      }
      return keep;
    });
    setSelected(new Set());
  };

  const columns: { id: TaskStatus; label: string; count: number }[] = [
    { id: 'todo', label: 'À faire', count: tasks.filter((t) => t.status === 'todo').length },
    { id: 'doing', label: 'En cours', count: tasks.filter((t) => t.status === 'doing').length },
    { id: 'done', label: 'Terminé', count: tasks.filter((t) => t.status === 'done').length },
  ];

  const dropIdFor = (s: TaskStatus) => (s === 'doing' ? 'in-progress' : s);

  const selectedCount = selected.size;

  const anySelected = (status: TaskStatus) => {
    if (selected.size === 0) return 0;
    return tasks.filter((t) => t.status === status && selected.has(t.id)).length;
  };

  return (
    <div className="h-full space-y-6">
      <div className="bg-gradient-to-r from-orange-900 to-stone-900 rounded-3xl p-8 flex flex-col gap-6 md:flex-row md:items-center md:justify-between border border-stone-800">
        <div>
          <h1 className="text-4xl font-serif text-white">Chaque mission, en mouvement.</h1>
          <p className="text-stone-400 mt-2">Glissez et déposez pour assigner les tâches. Les agents Hermès s'en chargeront automatiquement.</p>
        </div>

        {/* Ligne des agents de la flotte : badge statut + nom (calque sur AgentsTab) */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {FLEET_STATIC.map((meta) => {
            const live = fleet.find((f) => f.agent === meta.agent);
            const working = !!live && workingAgents.includes(live.agent);
            const status: 'idle' | 'working' = working ? 'working' : 'idle';
            return (
              <div key={meta.agent} className="flex flex-col items-center gap-1.5">
                <span
                  className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider flex items-center border ${
                    status === 'working'
                      ? 'bg-red-950 text-red-400 border-red-900/50'
                      : 'bg-green-950 text-green-400 border-green-900/50'
                  }`}
                >
                  {status === 'working' && <span className="w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5 animate-pulse" />}
                  {status === 'idle' && <span className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5" />}
                  {status}
                </span>
                <span className="text-xs text-stone-300 font-medium">{meta.name}</span>
              </div>
            );
          })}
        </div>

        <div className="flex space-x-6 text-center">
          {columns.map((col) => (
            <div key={col.id}>
              <div className="text-3xl font-serif text-orange-500">{col.count}</div>
              <div className="text-[10px] uppercase tracking-widest text-stone-500">{col.label}</div>
            </div>
          ))}
        </div>
      </div>

      {loading && <p className="text-stone-500 text-sm">Chargement du tableau…</p>}

      {selectedCount > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-stone-800 bg-stone-900/60 px-4 py-2 text-xs text-stone-300">
          <span className="mr-1 text-stone-500">{selectedCount} sélectionnée(s)</span>
          <button
            onClick={() => bulkSetStatus('doing')}
            disabled={anySelected('todo') === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-800 px-2.5 py-1.5 disabled:opacity-40 hover:border-stone-600"
          >
            <Play className="w-3.5 h-3.5" /> Démarer
          </button>
          <button
            onClick={() => bulkSetStatus('todo')}
            disabled={anySelected('doing') === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-800 px-2.5 py-1.5 disabled:opacity-40 hover:border-stone-600"
          >
            <Square className="w-3.5 h-3.5" /> Arrêter
          </button>
          <button
            onClick={() => bulkSetStatus('remove')}
            disabled={anySelected('done') === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-800 px-2.5 py-1.5 disabled:opacity-40 hover:border-stone-600"
          >
            <Trash2 className="w-3.5 h-3.5" /> Supprimer
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto rounded-lg border border-stone-800 px-2.5 py-1.5 hover:border-stone-600"
          >
            Annuler
          </button>
        </div>
      )}

      {/* Grille des colonnes affichee INCONDITIONNELLEMENT (meme si board vide),
          sinon impossible d'ajouter une tache quand 0 tache (boucle sans issue). */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {columns.map((column) => {
          const colTasks = tasks.filter((t) => t.status === column.id);
          const isTodoEmpty = column.id === 'todo' && colTasks.length === 0;
          return (
          <div
            key={column.id}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, dropIdFor(column.id))}
            className="bg-stone-900/50 border border-stone-800 rounded-3xl p-6 min-h-[500px]"
          >
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-medium text-stone-300 uppercase tracking-widest flex items-center">
                {column.id === 'doing' && <span className="w-2 h-2 rounded-full bg-cyan-400 mr-2 animate-pulse" />}
                {column.id === 'done' && <span className="w-2 h-2 rounded-full bg-stone-600 mr-2" />}
                {column.id === 'todo' && <span className="w-2 h-2 rounded-full bg-orange-500 mr-2" />}
                {column.label}
              </h3>
              <span className="text-xs text-stone-500 font-mono">{column.count}</span>
            </div>

            <div className="space-y-3">
              {colTasks.map((task) => {
                const checked = selected.has(task.id);
                return (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    onClick={(e) => {
                      // Only the explicit checkbox should toggle selection.
                      if ((e.target as HTMLElement).dataset.checkbox === '1') return;
                      e.stopPropagation();
                      setDetailTask(task);
                    }}
                    className="bg-stone-950 border border-stone-800 p-4 rounded-2xl cursor-move hover:border-stone-600 hover:bg-stone-900 transition-all group"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-3">
                        <div
                          data-checkbox="1"
                          onMouseDown={(e) => e.stopPropagation()}
                          draggable={false}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelected(task.id, !checked);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === ' ' || e.key === 'Enter') {
                              e.preventDefault();
                              toggleSelected(task.id, !checked);
                            }
                          }}
                          tabIndex={0}
                          role="checkbox"
                          aria-checked={checked}
                          className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-stone-700 bg-stone-950 text-stone-300 accent-orange-500 cursor-pointer"
                        >
                          {checked && <span className="text-[10px] leading-none">✓</span>}
                        </div>
                        <div>
                          <p className="text-sm text-stone-300 group-hover:text-stone-100">{task.title}</p>
                          {task.agent ? (
                            <span className="mt-1 inline-flex text-[11px] font-medium uppercase tracking-wide text-stone-500 border border-stone-800 rounded-lg px-2 py-0.5">
                              {task.agent}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {column.id === 'todo' && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); execBoardTask(task); }}
                              className="p-1 text-stone-600 hover:text-orange-400 transition-colors"
                              title="Démarrer (exécute l'agent)"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(task.id); }}
                              className="p-1 text-stone-600 hover:text-red-400 transition-colors"
                              title="Supprimer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        {column.id === 'doing' && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); updateTask(task.id, { status: 'todo' }); }}
                              className="p-1 text-stone-600 hover:text-stone-300 transition-colors"
                              title="Pause"
                            >
                              <Pause className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); updateTask(task.id, { status: 'todo' }); }}
                              className="p-1 text-stone-600 hover:text-stone-300 transition-colors"
                              title="Arrêter"
                            >
                              <Square className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); updateTask(task.id, { status: 'doing' }); }}
                              className="p-1 text-stone-600 hover:text-orange-400 transition-colors"
                              title="Reprendre"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(task.id); }}
                              className="p-1 text-stone-600 hover:text-red-400 transition-colors"
                              title="Supprimer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        {column.id === 'done' && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(task.id); }}
                              className="p-1 text-stone-600 hover:text-red-400 transition-colors"
                              title="Supprimer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Message "Aucune tache" uniquement dans la colonne A faire si vide. */}

            {isTodoEmpty && (
              <p className="text-center text-stone-600 text-sm mt-3">
                Aucune tâche. Ajoutez une mission ci-dessous.
              </p>
            )}

            {column.id === 'todo' && (
              <div className="mt-4 space-y-2">
                <textarea
                  ref={newTitleRef}
                  value={newTitle}
                  rows={2}
                  onChange={(e) => { setNewTitle(e.target.value); autoGrowNew(); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleAdd('todo');
                    }
                  }}
                  placeholder="Nouvelle mission… (@agent optionnel)"
                  className="w-full bg-stone-950 border border-stone-800 text-stone-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500 transition-all placeholder:text-stone-600 resize-none overflow-y-auto"
                />
              </div>
            )}
          </div>
          );
        })}
      </div>

      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTask(null)}
          onChanged={(updated) => {
            setTasks((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
            setDetailTask({ ...detailTask, ...updated });
          }}
        />
      )}
    </div>
  );
};

// ---- Task detail modal (Détails / Réponse agent) ----
type DetailTab = 'details' | 'reply';

const TaskDetailModal: React.FC<{
  task: BoardTask;
  onClose: () => void;
  onChanged: (updated: Partial<BoardTask>) => void;
}> = ({ task, onClose, onChanged }) => {
  const { state } = useApiState();
  const fleet = state?.fleet ?? [];
  const agentsList = useMemo(() => {
    const map = new Map<string, string>();
    FLEET_STATIC.forEach(f => map.set(f.agent, f.name));
    fleet.forEach(f => {
      if (f.agent && !map.has(f.agent)) {
        map.set(f.agent, f.name || f.agent);
      }
    });
    return Array.from(map.entries()).map(([agent, name]) => ({ agent, name }));
  }, [fleet]);

  const [tab, setTab] = useState<DetailTab>('reply');
  const [title, setTitle] = useState<string>(task.title || '');
  const [agent, setAgent] = useState<string>(task.agent || 'manager');
  const [notes, setNotes] = useState<string>(task.notes || '');
  const [saving, setSaving] = useState(false);

  const dirty =
    title !== (task.title || '') ||
    agent !== (task.agent || 'manager') ||
    notes !== (task.notes || '');

  const save = () => {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    const fields: Partial<Pick<BoardTask, 'title' | 'agent' | 'notes'>> = {};
    if (title !== (task.title || '')) fields.title = title;
    if (agent !== (task.agent || 'manager')) fields.agent = agent;
    if (notes !== (task.notes || '')) fields.notes = notes;
    updateBoardTask(task.id, fields)
      .then(() => {
        onChanged({ id: task.id, ...fields });
        onClose();
      })
      .catch((e) => console.error('save task failed', e))
      .finally(() => setSaving(false));
  };

  const statusLabel =
    task.status === 'done' ? 'Terminé' : task.status === 'doing' ? 'En cours' : 'À faire';

  const tabClass = (active: boolean) =>
    'px-4 py-2 text-sm rounded-t-lg ' +
    (active ? 'text-orange-400 border-b-2 border-orange-400' : 'text-stone-400 hover:text-stone-200');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-stone-900 border border-stone-700 rounded-3xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-800">
          <div className="min-w-0">
            <h3 className="text-base font-medium text-stone-100 truncate">{task.title}</h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Agent : {task.agent || 'manager'} · Statut : {statusLabel}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-stone-500 hover:text-stone-200 transition-colors"
            title="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-1 px-6 pt-4 border-b border-stone-800">
          <button onClick={() => setTab('reply')} className={tabClass(tab === 'reply')}>
            Réponse agent
          </button>
          <button onClick={() => setTab('details')} className={tabClass(tab === 'details')}>
            Détails
          </button>
        </div>

        <div className="px-6 py-5 max-h-[60vh] overflow-y-auto">
          {tab === 'reply' ? (
            task.notes ? (
              <pre className="whitespace-pre-wrap text-sm text-stone-200 font-sans leading-relaxed">{task.notes}</pre>
            ) : (
              <p className="text-sm text-stone-500">Aucune réponse d'agent pour l'instant. Exécutez la tâche pour la générer.</p>
            )
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-xs uppercase tracking-wide text-stone-500">Titre</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full bg-stone-950 border border-stone-800 text-stone-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500 transition-all"
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-stone-500">Agent</label>
                <select
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                  className="mt-1 w-full bg-stone-950 border border-stone-800 text-stone-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500 transition-all"
                >
                  {agentsList.map((a) => (
                    <option key={a.agent} value={a.agent}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-stone-500">Notes / réponse</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={8}
                  className="mt-1 w-full bg-stone-950 border border-stone-800 text-stone-200 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500 transition-all"
                  placeholder="Réponse de l'agent ou notes manuelles…"
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-stone-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors"
          >
            Fermer
          </button>
          {tab === 'details' && (
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 text-sm bg-orange-500 text-stone-950 rounded-2xl font-medium hover:bg-orange-400 transition-colors disabled:opacity-50"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
