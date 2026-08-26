import React, { createContext, useContext, useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import type { Notification as ToastNotification } from './NotificationToast';
import { getNotifications, addNotification, clearNotifications, type Notification as ApiNotification } from '../../api';
import { subscribeSse } from '../../lib/sse';

interface NotificationContextValue {
  notifications: ToastNotification[];
  add: (type: 'success' | 'error' | 'warning' | 'info', title: string, message: string, agent?: string) => void;
  clear: (id: string) => void;
  clearAll: () => void;
  unreadCount: number;
  markRead: (id: string) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationProvider');
  }
  return ctx;
}

/**
 * Convertit une notification serveur (api.Notification : ts epoch SECONDE, sans
 * id) en notification toast (id stable + timestamp en MILLISECONDES pour
 * `new Date(timestamp)`). Avant l'audit 2026-08-07, l'id et le timestamp
 * etaient absents/incorrects -> `new Date(undefined)` = Invalid Date et
 * clear()/keys React casses.
 */
function toToast(n: ApiNotification): ToastNotification {
  const tsMs = (n.ts ?? Date.now()) * 1000;
  return {
    id: `notif-${n.ts ?? Date.now()}-${n.title}-${n.message}`.slice(0, 80),
    type: n.type,
    title: n.title,
    message: n.message,
    agent: n.agent ?? undefined,
    timestamp: tsMs,
    read: false,
  };
}

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<ToastNotification[]>([]);
  const [visible, setVisible] = useState(false);

  // Chargement initial via REST — les suivantes arrivent par le SSE partage.
  // (Le poll REST 5s a ete SUPPRIME : le serveur pousse chaque notification
  // UNE seule fois via /events, audit 2026-08-07.)
  useEffect(() => {
    let cancelled = false;
    getNotifications()
      .then((res) => {
        if (!cancelled && res.ok && res.notifications) {
          setNotifications(res.notifications.map(toToast));
        }
      })
      .catch(() => { /* silencieux : le SSE prendra le relais */ });
    return () => { cancelled = true; };
  }, []);

  // Flux SSE partage (une SEULE connexion /events pour toute l'app, lib/sse.ts).
  useEffect(() => {
    const unsub = subscribeSse('notification', (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as ApiNotification;
        setNotifications((prev) => {
          const t = toToast(data);
          // Anti-doublon (chevauchement REST initial / push SSE) : meme id -> ignore.
          if (prev.some((p) => p.id === t.id)) return prev;
          return [t, ...prev].slice(0, 100);
        });
      } catch {
        // Ignore les payloads mal formes.
      }
    });
    return unsub;
  }, []);

  const notify = (type: 'success' | 'error' | 'warning' | 'info', title: string, message: string, agent?: string) => {
    addNotification(type, title, message, agent).then(() => {
      // La notification sera poussee par le flux SSE (ou le prochain fetch).
    });
  };

  const clear = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    // Persiste l'effacement côté serveur (sinon réapparition au F5).
    clearNotifications([id]).catch(() => {});
  };

  const clearAll = () => {
    setNotifications([]);
    // ids=null => tout effacer côté serveur.
    clearNotifications(null).catch(() => {});
  };

  const markRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        add: notify,
        clear,
        clearAll,
        unreadCount,
        markRead,
      }}
    >
      {children}

      {/* Notification Bell Button */}
      <button
        onClick={() => setVisible(!visible)}
        className="fixed bottom-4 right-4 z-40 w-14 h-14 bg-orange-600 text-white rounded-full shadow-lg hover:bg-orange-500 transition-colors flex items-center justify-center"
        title="Notifications"
      >
        <div className="relative">
          <Bell className="w-6 h-6" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
              {unreadCount}
            </span>
          )}
        </div>
      </button>

      {/* Panneau de notifications (dropdown au-dessus de la cloche) */}
      {visible && (
        <div className="fixed bottom-20 right-4 z-40 w-80 max-h-[70vh] overflow-y-auto bg-stone-900 border border-stone-700 rounded-xl shadow-2xl">
          <div className="flex items-center justify-between px-4 py-2 border-b border-stone-800 sticky top-0 bg-stone-900">
            <span className="text-sm font-medium text-stone-200">Notifications</span>
            <div className="flex items-center gap-2">
              <button
                onClick={clearAll}
                className="text-xs text-stone-500 hover:text-orange-300 transition-colors"
                title="Tout effacer"
              >
                Tout effacer
              </button>
              <button
                onClick={() => setVisible(false)}
                className="text-stone-500 hover:text-stone-300"
                title="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          {notifications.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-stone-600 italic">
              Aucune notification pour l'instant.
            </div>
          ) : (
            <ul className="divide-y divide-stone-800">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`px-4 py-2.5 text-sm cursor-pointer hover:bg-stone-800/50 transition-colors ${n.read ? '' : 'bg-stone-800/30'}`}
                  onClick={() => markRead(n.id)}
                >
                  <div className="flex items-start gap-2">
                    <span className="flex-1 min-w-0">
                      <span className={`font-medium ${n.read ? 'text-stone-400' : 'text-stone-200'}`}>
                        {n.title}
                      </span>
                      {n.agent && (
                        <span className="ml-1 text-xs text-stone-500">[{n.agent}]</span>
                      )}
                      <span className="block text-xs text-stone-400 mt-0.5 break-words">{n.message}</span>
                      <span className="block text-xs text-stone-600 mt-1">
                        {new Date(n.timestamp).toLocaleString('fr-FR')}
                      </span>
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); clear(n.id); }}
                      className="text-stone-500 hover:text-red-400 shrink-0"
                      title="Supprimer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </NotificationContext.Provider>
  );
};
