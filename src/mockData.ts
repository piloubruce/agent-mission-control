import { ApiState, MessageSession, MessageItem } from './api';

export const generate50Messages = (): MessageItem[] => {
  const messages: MessageItem[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const baseTimeSec = nowSec - 50 * 60;

  for (let i = 1; i <= 50; i++) {
    const isUser = i % 2 === 1;
    const ts = baseTimeSec + i * 60;
    
    if (isUser) {
      messages.push({
        role: 'user',
        text: `Message ${i} : Ligne de test utilisateur #${i} pour valider le défilement vertical et l'affichage.`,
        ts,
      });
    } else {
      messages.push({
        role: 'agent',
        text: `Message ${i} : Réponse de l'agent Manager pour le point #${i}.\nValidation du rendu multi-lignes et du composant d'affichage.`,
        ts,
      });
    }
  }

  return messages;
};

const nowSec = Math.floor(Date.now() / 1000);

export const MOCK_TEST_SESSION: MessageSession = {
  id: 'test',
  title: 'Session de test (50 messages)',
  created_at: nowSec - 50 * 60,
  updated_at: nowSec,
  message_count: 50,
  model: 'hermes-3-llama-3.1-8b',
  provider: 'nous',
  source: 'mc',
  messages: generate50Messages(),
};

export const MOCK_SESSIONS_MAP: Record<string, MessageSession[]> = {
  manager: [MOCK_TEST_SESSION],
  recherche: [
    {
      id: 'session_recherche_1',
      title: 'Veille technologique et benchmarks',
      created_at: nowSec - 3600,
      updated_at: nowSec - 1800,
      message_count: 2,
      model: 'hermes-3-llama-3.1-8b',
      provider: 'nous',
      source: 'mc',
      messages: [
        { role: 'user', text: 'Peux-tu me résumer les dernières actualités IA ?', ts: nowSec - 3600 },
        { role: 'agent', text: 'Voici la synthèse des avancées récentes...', ts: nowSec - 3500 },
      ],
    },
  ],
};

export const MOCK_STATE: ApiState = {
  health: {
    gateway_state: 'active',
    telegram: 'connected',
    updated_at: new Date().toISOString(),
  },
  sessions: {
    tokens_in: 125430,
    tokens_out: 48920,
    messages: 142,
    sessions_total: 18,
    recent: [
      {
        id: 'test',
        title: 'Session de test (50 messages)',
        started_at: nowSec - 50 * 60,
        message_count: 50,
        input_tokens: 3400,
        output_tokens: 4200,
        model: 'hermes-3-llama-3.1-8b',
        profile: 'manager',
      },
    ],
  },
  vps: {
    cpu_pct: 14.5,
    mem_pct: 38.2,
    disk_pct: 42.1,
    mem_used_gb: 3.1,
    mem_total_gb: 8.0,
    disk_used_gb: 33.6,
    disk_total_gb: 80.0,
  },
  fleet: [
    {
      code: 'MA',
      initials: 'MA',
      role: 'Coordination & Direction',
      channel: 'direct',
      name: 'Manager',
      agent: 'manager',
      tasksToday: 12,
      success: 98,
      msgCount: 50,
      defaultModel: 'hermes-3-llama-3.1-8b',
      modelProvider: 'nous',
      share: 45,
      load: 18,
      tokens: '38.4k',
      latency: '240ms',
      state: 'idle',
      task: null,
    },
    {
      code: 'RE',
      initials: 'RE',
      role: 'Veille & Documentation',
      channel: 'direct',
      name: 'Recherche',
      agent: 'recherche',
      tasksToday: 8,
      success: 95,
      msgCount: 24,
      defaultModel: 'hermes-3-llama-3.1-8b',
      modelProvider: 'nous',
      share: 20,
      load: 12,
      tokens: '19.2k',
      latency: '310ms',
      state: 'idle',
      task: null,
    },
    {
      code: 'AN',
      initials: 'AN',
      role: 'Synthèse & Analyse',
      channel: 'direct',
      name: 'Analyse',
      agent: 'analyse',
      tasksToday: 5,
      success: 100,
      msgCount: 14,
      defaultModel: 'hermes-3-llama-3.1-8b',
      modelProvider: 'nous',
      share: 15,
      load: 8,
      tokens: '12.8k',
      latency: '290ms',
      state: 'idle',
      task: null,
    },
    {
      code: 'DV',
      initials: 'DV',
      role: 'Code & Architecture',
      channel: 'direct',
      name: 'Développeur',
      agent: 'developpeur',
      tasksToday: 14,
      success: 96,
      msgCount: 38,
      defaultModel: 'hermes-3-llama-3.1-8b',
      modelProvider: 'nous',
      share: 20,
      load: 22,
      tokens: '45.1k',
      latency: '260ms',
      state: 'idle',
      task: null,
    },
  ],
  models: [
    { id: 'hermes-3-llama-3.1-8b', label: 'Hermes 3 Llama 3.1 8B', vendor: 'Nous Research', tier: 'standard' },
    { id: 'hermes-3-llama-3.1-70b', label: 'Hermes 3 Llama 3.1 70B', vendor: 'Nous Research', tier: 'premium' },
    { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', vendor: 'Anthropic', tier: 'premium' },
  ],
  model_usage: [
    { name: 'hermes-3-llama-3.1-8b', count: 120, pct: 75 },
    { name: 'hermes-3-llama-3.1-70b', count: 40, pct: 25 },
  ],
  routing: {
    total: 160,
    models: 2,
    premium_calls: 40,
    fast_calls: 120,
    offload_pct: 75,
  },
  agentlogs: [
    { agent: 'MA', task: 'Gestion session de test', time: '14:02:15', model: 'hermes-3-llama-3.1-8b', status: 'completed' },
  ],
  agentlogs_stats: {
    total: 39,
    completed: 38,
    failed: 1,
  },
  board: [
    {
      id: 1,
      title: 'Session de test conversation 50 messages',
      status: 'doing',
      priority: 'high',
      notes: "Test de l'affichage et du défilement avec l'agent Manager",
      created_at: nowSec - 3600,
      updated_at: nowSec,
      agent: 'manager',
    },
  ],
  working_agents: [],
  waiting_agents: [],
  hermes_cron: [],
  content: [],
};
