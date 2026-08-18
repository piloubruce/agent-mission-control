import React from 'react';
import type { BoardTask } from '../../api';
import { Calendar, CheckCircle, Clock, AlertCircle, X, Check } from 'lucide-react';

// Formatte une date sans dépendance externe (remplace date-fns).
const pad = (n: number) => String(n).padStart(2, '0');
const format = (d: Date, fmt: string): string => {
  if (fmt === 'yyyy-MM-dd') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (fmt === 'HH:mm') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toISOString();
};

interface TimelineViewProps {
  tasks: BoardTask[];
  onUpdate: (task: BoardTask, fields: Partial<BoardTask>) => void;
  onDelete: (task: BoardTask) => void;
  onExecute: (task: BoardTask) => void;
}

export const TasksTimeline: React.FC<TimelineViewProps> = ({ tasks, onDelete, onExecute }) => {
  // Group tasks by day
  const tasksByDay = tasks.reduce<Record<string, BoardTask[]>>((acc, task) => {
    const day = task.created_at ? format(new Date(task.created_at * 1000), 'yyyy-MM-dd') : 'today';
    if (!acc[day]) acc[day] = [];
    acc[day].push(task);
    return acc;
  }, {});

  const sortedDays = Object.keys(tasksByDay).sort().reverse();
  
  // Get status color
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'done': return { text: 'text-emerald-500', dot: 'bg-emerald-500/20 border-emerald-500' };
      case 'doing': return { text: 'text-cyan-400', dot: 'bg-cyan-400/20 border-cyan-400' };
      case 'todo': return { text: 'text-orange-400', dot: 'bg-orange-400/20 border-orange-400' };
      default: return { text: 'text-stone-400', dot: 'bg-stone-400/20 border-stone-400' };
    }
  };

  // Get status icon
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'done': return CheckCircle;
      case 'doing': return Clock;
      case 'todo': return Calendar;
      default: return AlertCircle;
    }
  };

  return (
    <div className="space-y-6">
      {sortedDays.map(day => (
        <div key={day} className="bg-stone-900/30 border border-stone-800 rounded-2xl p-4">
          <h3 className="text-xs text-stone-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Calendar className="w-3 h-3" />
            {day}
          </h3>
          
          <div className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-6 top-4 bottom-4 w-0.5 bg-stone-700/50" />
            
            {/* Task cards */}
            <div className="space-y-4">
              {tasksByDay[day]!
                .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
                .map(task => {
                  const Icon = getStatusIcon(task.status);
                  const colors = getStatusColor(task.status);
                  
                  return (
                    <div 
                      key={task.id} 
                      className="ml-6 pl-6 relative"
                    >
                      {/* Status dot */}
                      <div className="absolute left-0 top-1">
                        <div className={`w-3 h-3 rounded-full border ${colors.dot}`} />
                      </div>
                      
                      {/* Task card */}
                      <div className="bg-stone-950 border border-stone-800 rounded-xl p-4 hover:border-stone-600 transition-all">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <Icon className={`w-3 h-3 ${colors.text}`} />
                              <h4 className="text-sm text-stone-300">{task.title}</h4>
                              {task.agent && (
                                <span className="text-[10px] uppercase tracking-wider text-stone-500 border border-stone-700 rounded px-1.5 py-0.5">
                                  {task.agent}
                                </span>
                              )}
                            </div>
                            {task.notes && (
                              <p className="text-xs text-stone-400 mt-1">{task.notes.slice(0, 200)}</p>
                            )}
                            <div className="text-[10px] text-stone-600 mt-2">
                              Créé: {task.created_at ? format(new Date(task.created_at * 1000), 'HH:mm') : 'N/A'}
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-1 ml-3">
                            {task.status === 'todo' && (
                              <button
                                onClick={() => onExecute(task)}
                                className="p-1 text-stone-400 hover:text-orange-400 transition-colors"
                                title="Exécuter"
                              >
                                <Check className="w-3 h-3" />
                              </button>
                            )}
                            <button
                              onClick={() => onDelete(task)}
                              className="p-1 text-stone-400 hover:text-red-400 transition-colors"
                              title="Supprimer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      ))}
      
      {tasks.length === 0 && (
        <div className="text-center text-stone-600 py-12">
          <p className="text-sm">Aucune tâche dans la timeline.</p>
        </div>
      )}
    </div>
  );
};