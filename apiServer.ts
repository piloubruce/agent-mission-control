import express from "express";
import path from "path";

interface MessageItem {
  role: "user" | "agent";
  text: string;
  ts: number;
  error?: string | null;
  attachments?: string[];
}

interface MessageSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  messages: MessageItem[];
  provider?: string;
  model?: string;
}

export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // In-memory mock store for sessions per agent
  const agentSessions: Record<string, MessageSession[]> = {
    manager: [
      {
        id: "msg_1723980000000_a1b2",
        title: "Point de synchronisation de la flotte",
        created_at: Math.floor((Date.now() - 3600000) / 1000),
        updated_at: Math.floor((Date.now() - 1800000) / 1000),
        message_count: 2,
        provider: "lmstudio",
        model: "qwen2.5-coder-14b-instruct",
        messages: [
          {
            role: "user",
            text: "Quel est l'état d'avancement des tâches en cours sur la flotte ?",
            ts: Math.floor((Date.now() - 3600000) / 1000),
          },
          {
            role: "agent",
            text: "Bonjour ! Voici le point de situation :\n- **Développeur** : Finalisation du refactoring du client API et des handlers SSE.\n- **Recherche** : Analyse documentaire terminée, indexation prête.\n- **Système** : Tous les indicateurs VPS sont au vert (CPU: 14%, RAM: 48%).\n\nN'hésitez pas si vous souhaitez lancer une nouvelle tâche.",
            ts: Math.floor((Date.now() - 3590000) / 1000),
          },
        ],
      },
    ],
    recherche: [
      {
        id: "msg_1723970000000_c3d4",
        title: "Synthèse des modèles Qwen et Nemotron",
        created_at: Math.floor((Date.now() - 7200000) / 1000),
        updated_at: Math.floor((Date.now() - 5400000) / 1000),
        message_count: 2,
        provider: "lmstudio",
        model: "google/gemma-4-26b-a4b-qat",
        messages: [
          {
            role: "user",
            text: "Peux-tu me résumer les forces du modèle Nemotron Nano ?",
            ts: Math.floor((Date.now() - 7200000) / 1000),
          },
          {
            role: "agent",
            text: "Le modèle **Nvidia Nemotron-3-Nano** offre d'excellentes performances :\n- Débit mesuré élevé (~80 tokens/sec)\n- Latence réduite (~95ms)\n- Très bonne gestion des outils et raisonnement structuré.",
            ts: Math.floor((Date.now() - 7190000) / 1000),
          },
        ],
      },
    ],
    developpeur: [
      {
        id: "msg_1723960000000_e5f6",
        title: "Refactoring client SSE et gestion des erreurs",
        created_at: Math.floor((Date.now() - 10800000) / 1000),
        updated_at: Math.floor((Date.now() - 9000000) / 1000),
        message_count: 2,
        provider: "lmstudio",
        model: "nvidia/nemotron-3-nano-4b",
        messages: [
          {
            role: "user",
            text: "Vérifie les routes Express pour les messages.",
            ts: Math.floor((Date.now() - 10800000) / 1000),
          },
          {
            role: "agent",
            text: "J'ai vérifié les endpoints `/api/messages/*` et `/api/chat/stream`. Les routes de sessions, streaming SSE et suppression sont opérationnelles.",
            ts: Math.floor((Date.now() - 10790000) / 1000),
          },
        ],
      },
    ],
  };

  // Live status tracking for streaming
  const liveStatusMap: Map<string, { running: boolean; text: string; phase: string | null; error: string | null }> = new Map();

  // API Health
  app.get("/api/health", (req, res) => {
    res.json({ gateway_state: "running", telegram: "active", updated_at: new Date().toISOString() });
  });

  // API State
  app.get("/api/state", (req, res) => {
    res.json({
      health: { gateway_state: "running", telegram: "active", updated_at: new Date().toISOString() },
      vps: {
        cpu_pct: 14.2,
        mem_pct: 48.5,
        disk_pct: 32.1,
        mem_used_gb: 7.8,
        mem_total_gb: 16.0,
        disk_used_gb: 160.0,
        disk_total_gb: 500.0,
        gateway_start_time: Date.now() - 86400000,
        mc_start_time: Date.now() - 86400000,
      },
      fleet: [
        { code: "MA", initials: "MA", role: "Manager", channel: "#general", name: "Manager", agent: "manager", tasksToday: 12, success: 100, msgCount: 45, defaultModel: "qwen2.5-coder-14b-instruct", modelProvider: "lmstudio", share: 20, load: 15, tokens: "1.2k", latency: "140ms", state: "idle", task: null },
        { code: "RE", initials: "RE", role: "Recherche", channel: "#research", name: "Recherche", agent: "recherche", tasksToday: 8, success: 95, msgCount: 30, defaultModel: "google/gemma-4-26b-a4b-qat", modelProvider: "lmstudio", share: 20, load: 10, tokens: "850", latency: "110ms", state: "idle", task: null },
        { code: "DO", initials: "DO", role: "Developpeur", channel: "#dev", name: "Developpeur", agent: "developpeur", tasksToday: 25, success: 98, msgCount: 120, defaultModel: "nvidia/nemotron-3-nano-4b", modelProvider: "lmstudio", share: 30, load: 45, tokens: "3.4k", latency: "95ms", state: "active", task: "Refactoring API client" },
      ],
      routing: {
        total: 145,
        models: 142,
        premium_calls: 12,
        fast_calls: 133,
        offload_pct: 91.7,
      },
      sessions: {
        tokens_in: 45000,
        tokens_out: 12000,
        messages: 195,
        sessions_total: 24,
        recent: [
          { id: "s1", title: "Refactoring dashboard API", started_at: Date.now() - 3600000, message_count: 14, input_tokens: 2400, output_tokens: 890, model: "qwen2.5-coder-14b-instruct", profile: "hermes" }
        ]
      },
      models: [
        { id: "gwen-4.6v-flash", label: "Gwen 4.6v Flash", vendor: "LMStudio", tier: "Fast" },
        { id: "google/gemma-4-26b-a4b-qat", label: "Gemma 4 26B", vendor: "LMStudio", tier: "Pro" },
        { id: "nvidia/nemotron-3-nano-4b", label: "Nemotron Nano 4B", vendor: "LMStudio", tier: "Fast" },
        { id: "qwen2.5-coder-14b-instruct", label: "Qwen 2.5 Coder 14B", vendor: "LMStudio", tier: "Coder" }
      ],
      model_usage: [
        { name: "qwen2.5-coder-14b-instruct", count: 85, pct: 58 },
        { name: "nvidia/nemotron-3-nano-4b", count: 42, pct: 29 },
        { name: "google/gemma-4-26b-a4b-qat", count: 18, pct: 13 }
      ],
      agentlogs: [],
      agentlogs_stats: { total: 45, completed: 44, failed: 1 },
      board: [
        { id: 1, title: "Refactoring du client de messagerie", status: "done", priority: "high", notes: "Correction de l'inversion de date et gestion propre des tokens d'erreur", created_at: Date.now() - 86400000, updated_at: Date.now() }
      ],
      working_agents: [],
      waiting_agents: [],
      hermes_cron: [
        { id: "c1", name: "Daily Health Check", schedule: "0 8 * * *", next_run: "Demain à 08:00", last_run: "Aujourd'hui à 08:00", last_status: "success", enabled: true, description: "Vérifie l'état de santé du VPS et des agents." }
      ],
      content: []
    });
  });

  // GET /api/messages/sessions
  app.get("/api/messages/sessions", (req, res) => {
    const agent = String(req.query.agent || "manager").toLowerCase();
    const sessions = agentSessions[agent] || [];
    res.json({ agent, sessions });
  });

  // POST /api/messages/send
  app.post("/api/messages/send", (req, res) => {
    const { agent, session_id, text, files, persist } = req.body;
    const a = String(agent || "manager").toLowerCase();
    const sid = session_id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    if (!agentSessions[a]) {
      agentSessions[a] = [];
    }

    let session = agentSessions[a].find((s) => s.id === sid);
    const nowSec = Math.floor(Date.now() / 1000);

    if (!session) {
      session = {
        id: sid,
        title: (text || "Nouvelle session").slice(0, 45),
        created_at: nowSec,
        updated_at: nowSec,
        message_count: 0,
        messages: [],
        provider: "lmstudio",
        model: "qwen2.5-coder-14b-instruct",
      };
      agentSessions[a].unshift(session);
    }

    if (persist !== false) {
      session.messages.push({
        role: "user",
        text: text || "",
        ts: nowSec,
        attachments: files || [],
      });
      session.message_count = session.messages.length;
      session.updated_at = nowSec;
    }

    const key = `${a}:${sid}`;
    const agentResponse = `J'ai bien reçu votre message : "${text}".\n\nL'agent **${a}** traite votre demande avec succès. Tout fonctionne correctement.`;
    liveStatusMap.set(key, { running: true, text: "", phase: "generating", error: null });

    let currentLen = 0;
    const interval = setInterval(() => {
      const live = liveStatusMap.get(key);
      if (!live || !live.running) {
        clearInterval(interval);
        return;
      }
      currentLen += Math.max(3, Math.floor(Math.random() * 8) + 2);
      if (currentLen >= agentResponse.length) {
        live.running = false;
        live.text = agentResponse;
        live.phase = null;
        clearInterval(interval);
        if (persist !== false) {
          session.messages.push({
            role: "agent",
            text: agentResponse,
            ts: Math.floor(Date.now() / 1000),
          });
          session.message_count = session.messages.length;
          session.updated_at = Math.floor(Date.now() / 1000);
        }
      } else {
        live.text = agentResponse.slice(0, currentLen);
      }
    }, 100);

    res.json({ ok: true, agent: a, session_id: sid });
  });

  // GET /api/messages/status
  app.get("/api/messages/status", (req, res) => {
    const a = String(req.query.agent || "").toLowerCase();
    const sid = String(req.query.session_id || "");
    const key = `${a}:${sid}`;
    const live = liveStatusMap.get(key) || { running: false, text: "", phase: null, error: null };
    res.json({
      agent: a,
      session_id: sid,
      running: live.running,
      text: live.text,
      error: live.error,
      phase: live.phase,
    });
  });

  // GET /api/chat/stream
  app.get("/api/chat/stream", (req, res) => {
    const a = String(req.query.agent || "").toLowerCase();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sampleText = `Message bien reçu.\n\nL'agent **${a}** a validé votre requête. Les logs et métriques sont synchronisés.`;
    let idx = 0;

    const streamInterval = setInterval(() => {
      if (idx < sampleText.length) {
        const chunk = sampleText.slice(idx, idx + 4);
        idx += 4;
        res.write(`event: token\ndata: ${chunk}\n\n`);
      } else {
        clearInterval(streamInterval);
        res.write(`event: done\ndata: ${JSON.stringify({ error: null })}\n\n`);
        res.end();
      }
    }, 60);

    req.on("close", () => {
      clearInterval(streamInterval);
    });
  });

  // POST /api/messages/cancel
  app.post("/api/messages/cancel", (req, res) => {
    const { agent, session_id } = req.body || {};
    const key = `${agent}:${session_id}`;
    if (liveStatusMap.has(key)) {
      const st = liveStatusMap.get(key)!;
      st.running = false;
      st.phase = null;
    }
    res.json({ ok: true });
  });

  // POST /api/messages/delete
  app.post("/api/messages/delete", (req, res) => {
    const { agent, session_ids } = req.body || {};
    const a = String(agent || "").toLowerCase();
    if (!agentSessions[a]) {
      res.json({ ok: true, removed: 0 });
      return;
    }
    if (!session_ids || session_ids.length === 0 || (session_ids.length === 1 && session_ids[0] === "__all__")) {
      const count = agentSessions[a].length;
      agentSessions[a] = [];
      res.json({ ok: true, removed: count });
      return;
    }
    const set = new Set(session_ids);
    const before = agentSessions[a].length;
    agentSessions[a] = agentSessions[a].filter((s) => !set.has(s.id));
    res.json({ ok: true, removed: before - agentSessions[a].length });
  });

  // POST /api/messages/message/delete
  app.post("/api/messages/message/delete", (req, res) => {
    const { agent, session_id, message_index } = req.body || {};
    const a = String(agent || "").toLowerCase();
    const session = (agentSessions[a] || []).find((s) => s.id === session_id);
    if (session && typeof message_index === "number" && message_index >= 0 && message_index < session.messages.length) {
      session.messages.splice(message_index, 1);
      session.message_count = session.messages.length;
      res.json({ ok: true, removed: true });
    } else {
      res.json({ ok: false, error: "Message introuvable" });
    }
  });

  // POST /api/messages/message/edit
  app.post("/api/messages/message/edit", (req, res) => {
    const { agent, session_id, message_index, text, files } = req.body || {};
    const a = String(agent || "").toLowerCase();
    const session = (agentSessions[a] || []).find((s) => s.id === session_id);
    if (session && typeof message_index === "number" && message_index >= 0 && message_index < session.messages.length) {
      session.messages[message_index].text = text;
      if (files) session.messages[message_index].attachments = files;
      res.json({ ok: true, edited: true });
    } else {
      res.json({ ok: false, error: "Message introuvable" });
    }
  });

  // POST /api/messages/attachment/delete
  app.post("/api/messages/attachment/delete", (req, res) => {
    const { agent, session_id, message_index, attachment_path } = req.body || {};
    const a = String(agent || "").toLowerCase();
    const session = (agentSessions[a] || []).find((s) => s.id === session_id);
    if (session && session.messages[message_index]?.attachments) {
      session.messages[message_index].attachments = session.messages[message_index].attachments?.filter((p) => p !== attachment_path);
      res.json({ ok: true, removed: true });
    } else {
      res.json({ ok: false });
    }
  });

  // POST /api/messages/upload
  app.post("/api/messages/upload", (req, res) => {
    const { name } = req.body || {};
    res.json({
      ok: true,
      path: `/uploads/${name || "file_" + Date.now()}`,
      name: name || "file",
      size: 1024,
    });
  });

  // /api/models
  app.get("/api/models", (req, res) => {
    const provider = req.query.provider as string;
    const catalog = {
      count: 3,
      providers: {
        "lmstudio": {
          display_name: "LMStudio",
          count: 4,
          models: [
            { id: "gwen-4.6v-flash", name: "gwen-4.6v-flash", provider: "lmstudio", context_length: 131072 },
            { id: "google/gemma-4-26b-a4b-qat", name: "google/gemma-4-26b-a4b-qat", provider: "lmstudio", context_length: 131072 },
            { id: "nvidia/nemotron-3-nano-4b", name: "nvidia/nemotron-3-nano-4b", provider: "lmstudio", context_length: 32768 },
            { id: "nvidia/nemotron-3-nano-omni", name: "nvidia/nemotron-3-nano-omni", provider: "lmstudio", context_length: 32768 },
            { id: "qwen2.5-coder-14b-instruct", name: "qwen2.5-coder-14b-instruct", provider: "lmstudio", context_length: 131072 }
          ]
        },
        "nous": {
          display_name: "Nous",
          count: 3,
          models: [
            { id: "meituan/Longcat-2.0:free", name: "meituan/Longcat-2.0:free", provider: "nous", context_length: 32768 },
            { id: "poolside/Laguna-s-2.1:free", name: "poolside/Laguna-s-2.1:free", provider: "nous", context_length: 32768 },
            { id: "poolside/Laguna-xs-2.1:free", name: "poolside/Laguna-xs-2.1:free", provider: "nous", context_length: 32768 }
          ]
        },
        "omni-route": {
          display_name: "omni-route",
          count: 1,
          models: [
            { id: "omni-route", name: "omni-route", provider: "omni-route", context_length: 131072 }
          ]
        }
      }
    };
    if (provider) {
      const pData = catalog.providers[provider as keyof typeof catalog.providers];
      res.json({ provider, count: pData?.count || 0, models: pData?.models || [] });
    } else {
      res.json(catalog);
    }
  });

  // /api/scan/*
  app.get("/api/scan/blacklist", (req, res) => res.json({ blacklist: {} }));
  app.post("/api/scan/blacklist", (req, res) => res.json({ ok: true }));
  app.post("/api/scan/blacklist/clear", (req, res) => res.json({ ok: true, cleared: 0 }));
  app.get("/api/scan/results", (req, res) => {
    res.json({
      results: [
        { provider: "lmstudio", model: "gwen-4.6v-flash", ok: true, last_checked: Date.now() / 1000 - 300, latency_ms: 13020, tokens_per_sec: 22.1, score: { grade: "B", value: 61 }, vision_supported: true, reasoning_supported: true, tools_supported: true },
        { provider: "lmstudio", model: "google/gemma-4-26b-a4b-qat", ok: true, last_checked: Date.now() / 1000 - 300, latency_ms: 10376, tokens_per_sec: 20.7, score: { grade: "B", value: 68 }, vision_supported: true, reasoning_supported: true, tools_supported: true },
        { provider: "lmstudio", model: "nvidia/nemotron-3-nano-4b", ok: true, last_checked: Date.now() / 1000 - 300, latency_ms: 2139, tokens_per_sec: 81.8, score: { grade: "A", value: 94 }, vision_supported: true, reasoning_supported: true, tools_supported: true },
        { provider: "nous", model: "meituan/Longcat-2.0:free", ok: true, last_checked: Date.now() / 1000 - 600, latency_ms: 2241, tokens_per_sec: 22.3, score: { grade: "B", value: 69 }, vision_supported: true, reasoning_supported: true, tools_supported: true }
      ]
    });
  });
  app.post("/api/scan/results/clear", (req, res) => res.json({ ok: true, deleted: 4 }));
  app.post("/api/scan", (req, res) => res.json({ ok: true, scan_id: "scan_" + Date.now() }));
  app.get("/api/scan/status", (req, res) => res.json({ scan_id: req.query.scan_id || "scan_123", status: "done", done: true, results: [] }));
  app.post("/api/scan/cancel-all", (req, res) => res.json({ ok: true, cancelled: 1 }));
  app.post("/api/scan/cancel/:id", (req, res) => res.json({ ok: true }));
  app.get("/api/scan/test-capabilities", (req, res) => {
    res.json({ ok: true, vision_supported: true, reasoning_supported: true, tools_supported: true, latency_ms: 1200, tokens_per_sec: 45.0 });
  });

  // Config
  let storedConfig: Record<string, unknown> = {
    theme: "dark",
    shortcuts: {},
    hotkey_order: ["overview", "agents", "tasks", "timeline", "messages", "content", "schedule", "scan", "terminal", "files", "config"],
  };

  app.get("/api/config", (req, res) => res.json(storedConfig));
  app.post("/api/config", (req, res) => {
    storedConfig = { ...storedConfig, ...(req.body || {}) };
    res.json({ ok: true });
  });

  app.get("/api/config/scan_providers", (req, res) => {
    res.json({ scan_providers: { "lmstudio": true, "nous": true, "omni-route": true } });
  });
  app.post("/api/config/scan_providers", (req, res) => res.json({ ok: true }));

  // Backups
  const mockBackups = [
    { name: "backup_2026-08-18_auto.tar.gz", size: 2450000, mtime: Math.floor(Date.now() / 1000) - 7200 },
  ];
  app.get("/api/mc/backup/list", (req, res) => res.json({ ok: true, backups: mockBackups }));
  app.post("/api/mc/backup/create", (req, res) => {
    const name = `backup_${new Date().toISOString().slice(0, 10)}_${Date.now()}.tar.gz`;
    mockBackups.unshift({ name, size: 1024 * 1024 * 2, mtime: Math.floor(Date.now() / 1000) });
    res.json({ ok: true, backup_name: name, msg: "Backup créé avec succès" });
  });
  app.post("/api/mc/backup/restore", (req, res) => res.json({ ok: true, msg: "Restauration terminée" }));
  app.get("/api/mc/backup/download/:name", (req, res) => {
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}"`);
    res.send("Mock backup data");
  });

  // Files & FS
  const mockFiles: Record<string, Array<{ name: string; path: string; dir?: boolean; is_dir?: boolean; size?: number; mtime?: number }>> = {
    "": [
      { name: "workspace", path: "workspace", is_dir: true, mtime: Math.floor(Date.now() / 1000) - 86400 },
      { name: "scripts", path: "scripts", is_dir: true, mtime: Math.floor(Date.now() / 1000) - 172800 },
      { name: "notes.md", path: "notes.md", is_dir: false, size: 1420, mtime: Math.floor(Date.now() / 1000) - 3600 },
      { name: "config.json", path: "config.json", is_dir: false, size: 856, mtime: Math.floor(Date.now() / 1000) - 7200 },
    ],
    "workspace": [
      { name: "project.py", path: "workspace/project.py", is_dir: false, size: 4096, mtime: Math.floor(Date.now() / 1000) - 4000 },
    ],
    "scripts": [
      { name: "deploy.sh", path: "scripts/deploy.sh", is_dir: false, size: 512, mtime: Math.floor(Date.now() / 1000) - 8000 },
    ],
  };

  app.get("/api/fs/list", (req, res) => {
    const p = String(req.query.path || "");
    const items = mockFiles[p] || [];
    res.json({ ok: true, root: "/home/piloubruce", items });
  });
  app.get("/api/files/download", (req, res) => {
    const filePath = String(req.query.path || "file.txt");
    const inline = req.query.inline === "1";
    if (!inline) {
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(`# Fichier : ${filePath}\nContenu du fichier généré par Mission Control.`);
  });
  app.post("/api/files/upload", (req, res) => res.json({ ok: true }));
  app.post("/api/files/rename", (req, res) => res.json({ ok: true }));
  app.post("/api/files/mkdir", (req, res) => res.json({ ok: true }));
  app.delete("/api/files", (req, res) => res.json({ ok: true }));

  // Favs & Board
  app.get("/api/mc_favs", (req, res) => res.json({ ids: [] }));
  app.post("/api/mc_favs", (req, res) => res.json({ ok: true }));
  app.get("/api/board", (req, res) => res.json({ todo: [], doing: [], done: [] }));
  app.post("/api/board", (req, res) => res.json({ id: 1, ok: true }));

  // Cron
  app.get("/api/cron", (req, res) => {
    res.json({
      jobs: [
        { id: "c1", name: "Daily Health Check", schedule: "0 8 * * *", next_run: "Demain à 08:00", last_run: "Aujourd'hui à 08:00", last_status: "success", enabled: true, description: "Vérifie l'état de santé du VPS et des agents." }
      ]
    });
  });
  app.post("/api/cron", (req, res) => res.json({ ok: true, id: `cron_${Date.now()}` }));
  app.delete("/api/cron/:id", (req, res) => res.json({ ok: true, id: req.params.id }));
  app.post("/api/cron/:id/run", (req, res) => res.json({ ok: true, id: req.params.id }));
  app.get("/api/cron/script", (req, res) => res.json({ ok: true, content: "#!/bin/bash\n# Script de test\necho 'OK'" }));
  app.get("/api/cron/logs", (req, res) => res.json({ ok: true, executions: [] }));
  app.get("/api/cron/:id/logs", (req, res) => res.json({ ok: true, executions: [] }));

  // Content
  const mockContentFiles = [
    { name: "guide_architecture.md", rel_path: "docs/guide_architecture.md", size: 3420, mtime: Math.floor(Date.now() / 1000) - 3600 },
    { name: "agents_reference.md", rel_path: "docs/agents_reference.md", size: 5120, mtime: Math.floor(Date.now() / 1000) - 7200 },
    { name: "changelog.txt", rel_path: "changelog.txt", size: 1200, mtime: Math.floor(Date.now() / 1000) - 10800 },
  ];
  app.get("/api/content", (req, res) => {
    res.json({ files: mockContentFiles, page: 1, total: mockContentFiles.length, pages: 1 });
  });
  app.get("/api/content/file/:path(*)", (req, res) => {
    const p = req.params.path || req.query.path || "";
    res.json({
      ok: true,
      text: `# Document : ${p}\n\nDocumentation complète du système Hermes Mission Control.\n- Statut : Opérationnel\n- Version : 1.18.0\n\nCe document est synchronisé en temps réel.`
    });
  });
  app.get("/api/content/download/:path(*)", (req, res) => {
    const p = req.params.path || "document.txt";
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(p)}"`);
    res.send(`# Contenu téléchargé pour ${p}`);
  });

  // Notifications
  app.get("/api/notifications", (req, res) => {
    res.json({
      ok: true,
      notifications: [
        { type: "info", title: "Système prêt", message: "Tous les services sont opérationnels.", ts: Date.now() / 1000 }
      ]
    });
  });
  app.post("/api/notifications/add", (req, res) => res.json({ ok: true }));

  // Agent model settings
  app.post("/api/agent/model", (req, res) => res.json({ ok: true, agent: req.body?.agent, model: req.body?.model }));
  app.post("/api/agent/model/batch", (req, res) => res.json({ results: [{ ok: true }] }));

  // SSE Events
  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const interval = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: "ping", time: Date.now() })}\n\n`);
    }, 5000);

    req.on("close", () => {
      clearInterval(interval);
    });
  });

  return app;
}
