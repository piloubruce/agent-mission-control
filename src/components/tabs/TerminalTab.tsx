/**
 * #5 — Onglet TERMINAL (UI) — VRAI terminal interactif.
 *
 * WebSocket backend : ws(s)://<host>/ws/terminal (connexion directe, sans authentification).
 * Protocole : {type:'input'|'resize'|'ping'} montant, {type:'output'|'exit'|'error'} descendant.
 *
 * 2026-08-06 — refonte « vrai terminal » :
 *   - PLUS de champ « commande… » : toute la frappe part directement au PTY via
 *     term.onData() (flèches, Tab, Échap, Ctrl-*, F1-F12, Backspace, Suppr…).
 *     => nano / htop / vim / less sont utilisables.
 *   - Négociation de taille réelle : FitAddon + term.onResize -> {type:'resize'}
 *     -> TIOCSWINSZ côté serveur (prouvé : `stty size` suit).
 *   - Barre de touches spéciales tactile (Échap, Tab, Ctrl collant, flèches,
 *     Ctrl+O/X/C/D…) indispensable au clavier virtuel Android.
 *   - Bouton « Clavier » qui focus la textarea cachée d'xterm (ouverture du
 *     clavier virtuel sur tablette).
 *   - Collage conservé : Ctrl+V, bouton Coller ; copie de sélection Ctrl+Shift+C.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  TerminalSquare, Plug, PlugZap, Trash2, ClipboardPaste, Keyboard, Maximize2, Minimize2,
} from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal-touch.css';
import { terminalWsUrl } from '../../lib/mcApi';

type Status = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** Touches spéciales absentes d'un clavier virtuel Android. */
const SPECIAL_KEYS: { label: string; seq: string; title: string }[] = [
  { label: 'Échap', seq: '\x1b', title: 'Escape' },
  { label: 'Tab', seq: '\t', title: 'Tabulation / complétion' },
  { label: '←', seq: '\x1b[D', title: 'Flèche gauche' },
  { label: '↑', seq: '\x1b[A', title: 'Flèche haut / historique' },
  { label: '↓', seq: '\x1b[B', title: 'Flèche bas' },
  { label: '→', seq: '\x1b[C', title: 'Flèche droite' },
  { label: '⇱', seq: '\x1b[H', title: 'Début de ligne (Home)' },
  { label: '⇲', seq: '\x1b[F', title: 'Fin de ligne (End)' },
  { label: 'PgUp', seq: '\x1b[5~', title: 'Page précédente' },
  { label: 'PgDn', seq: '\x1b[6~', title: 'Page suivante' },
  { label: 'Suppr', seq: '\x1b[3~', title: 'Supprimer' },
  { label: '↵', seq: '\r', title: 'Entrée' },
];

/** Raccourcis Ctrl les plus utiles (nano, shell). */
const CTRL_KEYS: { label: string; seq: string; title: string }[] = [
  { label: '^C', seq: '\x03', title: 'Interrompre' },
  { label: '^D', seq: '\x04', title: 'EOF / quitter' },
  { label: '^O', seq: '\x0f', title: 'nano : écrire' },
  { label: '^X', seq: '\x18', title: 'nano : quitter' },
  { label: '^W', seq: '\x17', title: 'nano : chercher' },
  { label: '^K', seq: '\x0b', title: 'nano : couper la ligne' },
  { label: '^U', seq: '\x15', title: 'nano : coller' },
  { label: '^R', seq: '\x12', title: 'recherche historique' },
  { label: '^L', seq: '\x0c', title: 'effacer l’écran' },
  { label: '^Z', seq: '\x1a', title: 'suspendre' },
];

export const TerminalTab: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [ctrlSticky, setCtrlSticky] = useState(false);
  const [full, setFull] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ctrlRef = useRef(false);

  useEffect(() => { ctrlRef.current = ctrlSticky; }, [ctrlSticky]);

  const write = (s: string) => termRef.current?.write(s);

  const rawSend = useCallback((s: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'input', data: s }));
    return true;
  }, []);

  /** fit() puis annonce cols/rows au PTY (TIOCSWINSZ côté serveur). */
  const sendResize = useCallback(() => {
    const term = termRef.current;
    try { fitRef.current?.fit(); } catch { /* ignore */ }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
    try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); }
    catch { /* ignore */ }
  }, []);

  /** Envoi depuis la barre tactile : applique le Ctrl collant si armé. */
  const tapSend = useCallback((seq: string) => {
    let out = seq;
    if (ctrlRef.current && seq.length === 1) {
      const c = seq.toUpperCase().charCodeAt(0);
      if (c >= 64 && c < 128) out = String.fromCharCode(c & 0x1f);
      setCtrlSticky(false);
    }
    rawSend(out);
    termRef.current?.focus();
  }, [rawSend]);

  /** Focus explicite de la textarea cachée -> ouvre le clavier virtuel Android. */
  const openKeyboard = useCallback(() => {
    const ta = hostRef.current?.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
    ta?.focus();
    termRef.current?.focus();
  }, []);

  // --- init xterm (une seule fois) -----------------------------------------
  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      theme: {
        background: '#0c0a09',
        foreground: '#d6d3d1',
        cursor: '#f97316',
        selectionBackground: '#44403c',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* ignore */ }
    termRef.current = term;
    fitRef.current = fit;

    // TOUTE la frappe part au PTY : c'est ce qui rend nano/htop utilisables.
    term.onData((d) => { rawSend(d); });
    // Séquences « binaires » (souris, etc.)
    term.onBinary((d) => {
      let s = '';
      for (let i = 0; i < d.length; i++) s += String.fromCharCode(d.charCodeAt(i) & 255);
      rawSend(s);
    });
    // Le terminal a changé de géométrie -> renégocier la taille du PTY.
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* ignore */ }
      }
    });

    // --- Clavier : reprendre les Ctrl+<lettre> confisqués par le NAVIGATEUR ---
    // Ctrl+O (ouvrir), Ctrl+X (couper), Ctrl+W (fermer l'onglet), Ctrl+S, Ctrl+P,
    // Ctrl+F, Ctrl+R, Ctrl+L, Ctrl+T, Ctrl+N, Ctrl+U... sont interceptés par Chrome
    // AVANT xterm.js : nano ne recevait donc jamais ^O / ^X.
    // On les capture ici (preventDefault + stopPropagation) et on envoie NOUS-MÊME
    // l'octet de contrôle, en retournant false pour que xterm ne l'envoie pas une
    // 2e fois (un seul envoi garanti).
    // Ce handler n'est appelé QUE quand le terminal a le focus (keydown sur la
    // textarea cachée d'xterm) : les raccourcis du reste du dashboard sont saufs.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (!ev.ctrlKey || ev.altKey || ev.metaKey) return true;

      const key = ev.key;
      const lower = key.toLowerCase();

      // --- EXCEPTIONS : on laisse le navigateur faire son travail ------------
      // Zoom (Ctrl + / - / 0), navigation d'onglets (Ctrl+Tab), outils dev
      // (Ctrl+Maj+*), et les touches non « lettre ».
      if (key === 'Tab' || key === '+' || key === '-' || key === '=' || key === '0'
        || key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return true;
      if (ev.shiftKey) {
        // Ctrl+Maj+C = copier la sélection ; tout le reste (Ctrl+Maj+I/J/K...) au navigateur.
        if (lower === 'c') {
          const sel = term.getSelection();
          if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
          ev.preventDefault();
          ev.stopPropagation();
          return false;
        }
        return true;
      }

      // --- Copier / coller ---------------------------------------------------
      if (lower === 'v') {
        ev.preventDefault();
        ev.stopPropagation();
        navigator.clipboard?.readText().then((t) => { if (t) rawSend(t); }).catch(() => {});
        return false;
      }
      if (lower === 'c') {
        // Règle usuelle : sélection non vide -> copie ; sinon SIGINT (0x03).
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard?.writeText(sel).catch(() => {});
          term.clearSelection();
          ev.preventDefault();
          ev.stopPropagation();
          return false;
        }
        ev.preventDefault();
        ev.stopPropagation();
        rawSend('\x03');
        return false;
      }

      // --- Ctrl+<lettre> et Ctrl+[ \ ] ^ _ : octet de contrôle vers le PTY ---
      let byte: string | null = null;
      if (key.length === 1) {
        const code = key.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) byte = String.fromCharCode(code & 0x1f); // @A-Z[\]^_
        else if (key === ' ') byte = '\x00';
        else if (key === '?') byte = '\x7f';
      }
      if (byte === null) return true;

      ev.preventDefault();
      ev.stopPropagation();
      rawSend(byte);
      return false;
    });

    term.writeln('\x1b[90mTerminal non connecté. Cliquez sur « Connecter ».\x1b[0m');

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(hostRef.current);
    return () => { ro.disconnect(); term.dispose(); termRef.current = null; };
  }, [rawSend, sendResize]);

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    setErr(null);
    setStatus('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(terminalWsUrl()); }
    catch (e) {
      setStatus('error');
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      write(`\r\n\x1b[90m[connecté à ${terminalWsUrl()}]\x1b[0m\r\n`);
      sendResize();
      termRef.current?.focus();
    };
    const handle = (raw: string) => {
      let text = raw;
      try {
        const msg = JSON.parse(raw) as { type?: string; data?: string; error?: string };
        if (msg && typeof msg === 'object' && 'type' in msg) {
          if (msg.type === 'output' && typeof msg.data === 'string') text = msg.data;
          else if (msg.type === 'error') { setErr(msg.error || 'erreur backend'); return; }
          else if (msg.type === 'exit') { text = '\r\n\x1b[90m[processus terminé]\x1b[0m\r\n'; }
          else return;
        }
      } catch { /* texte brut */ }
      write(text);
    };
    ws.onmessage = (ev) => {
      const data = ev.data;
      if (typeof data === 'string') handle(data);
      else if (data instanceof Blob) void data.text().then(handle);
    };
    ws.onerror = () => {
      setStatus('error');
      setErr(
        "Échec de la connexion WebSocket. Le serveur Mission Control ne répond pas " +
          'sur /ws/terminal. Vérifiez que le service hermes-mission-control est actif.',
      );
    };
    ws.onclose = (ev) => {
      setStatus('closed');
      write(`\r\n\x1b[90m[déconnecté — code ${ev.code}]\x1b[0m\r\n`);
      wsRef.current = null;
    };
  }, [sendResize]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('closed');
  }, []);

  useEffect(() => () => { wsRef.current?.close(); wsRef.current = null; }, []);

  useEffect(() => {
    const onResize = () => sendResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sendResize]);

  // Plein écran / retour : refit après transition.
  useEffect(() => { const id = setTimeout(() => sendResize(), 60); return () => clearTimeout(id); }, [full, sendResize]);

  const pasteButton = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) rawSend(t);
      termRef.current?.focus();
    } catch {
      setErr("Presse-papiers inaccessible : utilisez Ctrl+V ou l'appui long (tablette).");
    }
  };

  const dot = status === 'open' ? 'bg-emerald-400'
    : status === 'connecting' ? 'bg-amber-400 animate-pulse'
      : status === 'error' ? 'bg-red-500' : 'bg-stone-600';

  const btn = 'px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2';
  const keyBtn = 'px-2.5 py-1.5 rounded-md bg-stone-800 hover:bg-stone-700 active:bg-orange-700 '
    + 'text-stone-200 font-mono text-xs shrink-0 select-none disabled:opacity-30';

  // IMPORTANT : un SEUL arbre JSX, jamais deux branches de retour distinctes.
  // Un wrapper différent en plein écran remonterait le div hôte et détacherait
  // le canvas xterm (terminal figé). On ne change que les classes.
  return (
    <div className={full ? 'fixed inset-0 z-50 bg-stone-950 p-2 flex flex-col' : 'space-y-4'}>
      {!full && (
        <div className="flex justify-between items-end">
          <div>
            <h2 className="text-3xl font-serif text-stone-100 flex items-center gap-3">
              <TerminalSquare className="w-7 h-7 text-orange-500" /> Terminal
            </h2>
            <p className="text-stone-500 mt-1">
              Shell interactif via <code className="font-mono text-stone-400">/ws/terminal</code> — nano, htop, vim fonctionnent.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-xs font-mono tracking-widest text-stone-500">
              <span className={`w-2 h-2 rounded-full ${dot}`} /> {status.toUpperCase()}
            </span>
            <button onClick={() => termRef.current?.clear()} className={`${btn} bg-stone-800 hover:bg-stone-700 text-stone-200`}>
              <Trash2 className="w-4 h-4" /> Effacer
            </button>
            {status === 'open' ? (
              <button onClick={disconnect} className={`${btn} bg-stone-800 hover:bg-stone-700 text-stone-200`}>
                <Plug className="w-4 h-4" /> Déconnecter
              </button>
            ) : (
              <button onClick={connect} className={`${btn} bg-orange-600 hover:bg-orange-500 text-white`}>
                <PlugZap className="w-4 h-4" /> Connecter
              </button>
            )}
          </div>
        </div>
      )}

      {err && !full && (
        <div className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded-xl px-4 py-3">
          {err}
        </div>
      )}

      <div className={`bg-stone-950 border border-stone-800 overflow-hidden flex flex-col ${full ? 'flex-1 rounded-none' : 'rounded-2xl'}`}>
        {/* Écran du terminal : la frappe y va directement. */}
        <div
          ref={hostRef}
          data-testid="xterm-host"
          onClick={() => termRef.current?.focus()}
          className={full ? 'flex-1 p-2 min-h-0' : 'h-[68vh] p-2'}
          style={{ userSelect: 'text', WebkitUserSelect: 'text', touchAction: 'auto' }}
        />

        {/* Barre de touches spéciales (indispensable au clavier virtuel Android). */}
        <div className="border-t border-stone-800 px-2 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <button
              onClick={openKeyboard}
              disabled={status !== 'open'}
              title="Ouvrir le clavier virtuel (tablette)"
              className={`${keyBtn} bg-orange-700 hover:bg-orange-600 text-white flex items-center gap-1`}
            >
              <Keyboard className="w-3.5 h-3.5" /> Clavier
            </button>
            <button
              onClick={() => { setCtrlSticky((v) => !v); termRef.current?.focus(); }}
              disabled={status !== 'open'}
              title="Ctrl collant : appuyez puis tapez une lettre"
              className={`${keyBtn} ${ctrlSticky ? 'bg-orange-600 text-white' : ''}`}
              data-testid="key-ctrl"
            >
              Ctrl{ctrlSticky ? ' ●' : ''}
            </button>
            {SPECIAL_KEYS.map((k) => (
              <button key={k.label} onClick={() => tapSend(k.seq)} disabled={status !== 'open'}
                title={k.title} className={keyBtn}>{k.label}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {CTRL_KEYS.map((k) => (
              <button key={k.label} onClick={() => tapSend(k.seq)} disabled={status !== 'open'}
                title={k.title} className={keyBtn}>{k.label}</button>
            ))}
            <span className="flex-1" />
            <button onClick={pasteButton} disabled={status !== 'open'} title="Coller depuis le presse-papiers"
              className={keyBtn}><ClipboardPaste className="w-3.5 h-3.5" /></button>
            <button
              onClick={() => {
                const sel = termRef.current?.getSelection();
                if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
              }}
              disabled={status !== 'open'} title="Copier la sélection" className={keyBtn}>Copier</button>
            <button onClick={() => setFull((v) => !v)} title="Plein écran" className={keyBtn}>
              {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            {full && (
              status === 'open'
                ? <button onClick={disconnect} className={keyBtn}>Déconnecter</button>
                : <button onClick={connect} className={`${keyBtn} bg-orange-600 text-white`}>Connecter</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
