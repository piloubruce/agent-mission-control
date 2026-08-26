/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, Component } from 'react';
import { Activity } from 'lucide-react';
import type { ReactNode, ErrorInfo } from 'react';
import { TabId } from './types';
import { TopNav } from './components/TopNav';
import { OverviewTab } from './components/tabs/OverviewTab';
import { AgentsTab } from './components/tabs/AgentsTab';
import { TasksTab } from './components/tabs/TasksTab';
import { TaskTimelineTab } from './components/tabs/TaskTimelineTab';
import { ContentTab } from './components/tabs/ContentTab';
import { ScheduleTab } from './components/tabs/ScheduleTab';
import { ScanTab } from './components/tabs/ScanTab';
import { MessagesTab } from './components/tabs/MessagesTab';
import { ConfigTab } from './components/tabs/ConfigTab';
import { TerminalTab } from './components/tabs/TerminalTab';
import { FilesTab } from './components/tabs/FilesTab';
import { loadHotkeys, saveHotkeys, normalizeCombo, VALID_TABS, matchesCombo } from './lib/hotkeys';
import type { HotkeyMap } from './lib/hotkeys';
import { getConfig } from './lib/mcApi';
import { NotificationProvider } from './components/notifications/NotificationProvider';
import { FleetLivePanel } from './components/monitoring/FleetLivePanel';

// Error Boundary — keeps a crash on one tab from blanking the whole dashboard.
interface BoundaryState {
  error: Error | null;
}

class TabErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Tab crashed:', error, info.componentStack);
  }

  private handleReset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-3xl bg-stone-900 border border-red-900/50 p-10 text-center">
          <h2 className="text-2xl font-serif text-red-400 mb-2">Cet onglet a rencontré une erreur.</h2>
          <p className="text-stone-400 text-sm mb-6 font-mono break-words">{this.state.error.message}</p>
          <button
            onClick={this.handleReset}
            className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-500 transition-colors"
          >
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // L'onglet actif est persisté en localStorage pour SURVIVRE à un F5 (reload) :
  // sinon on retombait toujours sur « APERÇU ». On lit la valeur sauvegardée au
  // montage (lazy init) et on la réécrit à chaque changement d'onglet.
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    try {
      const saved = localStorage.getItem('mc_active_tab') as TabId | null;
      if (saved && VALID_TABS.includes(saved)) return saved;
    } catch { /* localStorage indisponible : fallback overview */ }
    return 'overview';
  });

  // Panneau "supervision temps reel" (live tail de la flotte).
  const [liveOpen, setLiveOpen] = useState(false);

  // Pre-selected agent when switching to MESSAGES. Persisted so a F5 keeps
  // the last opened agent (mirrors mc_active_tab behaviour).
  const [messagesAgent, setMessagesAgent] = useState<string | null>(() => {
    try { return localStorage.getItem('mc_messages_agent'); } catch { return null; }
  });

  // Persiste l'onglet courant à chaque changement (pour le F5).
  const handleTabChange = (t: TabId) => {
    try { localStorage.setItem('mc_active_tab', t); } catch { /* ignore */ }
    setActiveTab(t);
  };

  // Clic sur une carte agent -> bascule vers MESSAGES + présélection agent.
  const handleAgentClick = (agent: string) => {
    setMessagesAgent(agent);
    handleTabChange('messages');
  };

  // --- Raccourcis clavier personnalisables (libre) -----------------------
  // Source de verite = SERVEUR (/api/config), pas localStorage : si
  // l'utilisateur efface son cache/historique, les raccourcis survivent.
  // Le localStorage sert uniquement de cache rapide de demarrage.
  const [hotkeys, setHotkeys] = useState<HotkeyMap>(() => loadHotkeys());

  // Au demarrage, rapatrier les raccourcis depuis le serveur (ils ont la
  // priorite sur le cache local, qui peut etre vide ou perime).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { config, source } = await getConfig();
        if (cancelled || source !== 'server') return;
        const sc = config.shortcuts;
        if (!sc || typeof sc !== 'object') return;
        const map: HotkeyMap = {};
        for (const [combo, tab] of Object.entries(sc)) {
          const normalized = normalizeCombo(combo);
          if (normalized.length > 0 && VALID_TABS.includes(tab as TabId)) {
            map[normalized] = tab as TabId;
          }
        }
        if (Object.keys(map).length) {
          saveHotkeys(map); // declenche l'event -> setHotkeys
        }
      } catch { /* backend indisponible : on garde le cache local */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onMapChange = (e: Event) => setHotkeys((e as CustomEvent<HotkeyMap>).detail);
    window.addEventListener('mc-hotkeys-change', onMapChange);
    return () => window.removeEventListener('mc-hotkeys-change', onMapChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignorer si dans un champ de saisie
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) return;
      }

      // Chercher si la combinaison actuelle correspond à un raccourci
      for (const [combo, target] of Object.entries(hotkeys)) {
        if (matchesCombo(combo, e) && VALID_TABS.includes(target as TabId)) {
          e.preventDefault();
          handleTabChange(target as TabId);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys]);

  const renderTab = () => {
    switch (activeTab) {
      case 'overview': return <OverviewTab />;
      case 'messages': return <MessagesTab initialAgent={messagesAgent ?? undefined} />;
      case 'agents': return <AgentsTab onAgentClick={handleAgentClick} />;
      case 'tasks': return <TasksTab />;
      case 'timeline': return <TaskTimelineTab />;
      case 'content': return <ContentTab />;
      case 'schedule': return <ScheduleTab />;
      case 'scan': return <ScanTab />;
      case 'config': return <ConfigTab />;
      case 'terminal': return <TerminalTab />;
      case 'files': return <FilesTab />;
      default: return <OverviewTab />;
    }
  };

  return (
    <NotificationProvider>
      <div className="flex flex-col lg:flex-row h-screen h-[100dvh] max-h-[100dvh] overflow-hidden bg-stone-950 text-stone-200 font-sans selection:bg-orange-500/30">
        <TopNav activeTab={activeTab} onTabChange={handleTabChange} liveOpen={liveOpen} setLiveOpen={setLiveOpen} />
        <main className={`flex-1 min-w-0 w-full h-full p-0 animate-in fade-in duration-500 ${activeTab === 'messages' ? 'overflow-hidden flex flex-col' : 'overflow-y-auto'}`}>
          <TabErrorBoundary>
            {renderTab()}
          </TabErrorBoundary>
        </main>
      </div>
      {/* Bouton flottant + panneau "supervision temps reel" (live tail) */}
      <FleetLivePanel visible={liveOpen} onToggle={() => setLiveOpen((v) => !v)} />
    </NotificationProvider>
  );
}