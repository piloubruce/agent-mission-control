// lib/sse.ts — Connexion SSE /events UNIQUE partagee par toute l'application.
//
// Avant (audit 2026-08-07, DEVELOPPEUR) : useApiState + NotificationProvider +
// FleetLivePanel ouvraient CHACUN leur propre EventSource /events -> 2-4
// connexions serveur, chacune recevant le state toutes les 3s. A cote du
// broadcast mutualise cote serveur (1 calcul -> tous les clients), on
// mutualise aussi cote client : un seul flux, distribue par abonnements.
//
// La connexion n'est ouverte qu'a la demande (premier abonne) et fermee quand
// le dernier abonne se retire.

type Listener = (ev: MessageEvent) => void;

const _typeListeners = new Map<string, Set<Listener>>();
const _openListeners = new Set<() => void>();
const _errorListeners = new Set<() => void>();
let _es: EventSource | null = null;
let _connected = false;

function dispatch(type: string, ev: MessageEvent) {
  const set = _typeListeners.get(type);
  if (set) {
    for (const fn of [...set]) fn(ev);
  }
}

function ensure() {
  if (_es) return;
  _es = new EventSource('/events');
  _es.onopen = () => {
    _connected = true;
    for (const fn of [..._openListeners]) fn();
  };
  _es.onerror = () => {
    // Note : onerror se declenche aussi a la fermeture normale (close()).
    // Les abonnes decident ce qu'ils font (fallback REST, flag sseDown...).
    _connected = false;
    for (const fn of [..._errorListeners]) fn();
  };
  _es.onmessage = (ev: MessageEvent) => dispatch('message', ev);
  for (const type of ['state', 'notification', 'log']) {
    _es.addEventListener(type, (ev: MessageEvent) => dispatch(type, ev));
  }
}

export function reconnectSse() {
  if (_es) {
    try {
      _es.close();
    } catch {
      /* ignore */
    }
    _es = null;
    _connected = false;
  }
  if (_typeListeners.size > 0 || _openListeners.size > 0 || _errorListeners.size > 0) {
    ensure();
  }
}

function maybeClose() {
  if (_typeListeners.size === 0 && _openListeners.size === 0 && _errorListeners.size === 0) {
    if (_es) {
      try { _es.close(); } catch { /* ignore */ }
      _es = null;
    }
    _connected = false;
  }
}

/** S'abonner a un type d'evenement SSE ('state' | 'notification' | 'log' | ...).
 *  Retourne la fonction de desabonnement. */
export function subscribeSse(type: string, fn: Listener): () => void {
  let set = _typeListeners.get(type);
  if (!set) {
    set = new Set();
    _typeListeners.set(type, set);
  }
  set.add(fn);
  ensure();
  return () => {
    set.delete(fn);
    if (set.size === 0) _typeListeners.delete(type);
    maybeClose();
  };
}

/** S'abonner a l'ouverture de la connexion (utile pour arreter un fallback poll). */
export function subscribeSseOpen(fn: () => void): () => void {
  _openListeners.add(fn);
  ensure();
  return () => {
    _openListeners.delete(fn);
    maybeClose();
  };
}

/** S'abonner aux erreurs de la connexion (declenche le fallback REST). */
export function subscribeSseError(fn: () => void): () => void {
  _errorListeners.add(fn);
  ensure();
  return () => {
    _errorListeners.delete(fn);
    maybeClose();
  };
}

/** Etat courant de la connexion partagee. */
export function isSseConnected(): boolean {
  return _connected;
}
