/**
 * Petit utilitaire d'ordre persisté pour le drag-and-drop (localStorage).
 */

/** Lit un ordre sauvegardé (tableau de clés) ou null. */
export function loadOrder(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[];
    }
  } catch { /* ignore */ }
  return null;
}

export function saveOrder(key: string, order: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(order)); } catch { /* ignore */ }
}

/**
 * Trie `ids` selon `order` : les éléments connus d'abord (dans l'ordre
 * sauvegardé), puis les nouveaux (non présents dans l'ordre) à la fin.
 */
export function applyOrder(ids: string[], order: string[] | null): string[] {
  if (!order || !order.length) return ids;
  const known = order.filter((id) => ids.includes(id));
  const rest = ids.filter((id) => !known.includes(id));
  return [...known, ...rest];
}

/** Déplace l'élément `from` juste avant/à la place de `to`. */
export function reorder(ids: string[], from: string, to: string): string[] {
  if (from === to) return ids;
  const next = ids.filter((id) => id !== from);
  const idx = next.indexOf(to);
  if (idx < 0) return ids;
  next.splice(idx, 0, from);
  return next;
}
