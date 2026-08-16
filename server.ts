import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Health
  app.get("/api/health", (req, res) => {
    res.json({ gateway_state: "running", telegram: "active", updated_at: new Date().toISOString() });
  });

  // API State
  app.get("/api/state", (req, res) => {
    res.json({
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
      cron_jobs: [
        { id: "c1", name: "Daily Health Check", schedule: "0 8 * * *", next_run: "Demain à 08:00", last_run: "Aujourd'hui à 08:00", last_status: "success", enabled: true, description: "Vérifie l'état de santé du VPS et des agents." }
      ],
      notifications: [
        { id: "n1", title: "Système opérationnel", message: "Tous les services tournent normalement.", time: "Il y a 5 min", type: "info" }
      ]
    });
  });

  // Model catalog (/api/models)
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

  // Scan endpoints
  app.get("/api/scan/blacklist", (req, res) => {
    res.json({ blacklist: {} });
  });
  app.post("/api/scan/blacklist", (req, res) => {
    res.json({ ok: true });
  });
  app.post("/api/scan/blacklist/clear", (req, res) => {
    res.json({ ok: true, cleared: 0 });
  });
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
  app.post("/api/scan/results/clear", (req, res) => {
    res.json({ ok: true, deleted: 4 });
  });
  app.post("/api/scan", (req, res) => {
    res.json({ ok: true, scan_id: "scan_" + Date.now() });
  });
  app.get("/api/scan/status", (req, res) => {
    res.json({
      scan_id: req.query.scan_id || "scan_123",
      status: "done",
      done: true,
      results: []
    });
  });
  app.post("/api/scan/cancel-all", (req, res) => {
    res.json({ ok: true, cancelled: 1 });
  });
  app.post("/api/scan/cancel/:id", (req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/scan/test-capabilities", (req, res) => {
    res.json({
      ok: true,
      vision_supported: true,
      reasoning_supported: true,
      tools_supported: true,
      latency_ms: 1200,
      tokens_per_sec: 45.0
    });
  });

  // Config scan providers
  app.get("/api/config/scan_providers", (req, res) => {
    res.json({ scan_providers: { "lmstudio": true, "nous": true, "omni-route": true } });
  });
  app.post("/api/config/scan_providers", (req, res) => {
    res.json({ ok: true });
  });

  // Favs & Board
  app.get("/api/mc_favs", (req, res) => {
    res.json({ ids: [] });
  });
  app.post("/api/mc_favs", (req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/board", (req, res) => {
    res.json({ todo: [], doing: [], done: [] });
  });
  app.post("/api/board", (req, res) => {
    res.json({ id: 1, ok: true });
  });

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

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
