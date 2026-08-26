import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
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

  // Position flottante de la cloche (draggable)
  const [bellPos, setBellPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem('mc_bell_pos');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return parsed;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  });

  // Gestion du drag de la cloche
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initX: number; initY: number }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });
  const hasMovedRef = useRef(false);

  const startDrag = (clientX: number, clientY: number) => {
    const currentX = bellPos?.x ?? (window.innerWidth - 72);
    const currentY = bellPos?.y ?? (window.innerHeight - 80);
    isDraggingRef.current = true;
    hasMovedRef.current = false;
    dragStartRef.current = {
      startX: clientX,
      startY: clientY,
      initX: currentX,
      initY: currentY,
    };
  };

  useEffect(() => {
    const handleMove = (clientX: number, clientY: number) => {
      if (!isDraggingRef.current) return;
      const dx = clientX - dragStartRef.current.startX;
      const dy = clientY - dragStartRef.current.startY;
      if (Math.hypot(dx, dy) > 4) {
        hasMovedRef.current = true;
      }
      const newX = Math.max(8, Math.min(window.innerWidth - 64, dragStartRef.current.initX + dx));
      const newY = Math.max(8, Math.min(window.innerHeight - 64, dragStartRef.current.initY + dy));
      setBellPos({ x: newX, y: newY });
    };

    const handleEnd = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setBellPos((pos) => {
        if (pos) {
          try {
            localStorage.setItem('mc_bell_pos', JSON.stringify(pos));
          } catch {
            /* ignore */
          }
        }
        return pos;
      });
    };

    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);
    const onMouseUp = () => handleEnd();

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = () => handleEnd();

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

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

  const bellStyle: React.CSSProperties = bellPos
    ? { left: `${bellPos.x}px`, top: `${bellPos.y}px`, right: 'auto', bottom: 'auto' }
    : {};

  // Calcul position panneau de notification
  const panelStyle: React.CSSProperties = React.useMemo(() => {
    if (!bellPos) {
      return { bottom: '5rem', right: '1rem' };
    }
    const isTopHalf = bellPos.y < window.innerHeight / 2;
    const isLeftHalf = bellPos.x < window.innerWidth / 2;
    const style: React.CSSProperties = {};
    if (isTopHalf) {
      style.top = `${bellPos.y + 60}px`;
    } else {
      style.bottom = `${window.innerHeight - bellPos.y + 8}px`;
    }
    if (isLeftHalf) {
      style.left = `${Math.max(8, bellPos.x)}px`;
    } else {
      style.right = `${Math.max(8, window.innerWidth - bellPos.x - 56)}px`;
    }
    return style;
  }, [bellPos]);

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

      {/* Notification Bell Button (Flottant et Déplaçable) */}
      <div
        style={bellStyle}
        onMouseDown={(e) => {
          if (e.button === 0) startDrag(e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          if (e.touches.length > 0) startDrag(e.touches[0].clientX, e.touches[0].clientY);
        }}
        onClick={() => {
          if (!hasMovedRef.current) {
            setVisible((v) => !v);
          }
        }}
        className={`fixed ${!bellPos ? 'bottom-4 right-4' : ''} z-40 w-14 h-14 bg-orange-600 text-white rounded-full shadow-2xl hover:bg-orange-500 active:scale-95 transition-transform flex items-center justify-center cursor-grab active:cursor-grabbing select-none touch-none`}
        title="Notifications (glisser pour déplacer)"
      >
        <div className="relative pointer-events-none">
          <Bell className="w-6 h-6" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-bold">
              {unreadCount}
            </span>
          )}
        </div>
      </div>

      {/* Panneau de notifications (dropdown positionné intelligemment) */}
      {visible && (
        <div
          style={panelStyle}
          className="fixed z-50 w-80 max-w-[90vw] max-h-[70vh] overflow-y-auto bg-stone-900 border border-stone-700 rounded-xl shadow-2xl backdrop-blur-md"
        >
          <div className="flex items-center justify-between px-4 py-2 border-b border-stone-800 sticky top-0 bg-stone-900/95">
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
