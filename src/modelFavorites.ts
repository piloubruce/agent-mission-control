/**
 * Favoris de modeles PAR AGENT — persistance SERVEUR (mc_favs.json).
 * Structure disque: { "<agent>": ["<provider>/<model_id>", ...], ... }
 * Plus aucun localStorage: les favoris survivent au changement de navigateur,
 * au vidage de cache, au rebuild du dashboard et au redemarrage du service.
 */

import { getMcFavs, setMcFavs } from './api';

export const favKey = (provider: string, id: string): string => `${provider}/${id}`;

export async function loadFavs(agent: string): Promise<string[]> {
  if (!agent) return [];
  return getMcFavs(agent);
}

export async function saveFavs(agent: string, ids: string[]): Promise<void> {
  if (!agent) return;
  await setMcFavs(agent, ids);
}

/** Calcule la nouvelle liste et declenche l'ecriture serveur (fire-and-forget). */
export function toggleFav(agent: string, current: string[], key: string): string[] {
  const next = current.includes(key)
    ? current.filter((k) => k !== key)
    : [...current, key];
  void saveFavs(agent, next);
  return next;
}

/** Tri stable: favoris d'abord, ordre original conserve dans chaque groupe. */
export function sortFavFirst<T>(items: T[], keyOf: (item: T) => string, favSet: Set<string>): T[] {
  const favs: T[] = [];
  const rest: T[] = [];
  for (const it of items) (favSet.has(keyOf(it)) ? favs : rest).push(it);
  return favs.concat(rest);
}
