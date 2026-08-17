import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Paperclip,
  Trash2,
  Send,
  Loader2,
  FileText,
  Image as ImageIcon,
  CheckSquare,
  Square,
  Copy,
  Check,
  Pencil,
  Search,
} from 'lucide-react';
import {
  getState,
  getMessageSessions,
  sendMessage,
  getMessageStatus,
  deleteMessageSessions,
  deleteMessage,
  deleteAttachment,
  uploadMessageFile,
  useApiState,
  subscribeChatStream,
  MessageSession,
  MessageStatus,
  FleetAgent,
} from '../../api';
import { agentStatusFromStrings, agentStatusClasses } from '../../types';
import { MessagesSearch, type MessageFilter } from '../messages/MessagesSearch';

// Extensions d'image reconnues -> miniature cliquable (apercu reel).
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

function isImagePath(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase() || '';
  return IMG_EXT.includes(ext);
}

// Copie un texte dans le presse-papier. Prefere l'API moderne
// navigator.clipboard.writeText ; repli sur document.execCommand('copy')
// quand elle n'est pas disponible (contexte non securise / ancien navigateur).
// Retourne true si la copie a reussi, false sinon (pour feedback utilisateur).
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* tombe dans le repli ci-dessous */
  }
  // Repli : textarea hors ecran + execCommand('copy').
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Hook de copie avec feedback visuel temporise (2s). Utilise par le bouton
// « Copier » de chaque bulle agent.
function useCopy(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };
  // Nettoyage du timer au demontage pour eviter un setState sur un composant
  // deja defait (warning React).
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  return { copied, copy };
}

// Bouton « Copier » discret en bas a droite d'une bulle agent.
// Affiche une icone Copy, puis Check + « Copie ! » pendant ~2s (feedback
// via le hook useCopy). Style aligne sur les autres boutons lucide du dashboard.
const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      title={copied ? 'Copie !' : 'Copier le message'}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] transition-colors ${
        copied
          ? 'text-green-400'
          : 'text-stone-500 hover:text-stone-200 hover:bg-stone-700/60'
      }`}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copie !' : 'Copier'}
    </button>
  );
};

// Pastille de statut de generation dans la bulle agent (FEATURE 3).
//  - running=true  -> BLEU + fleche bas (↓) : l'agent genere encore du texte
//                     (bulle de streaming, presente des le debut).
//  - running=true + phase='finalizing' -> ORANGE + spinner : le modele a fini
//                     de generer mais des sous-process (outils terminal) tournent
//                     encore cote serveur. La coche verte n'apparait qu'apres.
//  - running=false -> VERT + check (✓)      : reponse terminee (message final).
// Placee en bas a DROITE de la bulle (slot fixe via ml-auto dans un
// container flex justify-between -> aucun deplacement quand Copier apparait).
const StatusDot: React.FC<{ running: boolean; phase?: string | null }> = ({
  running,
  phase,
}) => {
  const finalizing = running && phase === 'finalizing';
  return (
    <span
      title={
        finalizing
          ? 'finalisation en cours (actions en arriere-plan)'
          : running
            ? 'en cours de generation'
            : 'reponse terminee'
      }
      className={`ml-auto shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium ${
        finalizing
          ? 'bg-orange-500/20 text-orange-300'
          : running
            ? 'bg-blue-500/20 text-blue-300'
            : 'bg-green-500/20 text-green-300'
      }`}
    >
      {finalizing ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : running ? (
        <span className="leading-none">↓</span>
      ) : (
        <Check className="w-3 h-3" />
      )}
      {finalizing && <span>finalisation…</span>}
    </span>
  );
};

// -------------------------------------------------------------------------
// FEATURE (2026-08-02) : repli par defaut du reasoning / outils dans la bulle
// agent. Le backend stocke TOUTE la stdout de `hermes chat` dans m.text
// (reasoning <thinking>, appels outils/terminal, tout melange). On parse cote
// front pour extraire les blocs non-final et les masquer dans une section
// repliable. Le texte final (hors balises) reste toujours visible.
// -------------------------------------------------------------------------
type ParsedSegment =
  | { kind: 'final'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; text: string };

function parseAgentText(raw: string): ParsedSegment[] {
  if (!raw) return [];
  const segments: ParsedSegment[] = [];
  // Capture non-gourmande, multi-ligne. Balises connues Hermes :
  //  <thinking>...</thinking>  /  <think>...</think>
  //  <tool_call>...</tool_call>  /  <tool>...</tool>
  const re = /<(thinking|think)>([\s\S]*?)<\/(thinking|think)>|<(tool_call|tool)>([\s\S]*?)<\/(tool_call|tool)>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      const t = raw.slice(last, m.index).trim();
      if (t) segments.push({ kind: 'final', text: t });
    }
    const body = (m[2] ?? m[5] ?? '').trim();
    const tag = (m[1] ?? m[4] ?? '').toLowerCase();
    if (body) {
      segments.push(tag.startsWith('think') ? { kind: 'thinking', text: body } : { kind: 'tool', text: body });
    }
    last = re.lastIndex;
  }
  if (last < raw.length) {
    const t = raw.slice(last).trim();
    if (t) segments.push({ kind: 'final', text: t });
  }
  return segments;
}

const AgentMessageBody: React.FC<{ text: string }> = ({ text }) => {
  const segments = parseAgentText(text);
  const think = segments.filter((s) => s.kind === 'thinking') as Extract<ParsedSegment, { kind: 'thinking' }>[];
  const tools = segments.filter((s) => s.kind === 'tool') as Extract<ParsedSegment, { kind: 'tool' }>[];
  const finals = segments.filter((s) => s.kind === 'final') as Extract<ParsedSegment, { kind: 'final' }>[];

  const [open, setOpen] = useState(false);
  const hasHidden = think.length > 0 || tools.length > 0;

  const finalText = finals.map((s) => s.text).join('\n\n').trim();
  const hiddenCount = think.length + tools.length;

  return (
    <>
      {finalText ? <span>{finalText}</span> : null}
      {hasHidden && (
        <div className="mt-2 border-t border-stone-700/60 pt-1.5">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 transition-colors"
          >
            <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
            {open ? 'Masquer' : `Réflexion / commandes (${hiddenCount})`}
          </button>
          {open && (
            <div className="mt-1.5 space-y-2">
              {think.map((s, idx) => (
                <pre
                  key={`t${idx}`}
                  className="text-[11px] text-stone-400 bg-stone-900/70 border border-stone-700/50 rounded-md p-2 whitespace-pre-wrap break-words"
                >{`💭 Réflexion :\n${s.text}`}</pre>
              ))}
              {tools.map((s, idx) => (
                <pre
                  key={`c${idx}`}
                  className="text-[11px] text-stone-300 bg-stone-900/70 border border-stone-700/50 rounded-md p-2 whitespace-pre-wrap break-words font-mono"
                >{`⚙️ Commandes / outils :\n${s.text}`}</pre>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
};

// Sentinelle pour "supprimer TOUTES les sessions d'un agent".
const ALL = '__all__';

const POLL_MS = 1500;

export const MessagesTab: React.FC<{ initialAgent?: string }> = ({ initialAgent }) => {
  // --- Catalogue d'agents (lu depuis /api/state -> fleet, noms COMPLETS) ---
  const [agents, setAgents] = useState<FleetAgent[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('');

  // --- Sessions de l'agent actif ---
  const [sessions, setSessions] = useState<MessageSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // --- Streaming temps reel du message en cours ---
  const [liveStatus, setLiveStatus] = useState<MessageStatus | null>(null);

  // --- Agents en cours de reponse (pour pastille vert/rouge dans le selecteur) ---
  const [busyAgents, setBusyAgents] = useState<Set<string>>(new Set());

  // FEATURE 4 (bug): source de verite partagee avec l'onglet AGENTS.
  // working_agents vient de /api/state (SSE 3s) = read_working_agents() qui
  // scanne /proc pour `hermes chat -p <profile>`. Origine-agnostique :
  // couvre aussi les messages Telegram (lances par le gateway, pas server.py).
  // On combine avec busyAgents (suivi local optimiste dashboard) pour un
  // affichage coherent entre les deux onglets, sans regresser le feedback
  // instantane du dashboard.
  const { state: apiState } = useApiState();
  const workingAgents = apiState?.working_agents ?? [];
  const waitingAgents = (apiState as any)?.waiting_agents ?? [];

  // When opened from an agent card, pre-select that agent.
  useEffect(() => {
    if (initialAgent && (!agents.length || !agents.find((a) => a.agent === initialAgent))) {
      // If fleet list isn't loaded yet, wait for it rather than picking fleet[0].
      return;
    }
    if (initialAgent) {
      setActiveAgent(initialAgent);
    }
  }, [initialAgent, agents]);

  // --- Message user affiche immediatement (optimiste) en attendant la reponse ---
  const [pendingUser, setPendingUser] = useState<string | null>(null);

  // --- Mode selection multiple (suppression) ---
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // --- Saisie ---
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]); // chemins absolus
  const [sending, setSending] = useState(false);
  // Feature 5 (Annuler) : etat de l'appel d'annulation en cours (evite les
  // double-clics et affiche un etat de transition le temps que le backend
  // tue le process et que le polling voie running=false).
  const [cancelling, setCancelling] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // --- Recherche/filtre global dans la conversation (MESSAGES) ---
  // Filtre par mot-cle (keyword) + plage de dates sur les messages affiches.
  const [msgFilter, setMsgFilter] = useState<MessageFilter>({ agent: '', keyword: '' });

  // --- Largeur de la colonne sessions (resizable par poignee) ---
  // Defaut large mais < 100% pour que la zone de conversation reste utilisable
  // (en flexbox, width:100% sur cette colonne + flex-1 sur le chat cacherait le chat).
  const [sessWidth, setSessWidth] = useState<string>('30%');
  // true sur écrans >= md (768px). La largeur resizable inline n'est appliquée
  // qu'en desktop ; sur mobile la colonne reste w-full (100%) via la classe.
  const [isMd, setIsMd] = useState<boolean>(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
  );
  const draggingRef = useRef(false);

  // Refs
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Flux SSE chat (token-par-token, audit 2026-08-07) : remplace le poll 1.5s
  // quand EventSource est dispo. Un seul flux actif a la fois.
  const chatSseRef = useRef<EventSource | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const convEndRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // -------------------------------------------------------------------------
  // Redimensionnement de la colonne sessions via poignee (bord droit).
  // On suit la souris a la fenetre et on borne la largeur entre 200px et 80%
  // du conteneur. Les listeners sont ajoutes/retires proprement.
  // -------------------------------------------------------------------------
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let w = ev.clientX - rect.left;
      const min = 200;
      // Borne max = 80% de la largeur INTERNE du conteneur (jamais un % qui
      // déborde). On stocke toujours des PIXELS, jamais un % après le drag.
      const max = containerRef.current.clientWidth * 0.8;
      if (w < min) w = min;
      if (w > max) w = max;
      setSessWidth(`${Math.round(w)}px`);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // -------------------------------------------------------------------------
  // Charge la liste d'agents depuis le backend (dynamique, jamais en dur).
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    getState()
      .then((s) => {
        if (cancelled) return;
        const fleet = (s.fleet || []).filter((a) => a.agent && a.name);
        setAgents(fleet);
        if (fleet.length > 0) {
          // Defaut : le premier de la liste (manager en tete), SAUF si on
          // arrive d'un clic carte (initialAgent deja valide dans la fleet).
          if (!initialAgent || !fleet.find((a) => a.agent === initialAgent)) {
            setActiveAgent(fleet[0].agent);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, []);

  // -------------------------------------------------------------------------
  // sync() tourne une fois au montage pour garantir que isMd est correct
  // (et donc width:30% applique) des le premier rendu sur desktop.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setIsMd(mq.matches);
    onChange(); // applique l'etat initial immediatement
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // -------------------------------------------------------------------------
  // Charge les sessions de l'agent actif, puis reprend un eventuel stream en
  // cours (anti-coupure : le subprocess tourne cote serveur meme si on a
  // change d'onglet/agent entre-temps).
  // -------------------------------------------------------------------------
  const loadSessions = async (agent: string, openId?: string | null) => {
    setLoadingSessions(true);
    try {
      const data = await getMessageSessions(agent);
      // getMessageSessions renvoie deja des MessageSession (type complet) —
      // le cast {id, started_at?} cassait le typecheck et masquait `live`
      // (audit 2026-08-07).
      const list = data.sessions || [];
      // Trie par date decroissante (created_at, fallback timestamp dans l'id).
      const _ts = (s: MessageSession) => {
        if (typeof s.created_at === 'number') return s.created_at;
        const m = /^msg_(\d+)/.exec(s.id || '');
        return m ? parseInt(m[1], 10) : 0;
      };
      const sorted = [...list].sort((a, b) => _ts(b) - _ts(a));
      setSessions(sorted);
      // Ouvre une session precise si demandee, sinon garde la courante si presente,
      // sinon la plus recente (sorted[0]).
      const target = openId !== undefined
        ? openId
        : (currentSessionId && sorted.some((s) => s.id === currentSessionId)
            ? currentSessionId
            : (sorted.length ? sorted[0].id : null));
      setCurrentSessionId(target);
      // Reprend le streaming si la session ouverte est encore en cours.
      if (target) {
        const sess = sorted.find((s) => s.id === target);
        if (sess?.live?.running) startStreaming(agent, target);
        return sess;
      }
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoadingSessions(false);
    }
  };

  // Recharge les sessions a chaque changement d'agent actif, et ouvre
  // directement la session la plus recente (par timestamp dans l'id).
  useEffect(() => {
    if (!activeAgent) return;
    try { localStorage.setItem('mc_messages_agent', activeAgent); } catch { /* ignore */ }
    stopPolling();
    stopStreaming();
    setLiveStatus(null);
    setSelected(new Set());
    setSelectMode(false);
    (async () => {
      try {
        const data = await getMessageSessions(activeAgent);
        const list = data.sessions || [];
        const _ts = (s: MessageSession) => {
          const m = /^msg_(\d+)/.exec(s.id || '');
          return m ? parseInt(m[1], 10) : 0;
        };
        const sorted = [...list].sort((a, b) => _ts(b) - _ts(a));
        // Ouvre la plus recente sans jamais repasser par null.
        setCurrentSessionId(sorted.length ? sorted[0].id : null);
        setSessions(sorted);
        await loadSessions(activeAgent, sorted.length ? sorted[0].id : null);
      } catch { /* loadSessions gere deja l'erreur */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgent]);

  // -------------------------------------------------------------------------
  // Nettoyage du poll au demontage.
  // -------------------------------------------------------------------------
  useEffect(() => () => { stopPolling(); stopStreaming(); }, []);

  // -------------------------------------------------------------------------
  // Scroll auto NON INTRUSIF pendant le streaming.
  // Principes :
  //  - Si l'utilisateur a intentionnellement remonte (distance au bas > 40px),
  //    on NE force PAS le scroll vers le bas -> il peut lire tranquillement.
  //  - On reprend l'auto-scroll UNIQUEMENT si l'utilisateur est deja en bas
  //    (distance <= 40px) ou s'il revient en bas manuellement.
  //  - Un bouton flottant « ↓ Aller en bas » apparait quand on a remonte et
  //    que de nouveaux tokens arrivent ; clic = scroll bas + reactive auto.
  // -------------------------------------------------------------------------

  // Ref sur le conteneur scrollable de la conversation (pour mesurer la
  // distance au bas). N'est pas null uniquement quand une session est ouverte.
  const convScrollRef = useRef<HTMLDivElement | null>(null);

  // true = l'utilisateur a remonte et ne veut pas etre force vers le bas.
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Seuil (px) en-dessous duquel on considere qu'on est « en bas ».
  const BOTTOM_THRESHOLD = 40;

  // Distance (px) entre le bas du contenu et le bas visible du viewport.
  const distanceFromBottom = (el: HTMLElement | null): number => {
    if (!el) return 0;
    return el.scrollHeight - (el.scrollTop + el.clientHeight);
  };

  // Force le scroll tout en bas (instantane) et reactive l'auto-scroll.
  const scrollToBottom = useCallback(() => {
    const el = convScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setUserScrolledUp(false);
  }, []);

  // Detecte le scroll manuel de l'utilisateur : s'il remonte au-dela du
  // seuil, on leve le flag (auto-scroll desactive). S'il revient en bas, on
  // le raz (auto-scroll reactive). On ignore le scroll programme (flag interne)
  // pour ne pas interferer avec le scroll auto.
  const isProgrammaticScroll = useRef(false);
  const onConversationScroll = useCallback(() => {
    if (isProgrammaticScroll.current) return;
    const el = convScrollRef.current;
    if (!el) return;
    setUserScrolledUp(distanceFromBottom(el) > BOTTOM_THRESHOLD);
  }, []);

  // Effet de scroll auto : ne s'applique QUE si l'utilisateur est en bas
  // (userScrolledUp = false). Quand il a remonte, on ne fait rien (il garde
  // sa position de lecture). Déclencheurs : nouveau message, texte streamé,
  // changement de session.
  useEffect(() => {
    if (userScrolledUp) return; // lecture libre : pas d'auto-scroll
    const el = convScrollRef.current;
    if (!el) return;
    isProgrammaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
    // On libere le flag apres le paint pour que le handler onScroll (qui
    // survient suite a ce scroll programme) ne remonte pas userScrolledUp.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
      });
    });
  }, [sessions, liveStatus, currentSessionId, userScrolledUp]);

  // -------------------------------------------------------------------------
  // Polling du statut en temps reel (streaming). Idempotent : nettoie tout
  // intervalle existant avant d'en creer un.
  // -------------------------------------------------------------------------
  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(agent: string, sessionId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await getMessageStatus(agent, sessionId);
        if (!st.running) {
          // Termine : recharge l'historique (le message agent final est dans
          // messages[]), on oublie le live. Texte COMPLET, jamais coupe.
          stopPolling();
          setLiveStatus(null);
          setPendingUser(null);
          setBusyAgents((prev) => {
            const next = new Set(prev);
            next.delete(agent);
            return next;
          });
          await loadSessions(agent, sessionId);
        } else {
          setLiveStatus(st);
        }
      } catch {
        // Blip reseau : on continue au tick suivant.
      }
    }, POLL_MS);
  }

  // -------------------------------------------------------------------------
  // Streaming SSE chat (audit 2026-08-07) : tokens instantanes, PLUS de poll
  // 1.5s quand EventSource est disponible. Le poll reste le fallback (EventSource
  // indisponible ou flux coupe). Une seule source active a la fois : startStreaming
  // ferme tout poll existant, stopStreaming ferme le flux SSE.
  // -------------------------------------------------------------------------
  function stopStreaming() {
    if (chatSseRef.current) {
      try {
        chatSseRef.current.close();
      } catch { /* ignore */ }
      chatSseRef.current = null;
    }
  }

  function startStreaming(agent: string, sessionId: string) {
    stopStreaming();
    stopPolling();
    // Placeholder immediat : la bulle de streaming apparait des l'envoi,
    // avant meme le premier token (comme avec l'ancien poll).
    setLiveStatus({ agent, session_id: sessionId, running: true, text: '', error: null });
    const es = subscribeChatStream(agent, sessionId, {
      onToken: (chunk) => {
        setLiveStatus((prev) => {
          const base =
            prev && prev.session_id === sessionId
              ? prev
              : { agent, session_id: sessionId, running: true, text: '', error: null };
          return { ...base, running: true, text: base.text + chunk };
        });
      },
      onDone: (err) => {
        if (chatSseRef.current !== es) return; // flux perime : ignore
        chatSseRef.current = null;
        // Fin : on marque running=false. Le rendu fusionne alors le live dans
        // l'historique (plus de doublon). On nettoie liveStatus des que
        // l'historique recharge (loadSessions ci-dessous) via le flag ci-dessous.
        setLiveStatus((prev) =>
          prev && prev.session_id === sessionId
            ? { ...prev, running: false, phase: null, error: err ?? prev.error }
            : { agent, session_id: sessionId, running: false, text: '', error: err ?? null, phase: null },
        );
        setPendingUser(null);
        setBusyAgents((prev) => {
          const next = new Set(prev);
          next.delete(agent);
          return next;
        });
        if (err) setError(err);
        loadSessions(agent, sessionId).then(() => {
          // Historique a jour : le message final y est. On retire le live pour
          // eviter tout doublon visuel (le rendu fusionne deja pendant running).
          setLiveStatus((prev) =>
            prev && prev.session_id === sessionId ? null : prev,
          );
        });
      },
      onError: () => {
        // Le SSE coupe (fin normale APRES done, ou coupure reseau). Dans les
        // deux cas la generation est terminee -> on nettoie busyAgents pour
        // que le rond rouge repasse VERT (sinon il reste rouge jusqu'au F5).
        // On laisse un delai de grace : si onDone a deja tourne (chatSseRef
        // null), il a deja nettoye -> on ne fait rien. Sinon on nettoie ici.
        if (chatSseRef.current === es) {
          chatSseRef.current = null;
          setTimeout(() => {
            setBusyAgents((prev) => {
              if (!prev.has(agent)) return prev;
              const next = new Set(prev);
              next.delete(agent);
              return next;
            });
          }, 600);
          startPolling(agent, sessionId);
        }
      },
    });
    if (!es) {
      // EventSource indisponible (vieux navigateur) : fallback poll.
      chatSseRef.current = null;
      startPolling(agent, sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // Changement d'agent (bascule, un seul actif).
  // -------------------------------------------------------------------------
  const handleAgentClick = (agent: string) => {
    if (agent === activeAgent) return;
    setActiveAgent(agent);
    // ---- RESET COMPLET DE L'ETAT DU CHAT (anti-melange entre agents) ----
    setCurrentSessionId(null);
    setSessions([]);
    setLiveStatus(null);
    stopPolling();
    stopStreaming();
    setPendingUser(null);
    setInput('');
    setAttachments([]);
    setSelected(new Set());
    setSelectMode(false);
    setError(null);
    // ---------------------------------------------------------------------
  };

  // -------------------------------------------------------------------------
  // Nouvelle session vierge (brouillon) : ouvre la zone de saisie vide sans
  // ecraser une session existante. Envoyer un message la finalise.
  // -------------------------------------------------------------------------
  const newSession = () => {
    setCurrentSessionId(null);
    setSelected(new Set());
    setSelectMode(false);
    setLiveStatus(null);
    stopPolling();
    stopStreaming();
  };

  // -------------------------------------------------------------------------
  // Ouverture d'une session dans la zone conversation.
  // -------------------------------------------------------------------------
  const openSession = (id: string) => {
    setCurrentSessionId(id);
    setSelected(new Set());
    // Reprend le stream si la session ouverte est encore en cours.
    const sess = sessions.find((s) => s.id === id);
    if (sess?.live?.running) startStreaming(activeAgent, id);
  };

  // -------------------------------------------------------------------------
  // Suppression : une session, la selection, ou TOUTES.
  // -------------------------------------------------------------------------
  const deleteOne = async (id: string) => {
    if (!activeAgent) return;
    stopPolling();
    stopStreaming();
    setLiveStatus(null);
    try {
      await deleteMessageSessions(activeAgent, [id]);
      if (currentSessionId === id) setCurrentSessionId(null);
      await loadSessions(activeAgent, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteAll = async () => {
    if (!activeAgent) return;
    stopPolling();
    stopStreaming();
    setLiveStatus(null);
    try {
      await deleteMessageSessions(activeAgent, [ALL]);
      setCurrentSessionId(null);
      await loadSessions(activeAgent, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteSelection = async () => {
    if (!activeAgent || selected.size === 0) return;
    stopPolling();
    stopStreaming();
    setLiveStatus(null);
    try {
      await deleteMessageSessions(activeAgent, Array.from(selected));
      if (currentSessionId && selected.has(currentSessionId)) setCurrentSessionId(null);
      setSelected(new Set());
      setSelectMode(false);
      await loadSessions(activeAgent, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // -------------------------------------------------------------------------
  // FEATURE (2026-08-02) : suppression/edition de messages individuels +
  // suppression de PJ, directement depuis les bulles de conversation.
  //  - deleteMessage(i)    : retire messages[i] dans la session ouverte.
  //  - editMessage(i)      : pre-remplit l'input avec le texte du message user,
  //                         focus, et au renvoi on garde le meme session_id
  //                         (regeneration de la reponse via --resume).
  //  - deleteAttachment(i) : retire une PJ du message user a l'index i.
  // Tous declenchent un rechargement de la session pour refleter le changement.
  // -------------------------------------------------------------------------
  const handleDeleteMessage = async (index: number) => {
    if (!activeAgent || !currentSessionId) return;
    if (!window.confirm('Supprimer ce message ? (modifie le cours de la discussion)')) return;
    try {
      await deleteMessage(activeAgent, currentSessionId, index);
      await loadSessions(activeAgent, currentSessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleEditMessage = (index: number, text: string) => {
    if (!activeAgent || !currentSessionId) return;
    // Pre-remplit l'input avec le texte du message, focus, et on envoie
    // ensuite avec le meme session_id pour regenerer la reponse.
    setInput(text);
    setAttachments([]);
    // focus textarea
    setTimeout(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea');
      if (ta) ta.focus();
    }, 0);
  };

  const handleDeleteAttachment = async (index: number, path: string) => {
    if (!activeAgent || !currentSessionId) return;
    try {
      await deleteAttachment(activeAgent, currentSessionId, index, path);
      await loadSessions(activeAgent, currentSessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // -------------------------------------------------------------------------
  // Upload de fichiers (paperclip / copier-coller / glisser-deposer).
  // Lit chaque fichier en base64 puis uploadMessageFile -> chemin absolu.
  // -------------------------------------------------------------------------
  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string; // "data:...;base64,XXXX"
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const uploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    try {
      const paths: string[] = [];
      for (const f of files) {
        const b64 = await readFileAsBase64(f);
        const r = await uploadMessageFile(f.name, b64);
        if (r.ok) paths.push(r.path);
      }
      setAttachments((prev) => [...prev, ...paths]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  // -------------------------------------------------------------------------
  // Envoi d'un message.
  // -------------------------------------------------------------------------
  const handleSend = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || !activeAgent || sending) return;
    setSending(true);
    setError(null);
    // Affichage immediat (optimiste) de la question + agent passe en "busy".
    const userMsgDisplay = text || (attachments.length ? '(piece jointe)' : '');
    setPendingUser(userMsgDisplay);
    setBusyAgents((prev) => new Set(prev).add(activeAgent));
    try {
      const res = await sendMessage(activeAgent, currentSessionId, text, attachments);
      const sid = res.session_id;
      setInput('');
      setAttachments([]);
      setCurrentSessionId(sid);
      // Recharge pour afficher le message user + la session dans la liste.
      const reloadedSession = await loadSessions(activeAgent, sid);
      // Le serveur persiste le message user immediatement (cf. _persist_user_msg),
      // donc l'historique recharge (messages[]) contient DEJA la vraie bulle user.
      // Verification: le user turn est-il bien present dans les messages recharges?
      const hasUserMsg = reloadedSession?.messages?.some(
        (m: any) => m.role === 'user' && m.text === userMsgDisplay
      );
      // On efface la bulle optimiste pendingUser SEULEMENT si le user turn
      // est bien présent dans la session (evite le clignotement/disparition).
      // Sans ca, la question apparaissait 2x tant que l'agent repondait, et ne
      // "revenait" a 1 seule qu'au changement d'onglet (demontage/remontage).
      if (hasUserMsg) setPendingUser(null);
      // La session n'est ecrite dans sessions/<agent>.json qu'apres le spawn
      // du worker (quelques dizaines de ms apres send). Si le loadSessions
      // ci-dessus ne l'a pas encore vue, on recharge la liste de droite apres
      // un court delai pour qu'elle apparaisse SANS attendre le F5.
      if (!sessions.some((s: any) => s.id === sid)) {
        setTimeout(() => { loadSessions(activeAgent, sid); }, 700);
      }
      // Demarre le streaming instantane de la reponse agent (SSE chat).
      startStreaming(activeAgent, sid);
    } catch (e) {
      setPendingUser(null);
      setBusyAgents((prev) => {
        const next = new Set(prev);
        next.delete(activeAgent);
        return next;
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // Feature 5 (Annuler) : stoppe la generation de l'agent en cours pour la
  // session courante. Appelle POST /api/messages/cancel avec l'agent actif et
  // le session_id (deja stocke dans currentSessionId par handleSend). Le
  // backend tue UNIQUEMENT le groupe de process de cette session ; le polling
  // verra running=false et rechargera l'historique (bulle finale + mention
  // « annule par l'utilisateur »). Le bouton disparait des que l'on n'est
  // plus en cours de generation.
  const handleCancel = async () => {
    if (!activeAgent || !currentSessionId || cancelling) return;
    setCancelling(true);
    try {
      await fetch('/api/messages/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: activeAgent, session_id: currentSessionId }),
      });
      // On ne force pas running=false ici : on laisse le polling constater la
      // fin (le backend met a jour le statut live + persiste la reponse
      // partielle). Le bouton reste visible le temps du cycle de polling, en
      // etat « annulation… » via `cancelling`.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      uploadFiles(files);
    }
  };

  // -------------------------------------------------------------------------
  // Rendu des pieces jointes (image = miniature cliquable, sinon icone+nom).
  // -------------------------------------------------------------------------
  const renderAttachments = (
    paths: string[] | undefined,
    onDeleteAttachment?: (path: string) => void,
  ) => {
    if (!paths || paths.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        {paths.map((p, i) => {
          const name = p.split('/').pop() || p;
          const delBtn = onDeleteAttachment ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (window.confirm('Supprimer cette piece jointe ?')) {
                  onDeleteAttachment(p);
                }
              }}
              title="Supprimer la piece jointe"
              className="ml-1 px-1 rounded-md text-stone-500 hover:text-red-400 hover:bg-stone-700/60 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          ) : null;
          if (isImagePath(p)) {
            return (
              <div key={i} className="relative group">
                <a
                  href={`/api/files/${encodeURIComponent(name)}`}
                  target="_blank"
                  rel="noreferrer"
                  title={name}
                  className="block"
                >
                  <img
                    src={`/api/files/${encodeURIComponent(name)}`}
                    alt={name}
                    className="h-24 w-24 object-cover rounded-lg border border-stone-700 hover:border-orange-500 transition-colors"
                  />
                </a>
                {delBtn}
              </div>
            );
          }
          return (
            <div key={i} className="flex items-center">
              <a
                href={`/api/files/${encodeURIComponent(name)}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 px-2 py-1 rounded-lg bg-stone-800 border border-stone-700 hover:border-orange-500 text-stone-300 text-xs max-w-[12rem]"
                title={name}
              >
                <FileText className="w-4 h-4 shrink-0 text-orange-400" />
                <span className="truncate">{name}</span>
              </a>
              {delBtn}
            </div>
          );
        })}
      </div>
    );
  };

  // Session ouverte (objet complet).
  const openSessionObj = sessions.find((s) => s.id === currentSessionId) || null;
  // liveRunning/liveText remplacent les anciens streamingRunning/streamingText :
  // le texte live est fusionne dans displayMessages (pas de bloc parallele).
  const liveRunning = !!liveStatus && liveStatus.running;
  const liveText = liveStatus?.text ?? '';

  // FIX doublon (2026-08-17) : on fusionne le live DANS l'historique au lieu
  // d'afficher un bloc parallele. Tant que running=true, le dernier message
  // agent de la session courante est remplace par le texte live (avec coche
  // bleue). Des que running=false, on rend l'historique normal (le message
  // final y est deja). Plus AUCUN doublon possible.
  const displayMessages = useMemo(() => {
    let base = openSessionObj?.messages || [];
    if (pendingUser && !base.some((m: any) => m.role === 'user' && m.text === pendingUser)) {
      base = [...base, { role: 'user', text: pendingUser, ts: Date.now() / 1000 }];
    }
    // Fusion live -> remplace le dernier message agent par le live (si running).
    if (liveStatus && liveStatus.running && liveStatus.text) {
      const copy = base.slice();
      // Trouve le dernier index agent.
      let lastAgent = -1;
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'agent') { lastAgent = i; break; }
      }
      if (lastAgent >= 0) {
        copy[lastAgent] = { ...copy[lastAgent], text: liveStatus.text };
      } else {
        // Pas encore de message agent persiste : on ajoute le live en fin.
        copy.push({ role: 'agent', text: liveStatus.text, ts: Date.now() / 1000 });
      }
      base = copy;
    }
    // Filtre global MESSAGES : mot-cle (keyword) + plage de dates.
    const kw = msgFilter.keyword.trim().toLowerCase();
    const from = msgFilter.dateFrom ? msgFilter.dateFrom.getTime() : null;
    const to = msgFilter.dateTo ? msgFilter.dateTo.getTime() : null;
    if (kw || from || to) {
      base = base.filter((m: any) => {
        if (kw && !String(m.text ?? '').toLowerCase().includes(kw)) return false;
        const ts = typeof m.ts === 'number' ? m.ts * 1000 : NaN;
        if (from && (isNaN(ts) || ts < from)) return false;
        if (to && (isNaN(ts) || ts > to)) return false;
        return true;
      });
    }
    return base;
  }, [openSessionObj, pendingUser, msgFilter, liveStatus]);

  // Modele actif de l'agent selectionne : priorite a la session ouverte
  // (provider/model reellement utilises), repli sur la fiche flotte.
  const activeAgentObj = agents.find((a) => a.agent === activeAgent) || null;
  const activeModel =
    openSessionObj?.model ||
    activeAgentObj?.defaultModel ||
    '(modele inconnu)';
  const activeProvider = openSessionObj?.provider || activeAgentObj?.modelProvider || '';

  return (
    <div className="w-full h-[calc(100vh-7rem)] flex flex-col">
      {error && (
        <div className="text-red-400 text-xs font-mono bg-red-900/20 border-b border-red-900/50 px-3 py-2 shrink-0">
          Erreur : {error}
        </div>
      )}

      <div ref={containerRef} className="flex-1 flex min-h-0">
        {/* ============ COLONNE GAUCHE : AGENTS ============ */}
        <div className="w-52 shrink-0 flex flex-col border-r border-stone-800 bg-stone-900/40 overflow-y-auto">
          <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-stone-500 border-b border-stone-800 sticky top-0 bg-stone-900/90 backdrop-blur">
            Agents
          </div>
          {agents.length === 0 && (
            <div className="px-3 py-3 text-xs text-stone-500 font-mono">chargement…</div>
          )}
          {agents.map((a) => {
            const isActive = a.agent === activeAgent;
            const isBusy = busyAgents.has(a.agent) || workingAgents.includes(a.agent);
            const status = agentStatusFromStrings(isBusy, waitingAgents.includes(a.agent));
            const statusClasses = agentStatusClasses(status);
            return (
              <button
                key={a.agent}
                onClick={() => handleAgentClick(a.agent)}
                title={a.name}
                className={`flex items-center gap-2 px-3 py-2 text-left font-mono text-[13px] border-l-2 transition-colors ${
                  isActive
                    ? 'border-orange-500 bg-orange-600/15 text-orange-300'
                    : 'border-transparent text-stone-400 hover:text-stone-100 hover:bg-stone-800/60'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${statusClasses.dot}`}
                  title={statusClasses.label}
                />
                <span className="truncate">{a.agent}</span>
              </button>
            );
          })}
        </div>

        {/* ============ CENTRE : TERMINAL CLI ============ */}
        <div className="flex-1 min-w-0 flex flex-col bg-stone-950">
          {/* En-tete terminal : agent + modele */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-stone-800 bg-stone-900/70 font-mono text-xs">
            <span className="flex gap-1.5 mr-1">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
            </span>
            <span className="text-green-400">agent@mc</span>
            <span className="text-stone-600">:</span>
            <span className="text-blue-400">~</span>
            <span className="text-stone-600">$</span>
            <span className="text-orange-400">{activeAgent || '—'}</span>
            <span className="text-stone-500 truncate">
              [model: {activeModel}
              {activeProvider ? ` @ ${activeProvider}` : ''}]
            </span>
            <button
              onClick={newSession}
              className="ml-auto shrink-0 px-2 py-0.5 rounded border border-stone-700 text-stone-400 hover:text-orange-300 hover:border-orange-600 transition-colors"
              title="Nouvelle session vierge"
            >
              + session
            </button>
          </div>

          {/* Recherche / filtres globaux sur la conversation (MESSAGES) */}
          <div className="shrink-0 px-3 py-2 border-b border-stone-800 bg-stone-900/40">
            <MessagesSearch
              agents={agents}
              onFilter={setMsgFilter}
              onClear={() => setMsgFilter({ agent: '', keyword: '' })}
            />
          </div>

          {/* Corps terminal */}
          <div
            ref={convScrollRef}
            onScroll={onConversationScroll}
            className="relative flex-1 overflow-y-auto px-4 py-3 font-mono text-sm leading-relaxed"
          >
            {!activeAgent ? (
              <div className="text-stone-500">Selectionnez un agent.</div>
            ) : (
              <>
                {loadingSessions && !openSessionObj && (
                  <div className="flex items-center gap-2 text-stone-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> chargement…
                  </div>
                )}
                {!loadingSessions && displayMessages.length === 0 && !liveRunning && (
                  <div className="text-stone-600">
                    # session vide — tapez un message ci-dessous.
                  </div>
                )}

                {displayMessages.map((m, i) => {
                  const isUser = m.role === 'user';
                  const isLastAgent = !isUser && i === displayMessages.length - 1 && !displayMessages.slice(i + 1).some((x: any) => x.role === 'agent');
                  const ts = m.ts
                    ? new Date(m.ts * 1000).toLocaleString('fr-FR', {
                        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                      })
                    : '';
                  return (
                    <div key={i} className="mb-3 group">
                      <div className="flex items-start gap-2">
                        <span className={`shrink-0 select-none ${isUser ? 'text-orange-400' : 'text-cyan-400'}`}>
                          {isUser ? '›' : '◦'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className={`text-[10px] uppercase tracking-widest mr-2 ${isUser ? 'text-orange-500/80' : 'text-cyan-500/80'}`}>
                            {isUser ? 'user' : 'agent'}
                          </span>
                          <span className="text-[10px] text-stone-600">{ts}</span>
                          <div className={`whitespace-pre-wrap break-words ${isUser ? 'text-orange-100' : 'text-stone-200'}`}>
                            {!isUser ? <AgentMessageBody text={m.text} /> : m.text}
                            {!isUser && liveRunning && isLastAgent && (
                              <span className="inline-block w-2 h-4 align-middle ml-0.5 bg-stone-300 animate-pulse" />
                            )}
                          </div>
                          {isUser && renderAttachments(m.attachments, (p) => handleDeleteAttachment(i, p))}
                          {m.error && (
                            <div className="mt-1 text-xs text-red-300">⚠ {m.error}</div>
                          )}
                          <div className="mt-0.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <CopyButton text={m.text} />
                            {isUser && (
                              <button
                                type="button"
                                onClick={() => handleEditMessage(i, m.text)}
                                title="Editer et renvoyer ce message"
                                className="px-1.5 py-0.5 rounded text-stone-500 hover:text-orange-300 hover:bg-stone-800 transition-colors"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteMessage(i)}
                              title="Supprimer ce message"
                              className="px-1.5 py-0.5 rounded text-stone-500 hover:text-red-400 hover:bg-stone-800 transition-colors"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                            {!isUser && <StatusDot running={liveRunning && isLastAgent} phase={liveStatus?.phase} />}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Indicateur de generation tant que le 1er token n'est pas encore
                    dans l'historique (live vide). Le texte live lui-meme est deja
                    fusionne dans displayMessages ci-dessus (pas de doublon). */}
                {liveRunning && !liveText && (
                  <div className="mb-3 flex items-start gap-2">
                    <span className="shrink-0 select-none text-cyan-400">◦</span>
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] uppercase tracking-widest mr-2 text-cyan-500/80">agent</span>
                      <span className="flex items-center gap-2 text-stone-500">
                        <Loader2 className="w-4 h-4 animate-spin" /> en cours…
                      </span>
                    </div>
                  </div>
                )}

                <div ref={convEndRef} />

                {userScrolledUp && liveRunning && (
                  <button
                    type="button"
                    onClick={scrollToBottom}
                    title="Aller en bas"
                    className="sticky bottom-2 left-full ml-[-3rem] float-right mb-2 mr-3 flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-orange-600 text-white text-xs font-medium shadow-lg hover:bg-orange-500 transition-colors"
                  >
                    ↓ bas
                  </button>
                )}
              </>
            )}
          </div>

          {/* Pieces jointes en attente */}
          {attachments.length > 0 && (
            <div className="shrink-0 flex flex-wrap gap-2 px-4 py-2 border-t border-stone-800 bg-stone-900/40">
              {attachments.map((p, i) => {
                const name = p.split('/').pop() || p;
                return (
                  <span
                    key={i}
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-stone-800 border border-stone-700 text-stone-300 text-xs font-mono"
                  >
                    {isImagePath(p)
                      ? <ImageIcon className="w-3.5 h-3.5 text-orange-400" />
                      : <FileText className="w-3.5 h-3.5 text-orange-400" />}
                    <span className="max-w-[10rem] truncate">{name}</span>
                    <button onClick={() => removeAttachment(p)} className="text-stone-500 hover:text-red-400" title="Retirer">✕</button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Ligne de saisie style prompt */}
          <div
            className="shrink-0 flex items-end gap-2 px-3 py-2 border-t border-stone-800 bg-stone-900/60"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
            }}
          >
            <span className="text-orange-400 font-mono text-sm pb-2 select-none">›</span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Joindre un fichier"
              className="shrink-0 p-2 rounded text-stone-500 hover:text-stone-200 hover:bg-stone-800 transition-colors"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={2}
              placeholder="message… (CTRL+Entree = envoyer)"
              className="flex-1 resize-y bg-stone-950 border border-stone-800 rounded px-2 py-1.5 text-stone-200 text-sm font-mono focus:outline-none focus:border-orange-600"
            />
            <button
              onClick={handleCancel}
              disabled={!liveRunning || cancelling}
              title={cancelling ? 'Annulation…' : 'Annuler la generation'}
              className={`shrink-0 flex items-center gap-1 px-2.5 py-2 rounded text-xs font-mono transition-colors ${
                liveRunning && !cancelling
                  ? 'bg-red-700 text-white hover:bg-red-600'
                  : 'bg-stone-800 text-stone-600 cursor-not-allowed'
              }`}
            >
              <Square className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleSend}
              disabled={sending || (!input.trim() && attachments.length === 0)}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2 rounded text-xs font-mono transition-colors ${
                sending || (!input.trim() && attachments.length === 0)
                  ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
                  : 'bg-orange-600 text-white hover:bg-orange-500'
              }`}
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              envoyer
            </button>
          </div>
        </div>

        {/* ============ COLONNE DROITE : HISTORIQUE ============ */}
        <div className="w-60 shrink-0 flex flex-col border-l border-stone-800 bg-stone-900/40 overflow-y-auto">
          <div className="px-3 py-2 flex items-center justify-between border-b border-stone-800 sticky top-0 bg-stone-900/90 backdrop-blur">
            <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">Historique</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectMode((m) => !m)}
                className="text-[10px] uppercase tracking-widest text-orange-500 hover:text-orange-300"
                title="Mode selection multiple"
              >
                {selectMode ? 'annuler' : 'select'}
              </button>
              <button
                onClick={() => activeAgent && loadSessions(activeAgent, currentSessionId)}
                title="Rafraichir l'historique"
                className="text-stone-500 hover:text-orange-300 transition-colors"
              >
                {loadingSessions ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span className="text-xs">⟳</span>}
              </button>
            </div>
          </div>

          {selectMode && (
            <div className="px-3 py-2 border-b border-stone-800 flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-orange-500 w-3.5 h-3.5"
                checked={selected.size === sessions.length && sessions.length > 0}
                onChange={(e) => {
                  if (e.target.checked) setSelected(new Set(sessions.map((s) => s.id)));
                  else setSelected(new Set());
                }}
                title="Tout cocher"
              />
              <button
                onClick={deleteSelection}
                disabled={selected.size === 0}
                className="flex items-center gap-1 px-2 py-1 rounded bg-red-700 disabled:bg-stone-800 disabled:text-stone-600 text-white text-[11px] font-mono"
              >
                <Trash2 className="w-3 h-3" /> ({selected.size})
              </button>
              <button
                onClick={deleteAll}
                className="ml-auto text-[10px] uppercase text-red-500 hover:text-red-300"
                title="Supprimer TOUTES les sessions"
              >
                tout
              </button>
            </div>
          )}

          <div className="flex-1 divide-y divide-stone-800/60">
            {!activeAgent && (
              <div className="px-3 py-3 text-xs text-stone-600 font-mono">—</div>
            )}
            {activeAgent && !loadingSessions && sessions.length === 0 && (
              <div className="px-3 py-3 text-xs text-stone-600 font-mono">aucune session</div>
            )}
            {sessions.map((s) => {
              const isOpen = s.id === currentSessionId;
              const isSel = selected.has(s.id);
              const d = new Date(s.created_at * 1000).toLocaleString('fr-FR', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
              });
              return (
                <div
                  key={s.id}
                  onClick={() => !selectMode && openSession(s.id)}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer border-l-2 transition-colors ${
                    isOpen
                      ? 'border-orange-500 bg-orange-600/10'
                      : 'border-transparent hover:bg-stone-800/50'
                  }`}
                >
                  {selectMode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.id)) next.delete(s.id);
                          else next.add(s.id);
                          return next;
                        });
                      }}
                      className="shrink-0"
                    >
                      {isSel
                        ? <CheckSquare className="w-3.5 h-3.5 text-orange-500" />
                        : <Square className="w-3.5 h-3.5 text-stone-600" />}
                    </button>
                  )}
                  <div className="flex-1 min-w-0 font-mono">
                    <div className={`text-[12px] truncate flex items-center gap-1.5 ${isOpen ? 'text-orange-200' : 'text-stone-300'}`}>
                      {s.title || s.id}
                      {s.live?.running && <Loader2 className="w-3 h-3 animate-spin text-orange-400 shrink-0" />}
                    </div>
                    <div className="text-[10px] text-stone-600 truncate">
                      {s.message_count} msg · {d}
                    </div>
                  </div>
                  {!selectMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteOne(s.id); }}
                      title="Supprimer cette session"
                      className="shrink-0 text-stone-600 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
