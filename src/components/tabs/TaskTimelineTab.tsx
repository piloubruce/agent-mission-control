import React, { useEffect, useState } from 'react';
import { getBoard, updateBoardTask, deleteBoardTask, sendMessage, type BoardTask } from '../../api';
import { TasksTimeline } from '../tasks/TasksTimeline';

// Onglet TIMELINE : vue chronologique des tâches du board (au lieu de la
// liste Kanban plate de l'onglet TÂCHES). Charge le même board que TasksTab
// et délègue le rendu + les actions (update/delete/execute) à TasksTimeline.
export const TaskTimelineTab: React.FC = () => {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    getBoard()
      .then((data) => setTasks(data))
      .catch((e) => console.error('load board failed', e))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

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

  // Execute a board task via the agent (DRY from TasksTab.execBoardTask).
  const execBoardTask = (task: BoardTask) => {
    const agent = task.agent || 'manager';
    updateTask(task.id, { status: 'doing' });
    sendMessage(agent, '', task.title, [], false)
      .then((res: any) => {
        const sid = res && res.session_id ? res.session_id : '';
        if (!sid) { updateTask(task.id, { status: 'todo' }); return; }
        const poll = (tries: number) => {
          if (tries <= 0) { updateTask(task.id, { status: 'done', notes: '(terminé, réponse non lue)' }); return; }
          fetch(`/api/messages/status?agent=${encodeURIComponent(agent)}&session_id=${encodeURIComponent(sid)}`)
            .then((r) => r.json())
            .then((st: any) => {
              if (st.running === false) {
                const replyText = st.text || (st.error ? ('ERREUR: ' + st.error) : '');
                updateTask(task.id, { status: 'done', notes: String(replyText).slice(0, 4000) });
              } else {
                setTimeout(() => poll(tries - 1), 1500);
              }
            })
            .catch(() => setTimeout(() => poll(tries - 1), 1500));
        };
        poll(80);
      })
      .catch((err: any) => {
        console.error(err);
        updateTask(task.id, { status: 'todo' });
      });
  };

  return (
    <div className="w-full space-y-6">
      <div className="border-b border-stone-800 pb-6">
        <h1 className="text-5xl font-serif text-stone-100">Timeline.</h1>
        <p className="text-stone-500 mt-2">Vue chronologique des missions du board (par date de création).</p>
      </div>
      {loading && <p className="text-stone-500 text-sm">Chargement…</p>}
      {!loading && (
        <TasksTimeline
          tasks={tasks}
          onUpdate={(task, fields) => updateTask(task.id, fields)}
          onDelete={(task) => handleDelete(task.id)}
          onExecute={(task) => execBoardTask(task)}
        />
      )}
    </div>
  );
};
