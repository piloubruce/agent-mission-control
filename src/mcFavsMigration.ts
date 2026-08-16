/**
 * MIGRATION ONE-SHOT des favoris de modeles: localStorage -> serveur (mc_favs.json).
 *
 * Ancien format (pre-2026-08-05):
 *   cle   : `mc_fav_<agent>`
 *   valeur: JSON string[] de "<provider>/<model_id>"
 *
 * Nouveau format: API /api/mc_favs (GET ?agent=, POST {agent, ids}).
 *
 * Comportement: pour chaque cle `mc_fav_*` restante, on fusionne (union) avec
 * les favoris deja presents cote serveur, on POST, et on supprime la cle
 * localStorage UNIQUEMENT si l'ecriture serveur a reussi.
 * Idempotent: sans cle `mc_fav_*`, la fonction ne fait aucun appel reseau.
 * Non bloquant: appelee en fire-and-forget au bootstrap, n'impacte pas l'UI.
 */

const PREFIX = 'mc_fav_';

/** Fonction PURE: union sans doublons, ordre serveur d'abord puis nouveaux locaux. */
export function mergeFavs(localIds: string[], serverIds: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...serverIds, ...localIds]) {
    if (typeof id !== 'string') continue;
    const v = id.trim();
    if (!v || !v.includes('/') || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Parse tolerant d'une valeur localStorage -> string[] valides. */
export function parseLegacyValue(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is string => typeof x === 'string' && x.trim() !== '' && x.includes('/'),
    );
  } catch {
    return [];
  }
}

async function serverGet(agent: string): Promise<string[]> {
  const r = await fetch('/api/mc_favs?agent=' + encodeURIComponent(agent));
  if (!r.ok) throw new Error('GET mc_favs ' + r.status);
  const j = await r.json();
  return Array.isArray(j?.ids) ? j.ids.filter((x: unknown) => typeof x === 'string') : [];
}

async function serverPost(agent: string, ids: string[]): Promise<void> {
  const r = await fetch('/api/mc_favs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, ids }),
  });
  if (!r.ok) throw new Error('POST mc_favs ' + r.status);
  const j = await r.json();
  if (j?.ok !== true) throw new Error('POST mc_favs !ok');
}

let done = false;

export async function migrateLegacyFavs(): Promise<void> {
  if (done) return;
  done = true;

  let keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
  } catch {
    return; // localStorage indisponible (mode prive) -> on ignore
  }
  if (keys.length === 0) return; // idempotence: rien a faire

  for (const key of keys) {
    const agent = key.slice(PREFIX.length);
    if (!agent) continue;
    try {
      const localIds = parseLegacyValue(localStorage.getItem(key));
      // Ecriture serveur UNIQUEMENT si le localStorage avait des entrees:
      // jamais de POST d'un tableau vide qui ecraserait les favs serveur.
      if (localIds.length > 0) {
        const serverIds = await serverGet(agent);
        await serverPost(agent, mergeFavs(localIds, serverIds));
      }
      localStorage.removeItem(key); // seul point de nettoyage, apres succes
      console.log(`[mc-favs migration] agent ${agent}: ${localIds.length} migres`);
    } catch (e) {
      console.warn(`[mc-favs migration] agent ${agent}: echec, cle conservee`, e);
    }
  }
  console.log('[mc-favs migration] termine');
}
