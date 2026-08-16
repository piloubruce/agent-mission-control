// types.ts — Shared UI types & static fleet metadata (real facts, not mock data).

export type AgentStatus = 'idle' | 'working' | 'waiting';

export function agentStatusFromStrings(working?: boolean, waiting?: boolean): AgentStatus {
  if (waiting) return 'waiting';
  if (working) return 'working';
  return 'idle';
}

export function agentStatusClasses(status: AgentStatus): { dot: string; pill: string; label: string } {
  switch (status) {
    case 'working':
      return {
        dot: 'bg-red-500 animate-pulse',
        pill: 'bg-red-950 text-red-400 border border-red-900/50',
        label: 'Working',
      };
    case 'waiting':
      return {
        dot: 'bg-blue-500 animate-pulse',
        pill: 'bg-blue-950 text-blue-400 border border-blue-900/50',
        label: 'Waiting',
      };
    default:
      return {
        dot: 'bg-green-500',
        pill: 'bg-green-950 text-green-400 border border-green-900/50',
        label: 'IDLE',
      };
  }
}

export type TabId =
  | 'overview'
  | 'messages'
  | 'agents'
  | 'tasks'
  | 'timeline'
  | 'content'
  | 'schedule'
  | 'scan'
  | 'config'
  | 'terminal'
  | 'files';

// Board task status used across the UI. Matches the backend board columns.
export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  agentId?: string;
}

/**
 * Static fleet metadata — reflects the REAL Hermes fleet (names, roles,
 * channels). This is configuration/fact, not invented metrics. Live metrics
 * (counts, success, status) come entirely from the API.
 */
export interface FleetMeta {
  agent: string; // lowercase API key
  name: string;
  role: string;
  description: string;
}

// Ordre gauche->droite : MANAGER EN TETE (coordinateur), puis le reste de la
// flotte (9 agents depuis juil. 2026). RECHERCHE, ANALYSE, REDACTEUR, SOCIAL,
// RESEAU, DEV, VISION-IMAGE, VISION-MEDIA suivent. L'ancien agent
// DOCUMENTALISTE a ete decompose en REDACTEUR + SOCIAL (fonctions conservees).
export const FLEET_STATIC: FleetMeta[] = [
  {
    agent: 'manager',
    name: 'Manager',
    role: 'Coordinateur',
    description:
      'Coordinateur principal sur Telegram : orchestre la flotte, délègue les tâches et assure la cohérence globale.',
  },
  {
    agent: 'recherche',
    name: 'Recherche',
    role: 'Recherche & sourcing',
    description:
      'Recherche web, veille, intelligence des tendances et sourcing de briefs.',
  },
  {
    agent: 'analyse',
    name: 'Analyse',
    role: 'Analyse & synthèse',
    description:
      "Synthèse dense sur sources denses et veille IA : agrège les briefs en faits structurés.",
  },
  {
    agent: 'redacteur',
    name: 'Redacteur',
    role: 'Rédaction longue',
    description:
      'Contenu long : articles de blog, scripts vidéo, newsletters, aimants à prospect.',
  },
  {
    agent: 'social',
    name: 'Social',
    role: 'Contenu court',
    description:
      'Contenu court pour les réseaux : légendes, posts percutants, formats brefs.',
  },
  {
    agent: 'reseau',
    name: 'Reseau',
    role: 'Réseau & infrastructure',
    description:
      'Gère le réseau, linfrastructure, les optimisations et les intégrations API externes.',
  },
  {
    agent: 'developpeur',
    name: 'Developpeur',
    role: 'Ingénierie & développement',
    description:
      'Ingénierie, automatisation, intégrations API, scripts et déploiement de composants logiciels.',
  },
  {
    agent: 'vision-image',
    name: 'Vision-Image',
    role: 'Vision image & documents',
    description:
      'Captures, images et documents (pdf/doc/docx/xls/ods) : description, OCR et extraction texte.',
  },
  {
    agent: 'vision-media',
    name: 'Vision-Media',
    role: 'Vision vidéo & audio',
    description:
      'Vidéo et audio : extraction de frames, transcription et résumés de médias binaires.',
  },
  {
    agent: 'bob',
    name: 'Bob',
    role: 'Débogage',
    description:
      'Diagnostic et correction des bugs dans le code, les configs, les services et le dashboard Mission Control.',
  },
  {
    agent: 'agentique',
    name: 'Agentique',
    role: 'Agentique',
    description:
      "Conception et pilotage de workflows agentiques : orchestration multi-agents, chaînes d'outils et automatisations autonomes.",
  },
];
