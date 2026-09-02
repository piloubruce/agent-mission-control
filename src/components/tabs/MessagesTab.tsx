import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Menu, PanelRight } from 'lucide-react';
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
  Calendar,
  Terminal,
  LayoutDashboard,
  MessageSquare,
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
  MessageItem,
  FleetAgent,
  getModelSpecs,
  getAgentModel,
} from '../../api';
import { HERMES_INTERNAL_MODEL_REGISTRY } from '../../api';
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
          ? 'finalisation en cours (actions en arrière-plan)'
          : running
            ? 'en cours de génération'
            : 'réponse terminée'
      }
      className={`shrink-0 flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-medium ${
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
      {finalizing && <span className="sr-only">finalisation…</span>}
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

// Petit logo de provenance d'une session (state.db natif : colonne `source`).
// Mappe la valeur brute vers une icône + libellé + couleur.
const SOURCE_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; color: string }> = {
  cron:      { icon: Calendar,       label: 'Cron',       color: 'text-emerald-400' },
  mc:        { icon: LayoutDashboard, label: 'Mission Control', color: 'text-orange-400' },
  telegram:  { icon: Send,            label: 'Telegram',   color: 'text-sky-400' },
  discord:   { icon: Send,            label: 'Discord',    color: 'text-indigo-400' },
  tui:       { icon: Terminal,        label: 'CLI / TUI',  color: 'text-stone-300' },
  cli:       { icon: Terminal,        label: 'CLI',        color: 'text-stone-300' },
  web:       { icon: MessageSquare,   label: 'Web',        color: 'text-stone-300' },
  api:       { icon: MessageSquare,   label: 'API',        color: 'text-stone-300' },
};

function SourceBadge({ source }: { source?: string }) {
  const meta = source ? SOURCE_META[source.toLowerCase()] : undefined;
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <span
      title={`Source : ${meta.label}`}
      className={`inline-flex items-center justify-center shrink-0 ${meta.color}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

const POLL_MS = 1500;

// FIX (2026-08-21) : matching tolerent entre la bulle optimiste (pendingUser)
// et l'historique recharge. L'egalite stricte === cassait sur les espaces de
// debut/fin, le markdown ou les pieces jointes ('(piece jointe)'), ce qui
// laissait la question absente OU dupliquee. On normalise (espaces/trim) et on
// accepte aussi un prefixe commun (le serveur peut tronquer/normaliser).
const _normMsg = (s?: string) => (s || '').replace(/\s+/g, ' ').trim();
const textMatches = (a?: string, b?: string): boolean => {
  const na = _normMsg(a);
  const nb = _normMsg(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb.slice(0, 24)) || nb.startsWith(na.slice(0, 24));
};

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

  // --- Filtre par source d'origine (state.db : colonne `source`) ---
  const [sourceFilter, setSourceFilter] = useState<string>(''); // '' = toutes
  const filteredSessions = useMemo(
    () => (sourceFilter
      ? sessions.filter((s) => (s.source || '').toLowerCase() === sourceFilter)
      : sessions),
    [sessions, sourceFilter],
  );

  // --- Saisie ---
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]); // chemins absolus
  const [sending, setSending] = useState(false);
  // Feature 5 (Annuler) : etat de l'appel d'annulation en cours (evite les
  // double-clics et affiche un etat de transition le temps que le backend
  // tue le process et que le polling voie running=false).
  const [cancelling, setCancelling] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // --- Indicateurs d'en-tete (temps de reflexion, duree session, jauge
  //     contexte). Calcules COTE FRONT a partir de donnees deja disponibles :
  //       * reflexion : ts du 1er token stream - ts d'envoi (latence avant
  //         la 1ere reponse).
  //       * duree session : messages[0].ts - created_at (duree enregistree
  //         de la session native Hermes).
  //       * contexte : somme tokens estimes (chars/4) de la session /
  //         context_length du modele (HERMES_INTERNAL_MODEL_REGISTRY).
  //     Le backend /api/messages/status ne renvoyant que
  //     {running,text,error,phase}, ces indicateurs sont recalcules ici
  //     (l'endpoint /api/messages/context ayant ete retire lors d'une refonte).
  const sentAtRef = useRef<number | null>(null);   // ts envoi (ms)
  const firstTokenAtRef = useRef<number | null>(null); // ts 1er token (ms)
  const [reflectionMs, setReflectionMs] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now());
  // Ticker 1s pour rafraichir la duree live pendant la generation.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // --- Recherche/filtre global dans la conversation (MESSAGES) ---
  // Filtre par mot-cle (keyword) + plage de dates sur les messages affiches.
  const [msgFilter, setMsgFilter] = useState<MessageFilter>({ agent: '', keyword: '' });

  // --- Largeurs des colonnes resizables (Agents & Historique) avec persistance localStorage ---
  const [agentsWidth, setAgentsWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('mc_messages_agents_width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 140 && val <= 450) return val;
      }
    } catch { /* ignore */ }
    return 208;
  });

  const [historyWidth, setHistoryWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('mc_messages_history_width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 160 && val <= 500) return val;
      }
    } catch { /* ignore */ }
    return 240;
  });

  // --- Affichage/masquage du panneau Historique (toggle bouton + clic chat) ---
  const [showHistory, setShowHistory] = useState<boolean>(true);
  // Ref sur la zone de chat principale pour fermer l'historique au clic dedans.
  const chatAreaRef = useRef<HTMLDivElement | null>(null);

  // --- MOBILE / TABLETTE PORTRAIT (écran < 1024px ou format portrait) ---
  // Sur ces appareils, les colonnes latérales (Agents à gauche, Historique à
  // droite) deviennent des panneaux coulissants masqués par défaut, ouverts
  // par glissement tactile ou via les boutons flottants dédiés :
  //   * Barre des onglets -> bouton flottant en haut à gauche
  //   * Agents            -> bouton flottant en bas à gauche
  //   * Historique        -> bouton flottant en bas à droite
  // Sur desktop paysage (>= lg) tout reste tel quel (colonnes visibles + redimensionnables).
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(max-width: 1023px), (orientation: portrait) and (max-width: 1200px)').matches
      : false,
  );
  const [agentsOpen, setAgentsOpen] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px), (orientation: portrait) and (max-width: 1200px)');
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  // Refs de suivi du geste tactile (pour ne pas ouvrir quand on scroll la conversation).
  const gestureRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    onLeft: boolean;
    onTopHalf: boolean;
  }>({ active: false, startX: 0, startY: 0, onLeft: false, onTopHalf: false });

  const onTouchStart = (e: React.TouchEvent) => {
    if (!isMobile) return;
    const t = e.touches[0];
    const w = window.innerWidth;
    const h = window.innerHeight;
    gestureRef.current = {
      active: true,
      startX: t.clientX,
      startY: t.clientY,
      onLeft: t.clientX < w * 0.4,
      onTopHalf: t.clientY < h * 0.5,
    };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!isMobile || !gestureRef.current.active) return;
    const g = gestureRef.current;
    gestureRef.current.active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - g.startX;
    const dy = t.clientY - g.startY;
    // Ignorer les gestes quasi-verticaux (scroll) ou trop courts.
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (g.onLeft) {
      // Moitié gauche : ouvrir Agents uniquement depuis la MOITIÉ INFÉRIEURE.
      if (!g.onTopHalf && dx > 0) setAgentsOpen(true);
    } else {
      // Moitié droite : ouvrir Historique en glissant vers la gauche.
      if (dx < 0) setHistoryOpen(true);
    }
  };

  const isDraggingAgents = useRef(false);
  const isDraggingHistory = useRef(false);

  // Gestionnaires de redimensionnement colonnes
  const startResizeAgents = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingAgents.current = true;
    const startX = e.clientX;
    const startWidth = agentsWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingAgents.current) return;
      const delta = ev.clientX - startX;
      const newWidth = Math.min(Math.max(startWidth + delta, 140), 450);
      setAgentsWidth(newWidth);
    };

    const onMouseUp = () => {
      isDraggingAgents.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setAgentsWidth((w) => {
        try { localStorage.setItem('mc_messages_agents_width', String(w)); } catch { /* ignore */ }
        return w;
      });
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const startResizeHistory = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingHistory.current = true;
    const startX = e.clientX;
    const startWidth = historyWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingHistory.current) return;
      const delta = startX - ev.clientX;
      const newWidth = Math.min(Math.max(startWidth + delta, 160), 500);
      setHistoryWidth(newWidth);
    };

    const onMouseUp = () => {
      isDraggingHistory.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setHistoryWidth((w) => {
        try { localStorage.setItem('mc_messages_history_width', String(w)); } catch { /* ignore */ }
        return w;
      });
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Timers gérés proprement sans fuite mémoire
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const safeTimeout = useCallback((fn: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      fn();
    }, delay);
    timersRef.current.add(timer);
    return timer;
  }, []);

  const clearAllTimeouts = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current.clear();
  }, []);

  // Refs
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Flux SSE chat (token-par-token, audit 2026-08-07) : remplace le poll 1.5s
  // quand EventSource est dispo. Un seul flux actif a la fois.
  const chatSseRef = useRef<EventSource | null>(null);
  // FIX (2026-08-21): le worker est indexé par le mc_sid (msg_…) renvoyé par
  // /api/messages/send, alors que currentSessionId vaut l'id natif après l'
  // unification d'ids. On garde le mc_sid du dernier send pour le cancel.
  const sentSidRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // FIX (2026-08-22): garde la derniere liste triee de sessions (retour de
  // getMessageSessions) accessible en dehors du render. handleSend doit ouvrir
  // EXACTEMENT la session creee par ce send (celle contenant le user turn),
  // PAS sorted[0] (qui peut etre une autre session plus recente par created_at
  // ou a cause d'une race sur l'ecriture state.db). La closure `sessions` peut
  // etre stale apres loadSessions -> on lit ici la liste fraiche.
  const lastSortedRef = useRef<MessageSession[]>([]);

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
  // Charge les sessions de l'agent actif, puis reprend un eventuel stream en
  // cours (anti-coupure : le subprocess tourne cote serveur meme si on a
  // change d'onglet/agent entre-temps).
  // -------------------------------------------------------------------------
  const loadSessions = async (agent: string, openId?: string | null, resume: boolean = true) => {
    setLoadingSessions(true);
    try {
      const data = await getMessageSessions(agent);
      const list = data.sessions || [];
      // Trie par date decroissante (updated_at = date du dernier message, fallback created_at).
      // FIX (2026-08-22) : on veut que sorted[0] soit la session ouverte (celle du dernier
      // echange), peu importe quand elle a ete creee (cas: rajout de message dans une
      // vieille session). L'API renvoie deja updated_at via _read_native_sessions
      // (server.py L8923-8925: updated = last_activity_at or ended_at or created).
      const _ts = (s: MessageSession) => {
        // Tri par date du DERNIER MESSAGE (updated_at), pas created_at
        if (typeof (s as any).updated_at === 'number') return (s as any).updated_at;
        if (typeof s.created_at === 'number') return s.created_at;
        const m = /^msg_(\d+)/.exec(s.id || '');
        return m ? parseInt(m[1], 10) : 0;
      };
      const sorted = [...list].sort((a, b) => _ts(b) - _ts(a));
      setSessions(sorted);
      // FIX (2026-08-22): expositions la liste fraiche pour handleSend (evite
      // la closure stale de `sessions`).
      lastSortedRef.current = sorted;
      // Ouvre une session precise si demandee, sinon garde la courante si presente,
      // sinon la plus recente (sorted[0]).
      const target = openId !== undefined
        ? (sorted.some((s) => s.id === openId) ? openId : null)  // openId fourni mais inconnu -> NE PAS ouvrir sorted[0]
        : (currentSessionId && sorted.some((s) => s.id === currentSessionId)
            ? currentSessionId
            : (sorted.length ? sorted[0].id : null));
      setCurrentSessionId(target);
      // Reprend le streaming si la session ouverte est encore en cours.
      if (target) {
        const sess = sorted.find((s) => s.id === target);
        // ANTI-BOUCLE (2026-08-21): ne (re)demarre le stream SSE que si aucun
        // n'est deja actif ET si l'appelant l'autorise (resume). Sinon
        // onDone -> loadSessions -> startStreaming -> onDone... en boucle
        // quand le backend laisse running=true colle (BUG C scintillement).
        if (resume && sess?.live?.running && !chatSseRef.current) startStreaming(agent, target);
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

  // Recharge les sessions a chaque changement d'agent actif (appel réseau unique).
  useEffect(() => {
    if (!activeAgent) return;
    try { localStorage.setItem('mc_messages_agent', activeAgent); } catch { /* ignore */ }
    stopPolling();
    stopStreaming();
    clearAllTimeouts();
    setLiveStatus(null);
    setSelected(new Set());
    setSelectMode(false);
    loadSessions(activeAgent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgent]);

  // -------------------------------------------------------------------------
  // Nettoyage du poll, flux SSE et timers au demontage.
  // -------------------------------------------------------------------------
  useEffect(() => () => {
    stopPolling();
    stopStreaming();
    clearAllTimeouts();
  }, [clearAllTimeouts]);

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
  // Position de lecture : en haut (atTop) / en bas (atBottom). Sert a afficher
  // les boutons de navigation verticale des qu'un ascenseur apparait, meme hors
  // generation (PILU 2026-08-19 : avant, le seul bouton « ↓ bas » n'apparaissait
  // QUE pendant une generation, donc dès qu'une discussion depassait la hauteur
  // on ne pouvait plus remonter/descendre facilement).
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

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

  // Force le scroll tout en haut (instantane).
  const scrollToTop = useCallback(() => {
    const el = convScrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, []);

  // Detecte le scroll manuel de l'utilisateur : s'il remonte au-dela du
  // seuil, on leve le flag (auto-scroll desactive). S'il revient en bas, on
  // le raz (auto-scroll reactive). On ignore le scroll programme (flag interne)
  // pour ne pas interferer avec le scroll auto. On met aussi a jour atTop/atBottom
  // pour piloter l'affichage des boutons de navigation verticale.
  const isProgrammaticScroll = useRef(false);
  const onConversationScroll = useCallback(() => {
    if (isProgrammaticScroll.current) return;
    const el = convScrollRef.current;
    if (!el) return;
    setUserScrolledUp(distanceFromBottom(el) > BOTTOM_THRESHOLD);
    setAtBottom(distanceFromBottom(el) <= BOTTOM_THRESHOLD);
    setAtTop(el.scrollTop <= BOTTOM_THRESHOLD);
  }, []);

  // Effet de scroll auto : ne s'applique QUE si l'utilisateur est deja en bas
  // (userScrolledUp = false). Quand il a remonte, on ne fait rien (il garde
  // sa position de lecture). Pendant le streaming live, on suit le bas SANS
  // condition de distance : le conteneur grossit vite (tokens), un seuil de
  // 40px couperait le suivi et l'utilisateur devrait scroller a la main.
  useEffect(() => {
    const el = convScrollRef.current;
    if (!el) return;
    // Recalcule atTop/atBottom a chaque changement de contenu (messages, live,
    // session) pour que les boutons de navigation refletent la realite meme
    // sans scroll utilisateur.
    setAtBottom(distanceFromBottom(el) <= BOTTOM_THRESHOLD);
    setAtTop(el.scrollTop <= BOTTOM_THRESHOLD);
    if (userScrolledUp) return; // lecture libre : pas d'auto-scroll
    const isLive = !!(liveStatus && liveStatus.running);
    if (isLive) {
      // Suivi agressif du bas pendant le stream (peu importe la distance).
      isProgrammaticScroll.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          isProgrammaticScroll.current = false;
        });
      });
      return;
    }
    // Hors stream : ne scrolle vers le bas que si on est deja en bas
    // (tolerance seuil) -> empeche l'oscillation « remonte/redescend ».
    if (distanceFromBottom(el) > BOTTOM_THRESHOLD) return;
    isProgrammaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
      });
    });
  }, [sessions, liveStatus, currentSessionId, userScrolledUp]);

  // FIX (2026-08-21) — defensif : effet dedie a la transition live -> done.
  // Quand la generation passe de running:true a running:false, on force la vue
  // en bas SANS condition de distance. Cela couvre le cas ou le contenu se
  // reorganise en fin de reponse (disparition du bloc « raisonnement » ->
  // hauteur reduite) et ou l'effet de scroll auto ci-dessus se retrouve calé
  // trop haut sans se re-declencher. On respecte userScrolledUp (lecture libre).
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const isRunning = !!(liveStatus && liveStatus.running);
    if (prevRunningRef.current && !isRunning && !userScrolledUp) {
      setTimeout(scrollToBottom, 300);
    }
    prevRunningRef.current = isRunning;
  }, [liveStatus, userScrolledUp, scrollToBottom]);

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
        // Capture du 1er token -> temps de reflexion (latence avant 1ere reponse).
        if (firstTokenAtRef.current === null && sentAtRef.current !== null && chunk) {
          firstTokenAtRef.current = Date.now();
          setReflectionMs(firstTokenAtRef.current - sentAtRef.current);
        }
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
        loadSessions(agent, undefined, false).then(() => {
          // Historique a jour : le message final y est. On retire le live pour
          // eviter tout doublon visuel (le rendu fusionne deja pendant running).
          setLiveStatus((prev) =>
            prev && prev.session_id === sessionId ? null : prev,
          );
          // FIX (2026-08-21) : la reponse finale vient d'arriver et le bloc
          // « raisonnement » a disparu -> la hauteur du conteneur a DIMINUE.
          // On force la vue en bas APRES ce render pour que la fin de reponse
          // soit visible sans avoir a cliquer « bas ». Le delai laisse le DOM
          // se stabiliser (comme le fait deja le bouton actualiser en 250ms).
          setTimeout(scrollToBottom, 300);
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
          safeTimeout(() => {
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
    // PILU (2026-08-17) : on stocke la ref SSE SINON la garde onDone/onError
    // (`chatSseRef.current !== es`) echoue toujours -> onDone n'est jamais
    // execute -> busyAgents jamais nettoye -> rond rouge persistant + doublon
    // (le poll de secours affiche l'historique en parallele du live).
    chatSseRef.current = es;
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
    clearAllTimeouts();
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
    if (isMobile) setHistoryOpen(false);
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
    // Reset des indicateurs de timing pour ce nouveau tour.
    sentAtRef.current = Date.now();
    firstTokenAtRef.current = null;
    setReflectionMs(null);
    // Affichage immediat (optimiste) de la question + agent passe en "busy".
    const userMsgDisplay = text || (attachments.length ? '(piece jointe)' : '');
    setPendingUser(userMsgDisplay);
    setBusyAgents((prev) => new Set(prev).add(activeAgent));
    try {
      const res = await sendMessage(activeAgent, currentSessionId, text, attachments);
      const sid = res.session_id;
      // FIX (2026-08-21): mémorise le mc_sid réel pour le cancel (voir sentSidRef).
      sentSidRef.current = sid;
      setInput('');
      setAttachments([]);
      setCurrentSessionId(sid);
      // FIX (2026-08-22) RACINE : pour une NOUVELLE session, resolve-native renvoie
      // null (le mapping n'est jamais peuple). On NE doit PAS dependre de cet
      // endpoint. Au lieu de cela, on poll l'API sessions par USER TURN :
      // on cherche la session qui contient le message utilisateur qu'on vient
      // d'envoyer (pendingUser). Le worker met parfois ~10-15s a ecrire le user
      // turn dans state.db (modele lent). On poll max ~25s (50 x 500ms).
      // pendingUser (bulle question) reste affichee pendant ce temps ->
      // l'utilisateur voit sa question tout de suite.
      startStreaming(activeAgent, sid);
      const openByUserTurn = async () => {
        for (let i = 0; i < 50; i++) {
          try {
            await loadSessions(activeAgent, sid, false);
            const found = (lastSortedRef.current || []).find(
              (s: MessageSession) =>
                Array.isArray((s as any).messages) &&
                (s as any).messages.some(
                  (m: any) => m.role === 'user' && textMatches(m.text, userMsgDisplay)
                )
            );
            if (found && (found as any).id) {
              setCurrentSessionId((found as any).id);
              // vide la bulle optimiste si l'historique contient la question
              setPendingUser(null);
              return;
            }
          } catch { /* retry */ }
          await new Promise((res) => setTimeout(res, 500));
        }
        // PAS de repli sorted[0]: ouvrir une session arbitraire (la plus
        // active par updated_at) injecterait le 1er message d'UNE AUTRE
        // session comme "residu" dans la nouvelle (cf. bug 2026-08-22: le
        // repli ouvrait la session manager au lieu de la session de test).
        // On garde currentSessionId tel quel; pendingUser (bulle question)
        // reste affichee jusqu'a ce que le user turn soit trouve. Si le worker
        // met trop de temps, l'utilisateur voit sa question (pendingUser) et
        // la session s'ouvre des que l'API la contient.
        return;
      };
      openByUserTurn();   // fire-and-forget (non-bloquant)
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
        // FIX (2026-08-21): utilise le mc_sid réel du worker (sentSidRef), pas
        // l'id natif de currentSessionId, sinon le backend ne trouve pas la clé.
        body: JSON.stringify({ agent: activeAgent, session_id: sentSidRef.current || currentSessionId }),
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
    // FIX (2026-08-22): anti-doublon robuste. On ajoute la bulle optimiste
    // pendingUser UNIQUEMENT si l'historique ne contient PAS ENCORE de message
    // user (cas: user turn pas encore persisté côté state.db au tout début).
    // Dès qu'un user turn apparaît dans l'historique, on ne l'ajoute plus
    // (evite le résidu/doublon même si textMatches rate sur le format).
    if (pendingUser && !base.some((m: any) => m.role === 'user')) {
      base = [...base, { role: 'user', text: pendingUser, ts: Date.now() / 1000 }];
    }
    // Fusion live -> remplace le dernier message agent par le live (si running).
    if (liveStatus && liveStatus.running && liveStatus.text) {
      const copy = base.slice();
      // BUG 2026-08-20 : si le dernier message est pendingUser (question en
      // cours pas encore persistee) et qu'un agent message existe plus haut
      // (reponse d'un tour precedent), l'ancien code remplacait ce message
      // agent existant -> on obtenait [.., agent(live), user(pending)] : la
      // reponse s'affichait AU-DESSUS de la question. On insere donc le live
      // juste APRES le dernier message user (pending ou persiste), jamais
      // avant lui.
      const lastUserIdx = (() => {
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === 'user') return i;
        }
        return -1;
      })();
      const liveMsg: MessageItem = { role: 'agent', text: liveStatus.text, ts: Date.now() / 1000 };
      if (lastUserIdx >= 0 && lastUserIdx === copy.length - 1) {
        // Le user est deja en derniere position : on ajoute la reponse apres.
        copy.push(liveMsg);
      } else if (lastUserIdx >= 0) {
        // User quelque part avant la fin : on insere la reponse juste apres.
        copy.splice(lastUserIdx + 1, 0, liveMsg);
      } else {
        // Aucun user : on remplace le dernier agent ou on ajoute.
        let lastAgent = -1;
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === 'agent') { lastAgent = i; break; }
        }
        if (lastAgent >= 0) copy[lastAgent] = liveMsg;
        else copy.push(liveMsg);
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

  // Contexte max REEL du modele actif (resolu via getModelSpecs -> catalogue
  // backend, repli registry interne Hermes). On evite le fallback arbitraire
  // 128k : si le modele a une vraie valeur context_length, on l'affiche.
  const [contextMaxTokens, setContextMaxTokens] = useState<number>(128000);
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      let modelToUse = activeModel;
      let provToUse = activeProvider;
      // Sur nouvelle session, activeModel peut etre '(modele inconnu)' (pas de
      // session ouverte). On recupere le vrai modele de l'agent via getAgentModel.
      if (!modelToUse || modelToUse === '(modele inconnu)') {
        try {
          const am = await getAgentModel(activeAgent);
          if (am?.model) {
            modelToUse = am.model;
            if (am.provider) provToUse = am.provider;
          }
        } catch { /* ignore */ }
      }
      const mid = modelToUse.includes('/') ? modelToUse.split('/')[1] : modelToUse;
      // 1) Registry interne Hermes (comme Hermes Agent natif -> 262144 pour hy3:free)
      const reg = HERMES_INTERNAL_MODEL_REGISTRY[modelToUse] || HERMES_INTERNAL_MODEL_REGISTRY[mid];
      if (reg?.context_length && reg.context_length > 0) {
        if (!cancelled) setContextMaxTokens(reg.context_length);
        return;
      }
      // 2) getModelSpecs (backend scan catalog) en repli
      try {
        const prov = provToUse || (modelToUse.includes('/') ? modelToUse.split('/')[0] : '');
        if (prov && mid) {
          const specs = await getModelSpecs(prov, mid);
          if (specs?.context_length && specs.context_length > 0) {
            if (!cancelled) setContextMaxTokens(specs.context_length);
            return;
          }
        }
      } catch { /* ignore */ }
      // 3) dernier recours
      if (!cancelled) setContextMaxTokens(128000);
    };
    resolve();
    return () => { cancelled = true; };
  }, [activeProvider, activeModel]);

  // --- Indicateurs d'en-tete (calcule COTE FRONT, cf. refs plus haut) ---
  // Duree de session : pour une session native Hermes, messages[0].ts
  // (1er message user) - created_at (demarrage session) = duree enregistree
  // complete. Pendant la generation live, on prolonge avec le tick horloge.
  const sessionDurationMs = useMemo(() => {
    if (!openSessionObj) return null;
    const created = (openSessionObj.created_at || 0) * 1000;
    const msgs = openSessionObj.messages || [];
    if (msgs.length === 0) {
      // Session vide : duree = maintenant - created (ou 0 si pas de created).
      if (!created) return 0;
      return liveRunning ? Math.max(0, nowTick - created) : 0;
    }
    const firstTs = (msgs[0].ts || 0) * 1000;
    const endTs = (msgs[msgs.length - 1].ts || 0) * 1000;
    const end = liveRunning ? Math.max(nowTick, endTs) : endTs;
    if (!created) return Math.max(0, end - firstTs);
    return Math.max(0, end - created);
  }, [openSessionObj, liveRunning, nowTick]);

  // Jauge contexte : somme des tokens estimes (chars/4, comme le backend) de
  // tous les messages de la session / context_length du modele actif.
  const { contextUsedPct, contextTokens } = useMemo(() => {
    if (!openSessionObj) return { contextUsedPct: null, contextTokens: 0 };
    let chars = 0;
    for (const m of openSessionObj.messages || []) {
      chars += String(m.text || '').length;
    }
    if (liveRunning && liveStatus?.text) chars += liveStatus.text.length;
    const tokens = Math.ceil(chars / 4);
    // Contexte max = contextMaxTokens (state resolu via getModelSpecs, repli
    // registry interne Hermes, puis 128k en dernier recours). Pas de valeur
    // arbitraire : on utilise la VRAIE context_length du modele quand dispo.
    const max = contextMaxTokens || 128000;
    const pct = Math.min(100, Math.round((tokens / max) * 100));
    return { contextUsedPct: pct, contextTokens: tokens };
  }, [openSessionObj, contextMaxTokens, liveRunning, liveStatus]);

  // Quand on change de session, réinitialise la position et scrolle tout en bas
  useEffect(() => {
    setUserScrolledUp(false);
    const scrollDown = () => {
      const el = convScrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    };
    scrollDown();
    const t1 = setTimeout(scrollDown, 50);
    const t2 = setTimeout(scrollDown, 150);
    const t3 = setTimeout(scrollDown, 350);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [currentSessionId]);

  return (
    <div
      className="w-full h-full max-h-[100dvh] overflow-hidden flex flex-col"
      onTouchStart={isMobile ? onTouchStart : undefined}
      onTouchEnd={isMobile ? onTouchEnd : undefined}
    >
      {error && (
        <div className="text-red-400 text-xs font-mono bg-red-900/20 border-b border-red-900/50 px-3 py-2 shrink-0">
          Erreur : {error}
        </div>
      )}

      <div ref={containerRef} className="relative flex-1 flex items-stretch min-h-0">
        {/* Sur mobile/tablette : voile derrière le panneau ouvert (ferme au clic). */}
        {isMobile && (agentsOpen || historyOpen) && (
          <div
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm"
            onClick={() => { setAgentsOpen(false); setHistoryOpen(false); }}
          />
        )}
        {/* ============ COLONNE GAUCHE : AGENTS ============ */}
        {/* Desktop (>= lg) : colonne fixe redimensionnable. Mobile / Tablette portrait (< lg) :
            panneau coulissant masqué par défaut, ouvert par glisser la moitié
            INFÉRIEURE gauche vers la droite ou via le bouton flottant en bas à gauche. */}
        {isMobile ? (
          <div
            className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[80vw] flex flex-col bg-stone-900/95 border-r border-stone-800 shadow-2xl backdrop-blur-md overflow-y-auto overflow-x-hidden transform transition-transform duration-200 ease-out ${
              agentsOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none'
            }`}
          >
            <div className="px-3 py-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-stone-500 border-b border-stone-800 sticky top-0 bg-stone-900/90 backdrop-blur">
              <span>Agents</span>
              <button
                onClick={() => setAgentsOpen(false)}
                className="text-stone-400 hover:text-stone-100 p-1"
                title="Fermer"
              >
                ✕
              </button>
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
                  onClick={() => { handleAgentClick(a.agent); setAgentsOpen(false); }}
                  title={a.name}
                  className={`flex items-center gap-2 px-3 py-2.5 text-left font-mono text-[13px] border-l-2 transition-colors ${
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
        ) : (
          <div
            style={{ width: `${agentsWidth}px` }}
            className="relative shrink-0 flex flex-col min-h-0 border-r border-stone-800 bg-stone-900/40 overflow-y-auto"
          >
            <div className="px-3 py-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-stone-500 border-b border-stone-800 sticky top-0 bg-stone-900/90 backdrop-blur">
              <span>Agents</span>
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
        )}

        {/* Bouton flottant ouverture Agents (mobile/tablette portrait uniquement) */}
        {isMobile && !agentsOpen && (
          <button
            onClick={() => setAgentsOpen(true)}
            title="Agents"
            className="fixed left-3 bottom-20 z-40 flex items-center justify-center w-11 h-11 rounded-full bg-stone-800 text-stone-300 border border-stone-700 shadow-lg active:bg-stone-700 hover:bg-stone-750"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}

        {/* Poignée de redimensionnement pour la colonne Agents */}
        {!isMobile && (
          <div
            onMouseDown={startResizeAgents}
            className="w-1.5 shrink-0 cursor-col-resize hover:bg-orange-500/50 active:bg-orange-500 transition-colors z-10 -ml-1 flex items-center justify-center group select-none"
            title="Glisser pour redimensionner la colonne Agents"
          >
            <div className="w-0.5 h-6 bg-stone-700 group-hover:bg-orange-400 rounded" />
          </div>
        )}

        {/* ============ CENTRE : TERMINAL CLI ============ */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-stone-950">
          {/* En-tete terminal : agent + modele + indicateurs (temps reflexion,
              duree session, jauge contexte). Les indicateurs sont calcules
              cote front (cf. useMemo plus haut) car le backend
              /api/messages/status ne les expose pas. */}
          {/* FIX 2026-08-22 (Manager) : flex-nowrap + min-h fixe + overflow-hidden
              pour que cet en-tete garde TOUJOURS 1 ligne de meme hauteur que
              l'en-tete "Historique" de droite (sinon en flex-wrap il passait
              en 2 lignes sur ecran etroit -> bandeaux desalignes). */}
          <div className={`shrink-0 flex flex-col gap-y-1 px-3 py-2 border-b border-stone-800 bg-stone-900/70 font-mono text-xs min-h-[2.75rem] lg:flex-row lg:items-center lg:gap-x-3 lg:whitespace-nowrap lg:overflow-x-hidden ${isMobile ? 'pl-16' : ''}`}>
            {/* Ligne 1 (mobile) / début de ligne (desktop) : prompt agent */}
            <div className="flex items-center gap-x-3">
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
            </div>
            {/* Ligne 2 (mobile) / suite (desktop) : modele */}
            <div className="text-stone-400 truncate min-w-0">
              [model: {activeModel}
              {activeProvider ? ` @ ${activeProvider}` : ''}]
            </div>
            {/* Ligne 3 (mobile) / suite (desktop) : indicateurs */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span title="Temps de réflexion (latence avant le 1er token)" className="flex items-center gap-1 text-stone-400">
                <span className="text-stone-500">réflexion</span>
                <span className={reflectionMs !== null ? 'text-amber-300' : 'text-stone-600'}>
                  {reflectionMs !== null ? `${(reflectionMs / 1000).toFixed(1)}s` : '—'}
                </span>
              </span>
              <span className="text-stone-600">·</span>
              <span title="Durée de la session (création → dernière réponse)" className="flex items-center gap-1 text-stone-400">
                <span className="text-stone-500">session</span>
                <span className="text-cyan-300">
                  {sessionDurationMs !== null
                    ? `${Math.floor(sessionDurationMs / 60000)}m${String(Math.floor((sessionDurationMs % 60000) / 1000)).padStart(2, '0')}s`
                    : '—'}
                </span>
              </span>
              <span className="text-stone-600">·</span>
              <span title="Contexte utilisé (estimation tokens ≈ caractères/4) / contexte max du modèle" className="flex items-center gap-1.5 text-stone-400">
                <span className="text-stone-500">contexte</span>
                {contextUsedPct !== null ? (
                  <>
                    <span className="text-stone-300 tabular-nums">
                      {(contextTokens / 1000).toFixed(1)}k / {((contextMaxTokens || 128000) / 1000).toFixed(1)}k
                    </span>
                    <span className="relative inline-block w-16 h-2 rounded-full bg-stone-700 align-middle overflow-hidden">
                      <span
                        className={`absolute left-0 top-0 h-full rounded-full ${contextUsedPct > 80 ? 'bg-red-500' : contextUsedPct > 50 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                        style={{ width: `${contextUsedPct}%` }}
                      />
                    </span>
                    <span className="text-stone-300">{contextUsedPct}%</span>
                  </>
                ) : (
                  <span className="text-stone-600">—</span>
                )}
              </span>
            </div>
          </div>

          {/* Barre d'actions : nouvelle session + actualiser (ligne separee
              pour ne pas couper les infos modele/timer/contexte sur tablette) */}
          <div className="shrink-0 flex items-center justify-end gap-2 px-3 py-1.5 border-b border-stone-800 bg-stone-900/40">
            <button
              onClick={newSession}
              className="shrink-0 px-2 py-0.5 rounded border border-stone-700 text-stone-400 hover:text-orange-300 hover:border-orange-600 transition-colors"
              title="Nouvelle session vierge"
            >
              + session
            </button>
            <button
              onClick={() => {
                if (activeAgent) loadSessions(activeAgent, currentSessionId);
                // Remonte en bas apres le rechargement de la session.
                setTimeout(scrollToBottom, 250);
              }}
              className="shrink-0 px-2 py-0.5 rounded border border-stone-700 text-stone-400 hover:text-orange-300 hover:border-orange-600 transition-colors"
              title="Actualiser la conversation (recharge depuis Hermès / Telegram)"
            >
              {loadingSessions ? <Loader2 className="w-3 h-3 animate-spin" /> : '↻ actualiser'}
            </button>
            <button
              onClick={() => setShowHistory((v) => !v)}
              className={`shrink-0 px-2 py-0.5 rounded border transition-colors ${
                showHistory
                  ? 'border-orange-600 text-orange-300'
                  : 'border-stone-700 text-stone-400 hover:text-orange-300 hover:border-orange-600'
              }`}
              title={showHistory ? 'Masquer l\'historique des sessions' : 'Afficher l\'historique des sessions'}
            >
              {showHistory ? '▣ historique' : '▢ historique'}
            </button>
          </div>

          {/* Recherche / filtres globaux sur la conversation (MESSAGES) */}
          <div className="shrink-0 px-3 py-2 border-b border-stone-800 bg-stone-900/40">
            <MessagesSearch
              agents={agents}
              onFilter={(filter) => {
                setMsgFilter(filter);
                if (filter.agent && filter.agent !== activeAgent) {
                  handleAgentClick(filter.agent);
                }
              }}
              onClear={() => setMsgFilter({ agent: '', keyword: '' })}
            />
          </div>

          {/* Corps terminal */}
          <div
            ref={convScrollRef}
            onScroll={onConversationScroll}
            onClick={() => setShowHistory(false)}
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
                  const isLastAgent = !isUser && !displayMessages.slice(i + 1).some((x: any) => x.role === 'agent');
                  const ts = m.ts
                    ? new Date(m.ts > 1e11 ? m.ts : m.ts * 1000).toLocaleString('fr-FR', {
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
                          <div className="mt-0.5 flex items-center gap-1 transition-opacity">
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
                              className="px-1.5 py-0.5 rounded text-stone-300 hover:text-red-400 hover:bg-stone-800 transition-colors"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                          {/* Statut de generation : pastille visible UNIQUEMENT sur le dernier message agent */}
                          {!isUser && isLastAgent && (
                            <div className="mt-0.5">
                              <StatusDot running={liveRunning} phase={liveStatus?.phase} />
                            </div>
                          )}
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

                {/* Boutons de navigation verticale : apparaissent des qu'un
                    ascenseur est present (scrollHeight > clientHeight), meme hors
                    generation. « ↓ bas » quand on n'est pas en bas, « ↑ haut »
                    quand on n'est pas en haut. Bouton compact et discret collé à droite. */}
                {(() => {
                  const el = convScrollRef.current;
                  const hasScroll = el ? el.scrollHeight - el.clientHeight > BOTTOM_THRESHOLD : false;
                  if (!hasScroll) return null;
                  return (
                    <div className="pointer-events-none fixed inset-x-0 bottom-20 flex justify-center items-center gap-2 z-20">
                      {!atTop && (
                        <button
                          type="button"
                          onClick={scrollToTop}
                          title="Aller en haut de la discussion"
                          className="pointer-events-auto shrink-0 w-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-stone-800/90 text-stone-200 border border-stone-700 text-xs font-mono shadow-md hover:bg-stone-700 hover:text-white transition-colors backdrop-blur-sm active:scale-95"
                        >
                          ↑ haut
                        </button>
                      )}
                      {!atBottom && (
                        <button
                          type="button"
                          onClick={scrollToBottom}
                          title="Aller en bas de la discussion"
                          className="pointer-events-auto shrink-0 w-auto flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-orange-600/95 text-white border border-orange-500/50 text-xs font-mono shadow-lg hover:bg-orange-500 transition-colors backdrop-blur-sm active:scale-95"
                        >
                          ↓ bas
                        </button>
                      )}
                    </div>
                  );
                })()}
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

          {/* Ligne de saisie style prompt (pleine largeur sur desktop et tablette) */}
          <div
            className="shrink-0 flex items-end gap-2 px-3 py-2 border-t border-stone-800 bg-stone-900/60 w-full"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
            }}
          >
            <div className="flex items-center gap-1.5 shrink-0 pb-1">
              <span className="text-orange-400 font-mono text-base select-none">›</span>
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
                className="shrink-0 p-2 rounded text-stone-400 hover:text-stone-100 hover:bg-stone-800 transition-colors"
              >
                <Paperclip className="w-4 h-4" />
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={2}
              placeholder="message… (CTRL+Entree = envoyer)"
              className="flex-1 min-w-0 resize-y bg-stone-950 border border-stone-800 rounded px-2.5 py-1.5 text-stone-200 text-sm font-mono focus:outline-none focus:border-orange-600 focus:ring-1 focus:ring-orange-600"
            />
            <div className="flex items-center gap-1.5 shrink-0 pb-0.5">
              <button
                onClick={handleCancel}
                disabled={!liveRunning || cancelling}
                title={cancelling ? 'Annulation…' : 'Annuler la generation'}
                className={`shrink-0 flex items-center justify-center gap-1 px-2.5 py-2 rounded text-xs font-mono transition-colors ${
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
                className={`shrink-0 flex items-center justify-center gap-1.5 px-3.5 py-2 rounded text-xs font-mono transition-colors ${
                  sending || (!input.trim() && attachments.length === 0)
                    ? 'bg-stone-800 text-stone-600 cursor-not-allowed'
                    : 'bg-orange-600 text-white hover:bg-orange-500 shadow-sm'
                }`}
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                <span className="hidden sm:inline">envoyer</span>
              </button>
            </div>
          </div>
        </div>

        {/* Poignée de redimensionnement pour la colonne Historique */}
        {!isMobile && showHistory && (
          <div
            onMouseDown={startResizeHistory}
            className="w-1.5 shrink-0 cursor-col-resize hover:bg-orange-500/50 active:bg-orange-500 transition-colors z-10 -mr-1 flex items-center justify-center group select-none"
            title="Glisser pour redimensionner la colonne Historique"
          >
            <div className="w-0.5 h-6 bg-stone-700 group-hover:bg-orange-400 rounded" />
          </div>
        )}

        {/* ============ COLONNE DROITE : HISTORIQUE ============ */}
        {/* Desktop (>= lg) : colonne fixe redimensionnable (toggle showHistory).
            Mobile / Tablette portrait (< lg) : panneau coulissant masqué par défaut, ouvert par
            glisser le doigt vers la gauche sur la moitié droite ou via le bouton flottant en bas à droite. */}
        {isMobile ? (
          <div
            className={`fixed inset-y-0 right-0 z-40 w-72 max-w-[80vw] flex flex-col bg-stone-900/95 border-l border-stone-800 shadow-2xl backdrop-blur-md overflow-y-auto overflow-x-hidden transform transition-transform duration-200 ease-out ${
              historyOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
            }`}
          >
            <div className="px-3 py-2 flex items-center justify-between border-b border-stone-800 sticky top-0 bg-stone-900/90 backdrop-blur min-h-[2.75rem]">
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
                <button
                  onClick={() => setHistoryOpen(false)}
                  className="text-stone-400 hover:text-stone-100 p-1"
                  title="Fermer"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Filtre par source d'origine */}
            <div className="px-3 py-2 border-b border-stone-800 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-stone-600 shrink-0">Source</span>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="flex-1 bg-stone-950 border border-stone-800 rounded px-2 py-1 text-[11px] text-stone-300 font-mono focus:outline-none focus:border-orange-600"
              >
                <option value="">Toutes</option>
                <option value="cron">Cron</option>
                <option value="mc">Mission Control</option>
                <option value="telegram">Telegram</option>
                <option value="discord">Discord</option>
                <option value="tui">CLI / TUI</option>
                <option value="cli">CLI</option>
                <option value="web">Web</option>
                <option value="api">API</option>
              </select>
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
              {activeAgent && !loadingSessions && filteredSessions.length === 0 && (
                <div className="px-3 py-3 text-xs text-stone-600 font-mono">
                  {sessions.length === 0 ? 'aucune session' : 'aucune session pour ce filtre'}
                </div>
              )}
              {filteredSessions.map((s) => {
                const isOpen = s.id === currentSessionId;
                const isSel = selected.has(s.id);
                const d = new Date(s.created_at * 1000).toLocaleString('fr-FR', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                });
                return (
                  <div
                    key={s.id}
                    onClick={() => !selectMode && openSession(s.id)}
                    className={`flex items-start gap-2 px-3 py-2 cursor-pointer border-l-2 transition-colors ${
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
                    <div className="flex-1 min-w-0">
                      <div className={`flex items-center gap-1.5 text-[12px] ${isOpen ? 'text-orange-200' : 'text-stone-300'}`}>
                        <SourceBadge source={s.source} />
                        <span className="truncate">{s.title || s.id}</span>
                        {s.live?.running && <Loader2 className="w-3 h-3 animate-spin text-orange-400 shrink-0" />}
                      </div>
                      <div className="text-[10px] text-stone-500 mt-0.5">{s.message_count} msg · {d}</div>
                    </div>
                    {!selectMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteOne(s.id); }}
                        title="Supprimer cette session"
                        className="ml-auto shrink-0 self-center text-stone-600 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            style={{ width: `${historyWidth}px` }}
            className={`relative shrink-0 flex flex-col min-h-0 border-l border-stone-800 bg-stone-900/40 overflow-y-auto ${
              !showHistory ? 'hidden' : ''
            }`}
          >
            <div className="px-3 py-2 flex items-center justify-between border-b border-stone-800 sticky top-0 bg-stone-900/90 backdrop-blur min-h-[2.75rem]">
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

            {/* Filtre par source d'origine */}
            <div className="px-3 py-2 border-b border-stone-800 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-stone-600 shrink-0">Source</span>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="flex-1 bg-stone-950 border border-stone-800 rounded px-2 py-1 text-[11px] text-stone-300 font-mono focus:outline-none focus:border-orange-600"
              >
                <option value="">Toutes</option>
                <option value="cron">Cron</option>
                <option value="mc">Mission Control</option>
                <option value="telegram">Telegram</option>
                <option value="discord">Discord</option>
                <option value="tui">CLI / TUI</option>
                <option value="cli">CLI</option>
                <option value="web">Web</option>
                <option value="api">API</option>
              </select>
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
              {activeAgent && !loadingSessions && filteredSessions.length === 0 && (
                <div className="px-3 py-3 text-xs text-stone-600 font-mono">
                  {sessions.length === 0 ? 'aucune session' : 'aucune session pour ce filtre'}
                </div>
              )}
              {filteredSessions.map((s) => {
                const isOpen = s.id === currentSessionId;
                const isSel = selected.has(s.id);
                const d = new Date(s.created_at * 1000).toLocaleString('fr-FR', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                });
                return (
                  <div
                    key={s.id}
                    onClick={() => !selectMode && openSession(s.id)}
                    className={`flex items-start gap-2 px-3 py-2 cursor-pointer border-l-2 transition-colors ${
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
                    <div className="flex-1 min-w-0">
                      <div className={`flex items-center gap-1.5 text-[12px] ${isOpen ? 'text-orange-200' : 'text-stone-300'}`}>
                        <SourceBadge source={s.source} />
                        <span className="truncate">{s.title || s.id}</span>
                        {s.live?.running && <Loader2 className="w-3 h-3 animate-spin text-orange-400 shrink-0" />}
                      </div>
                      <div className="text-[10px] text-stone-500 mt-0.5">{s.message_count} msg · {d}</div>
                    </div>
                    {!selectMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteOne(s.id); }}
                        title="Supprimer cette session"
                        className="ml-auto shrink-0 self-center text-stone-600 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Bouton flottant ouverture Historique (mobile / tablette portrait uniquement) */}
        {isMobile && !historyOpen && (
          <button
            onClick={() => setHistoryOpen(true)}
            title="Historique"
            className="fixed right-3 bottom-20 z-40 flex items-center justify-center w-11 h-11 rounded-full bg-stone-800 text-stone-300 border border-stone-700 shadow-lg active:bg-stone-700 hover:bg-stone-750"
          >
            <PanelRight className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
};
