import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock backend in-memory storage for local dev / preview in AI Studio
function hermesDevApiPlugin(): Plugin {
  const generate50Messages = () => {
    const messages: any[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const baseTimeSec = nowSec - 50 * 60;
    for (let i = 1; i <= 50; i++) {
      const isUser = i % 2 === 1;
      const ts = baseTimeSec + i * 60;
      if (isUser) {
        messages.push({
          id: i,
          role: 'user',
          text: `Message ${i} : Ligne de test utilisateur #${i} pour valider le défilement et l'affichage.`,
          ts,
        });
      } else {
        messages.push({
          id: i,
          role: 'agent',
          text: `Message ${i} : Réponse de l'agent Manager pour le point #${i}.\nValidation du rendu multi-lignes et du composant d'affichage.`,
          ts,
        });
      }
    }
    return messages;
  };

  const nowSec = Math.floor(Date.now() / 1000);

  const sessionsStore: Record<string, any[]> = {
    manager: [
      {
        id: 'test',
        title: 'Session de test (50 messages)',
        created_at: nowSec - 50 * 60,
        updated_at: nowSec,
        message_count: 50,
        model: 'hermes-3-llama-3.1-8b',
        provider: 'nous',
        source: 'mc',
        messages: generate50Messages(),
      },
    ],
    recherche: [
      {
        id: 'session_recherche_1',
        title: 'Veille technologique',
        created_at: nowSec - 3600,
        updated_at: nowSec - 1800,
        message_count: 2,
        model: 'hermes-3-llama-3.1-8b',
        provider: 'nous',
        source: 'mc',
        messages: [
          { id: 1, role: 'user', text: 'Peux-tu me résumer les dernières actualités IA ?', ts: nowSec - 3600 },
          { id: 2, role: 'agent', text: 'Voici la synthèse des actualités récentes...', ts: nowSec - 3500 },
        ],
      },
    ],
  };

  const mockState = {
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
          started_at: Date.now() - 50 * 60 * 1000,
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
        created_at: Date.now() - 3600 * 1000,
        updated_at: Date.now(),
        agent: 'manager',
      },
    ],
    working_agents: [],
    waiting_agents: [],
    hermes_cron: [],
    content: [],
  };

  return {
    name: 'hermes-dev-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const pathname = url.pathname;

        if (pathname === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write(`event: state\ndata: ${JSON.stringify(mockState)}\n\n`);
          const interval = setInterval(() => {
            res.write(`event: state\ndata: ${JSON.stringify(mockState)}\n\n`);
          }, 4000);
          req.on('close', () => clearInterval(interval));
          return;
        }

        if (pathname === '/api/chat/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write(`event: done\ndata: {}\n\n`);
          res.end();
          return;
        }

        if (pathname === '/api/state') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockState));
          return;
        }

        if (pathname === '/api/messages/sessions') {
          const agent = (url.searchParams.get('agent') || 'manager').toLowerCase();
          const list = sessionsStore[agent] || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ agent, sessions: list }));
          return;
        }

        if (pathname === '/api/messages/status') {
          const agent = url.searchParams.get('agent') || 'manager';
          const sid = url.searchParams.get('session_id') || 'test';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ agent, session_id: sid, running: false, text: '', error: null }));
          return;
        }

        if (pathname === '/api/messages/send' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body || '{}');
              const agent = (data.agent || 'manager').toLowerCase();
              let sid = data.session_id || 'msg_' + Date.now();
              if (!sessionsStore[agent]) sessionsStore[agent] = [];
              let sess = sessionsStore[agent].find((s) => s.id === sid);
              if (!sess) {
                sess = {
                  id: sid,
                  title: data.text ? data.text.slice(0, 30) : 'Nouvelle session',
                  created_at: Date.now(),
                  updated_at: Date.now(),
                  message_count: 0,
                  model: 'hermes-3-llama-3.1-8b',
                  provider: 'nous',
                  source: 'mc',
                  messages: [],
                };
                sessionsStore[agent].unshift(sess);
              }
              const userMsg = {
                id: sess.messages.length + 1,
                role: 'user',
                text: data.text || '',
                ts: Date.now(),
                attachments: data.files || [],
              };
              sess.messages.push(userMsg);
              const agentMsg = {
                id: sess.messages.length + 1,
                role: 'agent',
                text: `Réponse de ${agent} : J'ai bien reçu votre message : "${data.text}".`,
                ts: Date.now() + 500,
              };
              sess.messages.push(agentMsg);
              sess.message_count = sess.messages.length;
              sess.updated_at = Date.now();

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, session_id: sid }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }

        if (pathname === '/api/messages/delete' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            const data = JSON.parse(body || '{}');
            const agent = (data.agent || 'manager').toLowerCase();
            const sid = data.session_id;
            if (sessionsStore[agent]) {
              if (sid === '__all__') {
                sessionsStore[agent] = [];
              } else {
                sessionsStore[agent] = sessionsStore[agent].filter((s) => s.id !== sid);
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }

        if (pathname.startsWith('/api/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), hermesDevApiPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        treeshake: true,
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
