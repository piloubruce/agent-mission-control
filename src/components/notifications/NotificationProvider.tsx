import React, { createContext, useContext, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { NotificationToast, type Notification as ToastNotification } from './NotificationToast';
import { getNotifications, addNotification, type Notification as ApiNotification } from '../../api';
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
  };

  const clearAll = () => {
    setNotifications([]);
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

      {/* Notification Toast Container */}
      <div className="fixed top-4 right-4 z-50 max-w-sm space-y-2">
        {notifications.slice(0, 5).map((n) => (
          <NotificationToast key={n.id} notification={n} onClose={() => clear(n.id)} />
        ))}
      </div>

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
    </NotificationContext.Provider>
  );
};
