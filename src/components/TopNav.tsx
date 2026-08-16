import React, { useEffect, useState, useMemo } from 'react';
import { TabId } from '../types';
import {
  RotateCw,
  LayoutDashboard, Bot, MessageSquare, ListTodo,
  Building2, FileText, CalendarClock, Radar,
  PanelLeftClose, PanelLeftOpen,
  SlidersHorizontal, Sun, Moon, TerminalSquare, FolderTree,
  Activity, History, Save, Trash2, Server
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { restartServer } from '../api';
import { useApiState } from '../api';
import { useTheme } from '../lib/theme';
import { loadHotkeys, formatCombo, VALID_TABS, type HotkeyMap } from '../lib/hotkeys';
// Version du dashboard, synchronisée avec le fichier VERSION (bump auto au build).
import dashboardVersion from '../../VERSION?raw';

interface TopNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export const TopNav: React.FC<TopNavProps> = ({ activeTab, onTabChange }) => {
  const [collapsed, setCollapsed] = useState(false);
  // Theme dark/light (persiste dans localStorage `mc_theme`).
  const [theme, toggleTheme] = useTheme();

  // Écoute dynamique des modifications de raccourcis
  const [hotkeysMap, setHotkeysMap] = useState<HotkeyMap>(() => loadHotkeys());

  useEffect(() => {
    const onMapChange = (e: Event) => setHotkeysMap((e as CustomEvent<HotkeyMap>).detail);
    window.addEventListener('mc-hotkeys-change', onMapChange);
    return () => window.removeEventListener('mc-hotkeys-change', onMapChange);
  }, []);

  // Build reverse map: TabId -> formatted combo string for display.
  const tabShortcuts = useMemo(() => {
    const reverse: Partial<Record<TabId, string>> = {};
    for (const [combo, tabId] of Object.entries(hotkeysMap)) {
      if (VALID_TABS.includes(tabId as TabId)) {
        reverse[tabId as TabId] = formatCombo(combo);
      }
    }
    return reverse;
  }, [hotkeysMap]);

  const { state, error } = useApiState();
  const isServerOnline = !!state && !error;
  const workingAgents = state?.working_agents ?? [];
  const waitingAgents = (state as any)?.waiting_agents ?? [];
  const fleetWaiting = waitingAgents.length > 0;
  const fleetWorking = workingAgents.length > 0;
  const fleetStatus = state ? (fleetWaiting ? 'waiting' : (fleetWorking ? 'working' : 'idle')) : 'idle';
  const fleetDot = fleetStatus === 'waiting'
    ? 'bg-amber-400'
    : fleetStatus === 'working' ? 'bg-emerald-400' : 'bg-stone-600';
  const fleetLabel = fleetStatus === 'waiting'
    ? 'EN ATTENTE'
    : fleetStatus === 'working' ? 'ACTIF' : 'AU REPOS';

  const handleRestart = async () => {
    if (!confirm('Redemarrer le serveur Hermes Mission Control ?')) return;
    try {
      const r = await restartServer();
      if (r.ok) { alert('Redemarrage lance. La page va se recharger...'); setTimeout(() => location.reload(), 2500); }
      else alert('Echec: ' + (r.error || 'inconnu'));
    } catch (e) { alert('Erreur: ' + String(e)); }
  };

  const tabs: { id: TabId; label: string; icon: LucideIcon }[] = [
    { id: 'overview', label: 'APERÇU', icon: LayoutDashboard },
    { id: 'agents', label: 'AGENTS', icon: Bot },
    { id: 'messages', label: 'MESSAGES', icon: MessageSquare },
    { id: 'tasks', label: 'TÂCHES', icon: ListTodo },
    { id: 'timeline', label: 'CHRONOLOGIE', icon: History },
    { id: 'content', label: 'CONTENU', icon: FileText },
    { id: 'schedule', label: 'PLANIFICATION', icon: CalendarClock },
    { id: 'scan', label: 'BALAYAGE', icon: Radar },
    { id: 'config', label: 'CONFIGURATION', icon: SlidersHorizontal },
    { id: 'terminal', label: 'TERMINAL', icon: TerminalSquare },
    { id: 'files', label: 'EXPLORATEUR', icon: FolderTree },
  ];

  const actionBtn = 'flex items-center gap-3 px-3 py-2.5 text-xs font-medium tracking-wide rounded-md text-stone-400 hover:text-stone-200 hover:bg-stone-900/50 transition-colors w-full text-left';

  return (
    <nav
      className={`
        flex flex-row flex-wrap w-full h-auto items-center gap-2 px-3 py-2
        md:flex-col md:flex-nowrap md:items-stretch md:h-screen md:h-[100dvh] md:max-h-[100dvh] md:p-0 md:gap-0 md:overflow-hidden
        md:sticky md:top-0 z-50
        border-b md:border-b-0 md:border-r border-stone-800
        bg-stone-950/80 backdrop-blur-md
        ${collapsed ? 'md:w-20 md:overflow-x-hidden' : 'md:w-56'}
      `}
    >
      {/* Logo + bouton de rétractation (colonne à gauche, toujours) + titre à droite */}
      <div className="flex items-stretch md:px-4 md:py-4 md:border-b md:border-stone-800 gap-3 shrink-0">
        {/* Colonne : H + bouton rétractation (empilés, jamais décalés) */}
        <div className="flex flex-col items-center gap-3 shrink-0">
          <div className="w-8 h-8 bg-orange-600 rounded flex items-center justify-center text-white font-bold tracking-tighter shrink-0">
            H
          </div>
          <button
            onClick={() => toggleTheme()}
            title={theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}
            className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:text-orange-500 hover:bg-stone-900/50 transition-colors shrink-0"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Déplier la barre' : 'Réduire la barre'}
            className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:text-stone-200 hover:bg-stone-900/50 transition-colors shrink-0"
          >
            <PanelLeftClose className={`w-4 h-4 ${collapsed ? 'hidden' : ''}`} />
            <PanelLeftOpen className={`w-4 h-4 ${collapsed ? '' : 'hidden'}`} />
          </button>
        </div>
        {/* Titre + version (à droite du H, masqué en rétracté) */}
        {!collapsed && (
          <div className="flex items-center gap-2">
            <span className="text-sm md:text-base font-medium tracking-tight text-stone-100">
              Hermès Mission Control
            </span>
            <span className="px-2 py-0.5 text-[10px] font-mono text-orange-500 bg-orange-500/10 rounded-full border border-orange-500/20 shrink-0">
              v{dashboardVersion.trim() || '1.16'}
            </span>
          </div>
        )}
      </div>
      {/* Onglets */}
      <div className={`mc-sidebar-scroll flex flex-row flex-wrap md:flex-col md:flex-nowrap md:flex-1 md:min-h-0 md:basis-0 gap-1 md:p-3 md:overflow-y-auto md:overflow-x-hidden ${collapsed ? 'md:items-center' : ''}`}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          const shortcut = tabShortcuts[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              title={shortcut ? `${tab.label} (${shortcut})` : tab.label}
              className={`flex items-center gap-3 px-3 py-2.5 text-xs font-medium tracking-widest rounded-md transition-all duration-200 shrink-0 text-left ${collapsed ? 'md:justify-center md:w-auto md:flex-col md:gap-1 md:py-1.5' : 'md:w-full'} ${active
                ? 'text-orange-500 bg-stone-900'
                : 'text-stone-400 hover:text-stone-200 hover:bg-stone-900/50'}`}
            >
              <Icon className="w-5 h-5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1">{tab.label}</span>
                  {shortcut && (
                    <span className="ml-auto text-[10px] font-mono tracking-normal text-stone-600 shrink-0">{shortcut}</span>
                  )}
                </>
              )}
              {collapsed && shortcut && (
                <span className="hidden md:block text-[8px] font-mono tracking-normal text-stone-600 shrink-0">{shortcut}</span>
              )}
            </button>
          );
        })}
      </div>
      {/* Actions (bas) */}
      <div className={`shrink-0 flex flex-row md:flex-col items-center md:items-stretch gap-1 md:gap-1 md:p-3 md:border-t md:border-stone-800 ${collapsed ? 'md:items-center' : ''}`}>
        {/* Statut Backend Hermès */}
        <div
          title={isServerOnline ? 'Hermès Mission Control : En ligne' : 'Hermès Mission Control : Déconnecté'}
          className={`flex items-center gap-2.5 px-3 py-2 text-[11px] font-mono rounded-md w-full ${
            isServerOnline
              ? 'text-emerald-400 bg-emerald-950/20 border border-emerald-900/30'
              : 'text-amber-400 bg-amber-950/20 border border-amber-900/30'
          } ${collapsed ? 'justify-center px-2' : ''}`}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${isServerOnline ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          {!collapsed && (
            <span className="truncate flex-1 text-left font-medium">
              {isServerOnline ? 'HERMÈS · EN LIGNE' : 'HERMÈS · DÉCONNECTÉ'}
            </span>
          )}
          <Server className="w-3.5 h-3.5 opacity-70 shrink-0" />
        </div>

        <div className={`hidden md:flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono tracking-widest text-stone-500 ${collapsed ? 'md:justify-center' : ''}`}>
          <span className={`w-2 h-2 rounded-full ${fleetDot}`} />
          {!collapsed && <>FLOTTE · {fleetLabel}</>}
        </div>
        <button onClick={handleRestart} title="Redemarrer le serveur" className={actionBtn}>
          <RotateCw className="w-5 h-5 shrink-0" />
          {!collapsed && <span className="hidden md:inline">Redemarrer</span>}
        </button>
      </div>
    </nav>
  );
};