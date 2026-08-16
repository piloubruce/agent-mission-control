/**
 * Drag-and-drop natif (HTML5) avec ordre persisté en localStorage.
 * Aucune dépendance ajoutée (@dnd-kit non nécessaire).
 *
 * Usage :
 *   const dnd = useDndOrder('mc_overview_widgets', ['a','b','c']);
 *   dnd.ordered.map(id => <div {...dnd.itemProps(id)}>...</div>)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { loadOrder, saveOrder, applyOrder, reorder } from './dndOrder';

export interface DndItemProps {
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  className: string;
  'data-dnd-id': string;
}

export function useDndOrder(storageKey: string, ids: string[], onCommit?: (next: string[]) => void) {
  const [order, setOrder] = useState<string[] | null>(() => loadOrder(storageKey));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Si de nouveaux ids apparaissent (agent créé), ils sont ajoutés en fin.
  const ordered = useMemo(() => applyOrder(ids, order), [ids, order]);

  useEffect(() => {
    if (order && ids.length && !order.some((id) => ids.includes(id))) {
      // ordre totalement obsolète -> on repart de zéro
      setOrder(null);
    }
  }, [ids, order]);

  const commit = useCallback((next: string[]) => {
    setOrder(next);
    saveOrder(storageKey, next);
    if (onCommit) onCommit(next);
  }, [storageKey, onCommit]);

  const reset = useCallback(() => {
    setOrder(null);
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }, [storageKey]);

  const itemProps = useCallback((id: string): DndItemProps => ({
    draggable: true,
    'data-dnd-id': id,
    onDragStart: (e: DragEvent) => {
      setDragging(id);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', id); } catch { /* Safari */ }
    },
    onDragEnd: () => { setDragging(null); setOver(null); },
    onDragOver: (e: DragEvent) => {
      if (!dragging || dragging === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== id) setOver(id);
    },
    onDragLeave: () => { if (over === id) setOver(null); },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragging || e.dataTransfer.getData('text/plain');
      setDragging(null);
      setOver(null);
      if (!from || from === id) return;
      commit(reorder(ordered, from, id));
    },
    className: [
      'mc-draggable',
      dragging === id ? 'mc-dragging' : '',
      over === id ? 'mc-drop-target' : '',
    ].filter(Boolean).join(' '),
  }), [dragging, over, ordered, commit]);

  return { ordered, itemProps, reset, setOrder, isCustom: !!order };
}
