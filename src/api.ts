// api.ts — Shared Hermes API client + useApiState hook.
import React from 'react';
import { subscribeSse, subscribeSseOpen, subscribeSseError } from './lib/sse';
// Reads from the local Mission Control backend (server.py) on the same origin
// (proxied in dev via vite.config.ts, served behind a common origin in prod).

export interface Health {
  gateway_state: string | null;
  telegram: string | null;
  updated_at: string | null;
}

export interface SessionRecent {
  id: string;
  title: string;
  started_at: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  profile: string | null;
}

export interface SessionsBlock {
  tokens_in: number;
  tokens_out: number;
  messages: number;
  sessions_total: number;
  recent: SessionRecent[];
}

export interface Vps {
  cpu_pct: number;
  mem_pct: number;
  disk_pct: number;
  // Réels (server.read_vps, audit 2026-08-07 : manquaient au type alors que
  // OverviewTab les affiche) :
  mem_used_gb?: number;
  mem_total_gb?: number;
  disk_used_gb?: number;
  disk_total_gb?: number;
  gateway_start_time?: number | null;
  mc_start_time?: number | null;
}

export interface FleetAgent {
  code: string;
  initials: string;
  role: string;
  channel: string;
  name: string;
  agent: string; // lowercase key: manager/recherche/analyse/redacteur/social/reseau/developpeur/vision-image/vision-media
  tasksToday: number;
  success: number;
  msgCount: number;
  defaultModel: string | null;
  modelProvider: string | null;
  share: number;
  load: number;
  tokens: string;
  latency: string;
  state: string;
  task: string | null;
  // --- Option A: token usage counters per (agent, model) ---
  tokenUsage?: Record<string, { day: number; week: number; month: number }>;
  tokenRate?: Record<string, number>; // model -> tokens/s figé (dernier connu)
}

export interface ModelInfo {
  id: string;
  label: string;
  vendor: string;
  tier: string;
}

export interface ModelUsage {
  name: string;
  count: number;
  pct: number;
}

export interface Routing {
  total: number;
  models: number;
  premium_calls: number;
  fast_calls: number;
  offload_pct: number;
}

export interface AgentLog {
  agent: string; // short code: MA/RE/DO/RS/DV
  task: string | null;
  time: string | null;
  model: string | null;
  status: string;
}

export interface AgentLogsStats {
  total: number;
  completed: number;
  failed: number;
}

// Board task (owner task board). status: todo | doing | done
export interface BoardTask {
  id: number;
  title: string;
  status: 'todo' | 'doing' | 'done';
  priority: string;
  notes: string;
  created_at: number;
  updated_at: number;
  agent?: string;
}

// Real Hermes cron job (read from ~/.hermes/cron/jobs.json via /api/cron).
export interface CronJob {
  id: string;
  name: string;
  schedule: string | Record<string, unknown>;
  next_run: string;
  last_run: string;
  last_status: string;
  enabled: boolean;
  description: string;
  profile?: string;
  deliver?: string;
  // Champs optionnels : le backend (read_cron_jobs) envoie le prompt dans
  // `description`, mais certaines sources exposent aussi `prompt` / `script`
  // (jobs créés via l'API MC) et `schedule_display` (job brut).
  prompt?: string;
  script?: string;
  schedule_display?: string;
  agent?: string;
}

// A file in the real ~/hermes-docs library (read via /api/content).
export interface ContentFile {
  name: string;
  rel_path: string;
  path: string;
  size: number;
  mtime: number;
}

// Single-file content read (GET /api/content?path=...).
export interface ContentFileText {
  ok: boolean;
  path?: string;
  name?: string;
  text?: string;
  error?: string;
}

export interface ApiState {
  health: Health;
  sessions: SessionsBlock;
  vps: Vps;
  fleet: FleetAgent[];
  models: ModelInfo[];
  model_usage: ModelUsage[];
  routing: Routing;
  agentlogs: AgentLog[];
  agentlogs_stats: AgentLogsStats;
  board: BoardTask[];
  working_agents: string[];
  waiting_agents?: string[]; // réel champ serveur (audit 2026-08-07)
  hermes_cron: CronJob[];
  content: ContentFile[];
}

export async function apiFetch(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init ?? {};
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetch(path, {
      ...(ctrl ? { signal: ctrl.signal } : {}),
      ...rest,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import type { TaskStatus } from './types';

async function fetchJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error(`Réponse HTML inattendue sur ${path} (route API non reconnue)`);
  }
  const text = await res.text();
  if (!text || !text.trim()) {
    return {} as T;
  }
  if (text.trim().startsWith('<')) {
    throw new Error(`Réponse non-JSON reçue sur ${path} (HTML / document retourné)`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Format JSON invalide reçu sur ${path}`);
  }
}

export async function getState(): Promise<ApiState> {
  return fetchJson<ApiState>('/api/state');
}

/** Favoris de modeles par agent — persistes cote serveur (mc_favs.json). */
export async function getMcFavs(agent: string): Promise<string[]> {
  if (!agent) return [];
  try {
    const r = await fetchJson<{ ids?: string[] }>(
      '/api/mc_favs?agent=' + encodeURIComponent(agent),
    );
    return Array.isArray(r.ids) ? r.ids.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function setMcFavs(agent: string, ids: string[]): Promise<void> {
  if (!agent) return;
  try {
    await fetchJson<{ ok: boolean }>('/api/mc_favs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, ids }),
    });
  } catch {
    /* best effort: l'UI ne doit pas casser si l'ecriture echoue */
  }
}

// v1.17.141 - Ordre des cartes agents, persiste COTE SERVEUR (mc_config.json)
// pour etre partage entre tous les navigateurs/profils (localStorage etait
// perdu en navigation privee). GET = ordre actuel, POST = nouveau ordre.
export async function getAgentsOrder(): Promise<string[]> {
  try {
    const r = await fetchJson<{ ok?: boolean; agents_order?: string[] }>(
      '/api/fleet/agents_order',
    );
    return Array.isArray(r.agents_order)
      ? r.agents_order.filter((x) => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function setAgentsOrder(order: string[]): Promise<void> {
  try {
    await fetchJson<{ ok: boolean }>('/api/fleet/agents_order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents_order: order }),
    });
  } catch {
    /* best effort */
  }
}

export async function getBoard(): Promise<BoardTask[]> {
  // server.py returns a grouped dict {todo:[],doing:[],done:[]}.
  // Flatten into a single array the UI can filter/sort.
  const grouped = await fetchJson<Record<string, BoardTask[]>>('/api/board');
  const out: BoardTask[] = [];
  for (const key of ['todo', 'doing', 'done']) {
    if (Array.isArray(grouped[key])) {
      for (const t of grouped[key]) {
        out.push({ ...t, status: t.status === 'doing' ? 'doing' : (t.status as TaskStatus) });
      }
    }
  }
  return out;
}

export async function createBoardTask(payload: {
  title: string;
  status: 'todo' | 'doing' | 'done';
  priority?: string;
  notes?: string;
  agent?: string;
}): Promise<{ id: number; ok: boolean }> {
  return fetchJson<{ id: number; ok: boolean }>('/api/board', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function updateBoardTask(
  id: number,
  fields: Partial<Pick<BoardTask, 'title' | 'status' | 'priority' | 'notes'>>,
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/api/board/update?id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

export async function deleteBoardTask(id: number): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/api/board/delete?id=${id}`, {
    method: 'POST',
  });
}


// Per-agent model config (read from ~/.hermes/profiles/<agent>/config.yaml).
export interface FallbackModel {
  provider: string;
  model: string;
  base_url?: string;
}

export interface AgentModel {
  provider: string | null;
  model: string | null;
  // Top-level `fallback_providers:` list of the agent's config.yaml, in
  // stored order (position 0 = first fallback tried after the default).
  fallbacks?: FallbackModel[] | null;
}

export interface AgentModelBatchResult {
  ok: boolean;
  agent?: string;
  model?: AgentModel | null;
  error?: string;
}

export interface AgentModelBatchResponse {
  results: AgentModelBatchResult[];
}

// Model picker catalog (real Hermes provider/model data).
export interface CatalogModel {
  id: string;
  description: string;
  blacklisted?: boolean;
  tokens_per_sec?: number | null;
  latency_ms?: number | null;
  ok?: boolean | null;
  reason?: string | null;
  vision_supported?: boolean | null;
  reasoning_supported?: boolean | null;
  tools_supported?: boolean | null;
}
export interface CatalogProvider {
  display_name: string;
  freeform: boolean; // true = Hermes ne liste pas les modeles -> champ libre
  count: number; // nombre de modeles disponibles pour ce provider
  models: CatalogModel[];
  all_blacklisted?: boolean; // vrai champ serveur (audit 2026-08-07)
}
export interface ModelCatalog {
  providers: Record<string, CatalogProvider>;
}

// Single-provider live model list (GET /api/models?provider=X).
export interface ProviderModels {
  provider: string;
  freeform: boolean; // true = pas de liste live -> champ libre
  count: number; // nombre de modeles disponibles pour ce provider
  models: CatalogModel[];
}

// --- Per-agent model config (req #2) ---
export async function getAgentModel(agent: string): Promise<AgentModel | null> {
  const r = await fetchJson<{ agent: string; model: AgentModel | null }>(
    `/api/agent/model?agent=${encodeURIComponent(agent)}`,
  );
  return r.model;
}

export async function setAgentModel(
  agent: string,
  provider: string,
  model: string,
  fallbacks?: FallbackModel[] | null,
): Promise<{ ok: boolean; model?: AgentModel | null; error?: string }> {
  return fetchJson<{ ok: boolean; model?: AgentModel | null; error?: string }>(
    '/api/agent/model',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        fallbacks !== undefined ? { agent, provider, model, fallbacks } : { agent, provider, model },
      ),
    },
  );
}

// --- Batch model config ---
export async function getAgentModelBatch(
  agents: string[],
): Promise<AgentModelBatchResponse> {
  const qs = agents.map((a) => `agents=${encodeURIComponent(a)}`).join('&');
  return fetchJson<AgentModelBatchResponse>(`/api/agent/model/batch?${qs}`);
}

export async function setAgentModelBatch(
  agents: string[],
  provider: string,
  model: string,
  fallbacks?: FallbackModel[] | null,
): Promise<AgentModelBatchResponse> {
  return fetchJson<AgentModelBatchResponse>(
    '/api/agent/model/batch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        fallbacks !== undefined ? { agents, provider, model, fallbacks } : { agents, provider, model },
      ),
    },
  );
}

// --- Per-agent skills (Zap modal) ---
export interface AgentSkill {
  name: string;
  enabled: boolean;
}

export interface AgentSkillsResponse {
  agent: string;
  skills: AgentSkill[];
}

export interface AgentSkillsToggleResponse {
  ok: boolean;
  disabled?: string[];
  error?: string;
}

// GET the full installed skills list + enabled state for one agent.
export async function getAgentSkills(agent: string): Promise<AgentSkillsResponse> {
  return fetchJson<AgentSkillsResponse>(
    `/api/agent/skills?agent=${encodeURIComponent(agent)}`,
  );
}

// POST enable/disable one skill for one agent.
export async function toggleAgentSkill(
  agent: string,
  skill: string,
  enabled: boolean,
): Promise<AgentSkillsToggleResponse> {
  return fetchJson<AgentSkillsToggleResponse>('/api/agent/skills/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, skill, enabled }),
  });
}

// --- Model picker catalog (real providers/models) ---
export function formatProviderDisplay(key: string, displayName?: string): string {
  const normKey = (key || '').toLowerCase().replace(/[\s_-]/g, '');
  const normDisp = (displayName || '').toLowerCase().replace(/[\s_-]/g, '');
  if (normKey === 'omniroute' || normDisp === 'omniroute') {
    return 'omni-route';
  }
  return displayName || key;
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const cat = await fetchJson<ModelCatalog>('/api/models');
  if (cat && cat.providers) {
    for (const [key, meta] of Object.entries(cat.providers)) {
      meta.display_name = formatProviderDisplay(key, meta.display_name);
    }
  }
  return cat;
}

// Force a full recompute of the MC model catalog (bypass in-process cache) so
// newly-added providers (config.yaml `providers:` endpoints, fresh `hermes
// setup` custom endpoints) show up without restarting the server.
export async function refreshModelCatalog(): Promise<{ ok: boolean; providers?: number; models?: number; error?: string }> {
  return fetchJson<{ ok: boolean; providers?: number; models?: number; error?: string }>(
    '/api/models/refresh',
    { method: 'POST' },
  );
}

// Live fetch of ONE provider's model list (used when the user picks a
// provider in the picker, so the list is always fresh for that provider).
export async function getProviderModels(
  provider: string,
): Promise<ProviderModels> {
  const res = await fetchJson<ProviderModels>(
    `/api/models?provider=${encodeURIComponent(provider)}`,
  );
  if (res) {
    res.provider = formatProviderDisplay(res.provider, res.provider);
  }
  return res;
}

// POST restart the Mission Control server itself.
export async function restartServer(): Promise<{ ok: boolean; msg?: string; error?: string }> {
  return fetchJson<{ ok: boolean; msg?: string; error?: string }>('/api/restart', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Model blacklist (persisted KO models detected at scan time).
// Map shape: { "<provider>": ["model_id_1", "model_id_2", ...], ... }
// ---------------------------------------------------------------------------
export type BlacklistMap = Record<string, string[]>;

// GET the full persisted blacklist.
export async function getBlacklist(): Promise<BlacklistMap> {
  const r = await fetchJson<{ blacklist: BlacklistMap }>('/api/scan/blacklist');
  return r.blacklist ?? {};
}

// POST toggle a single provider::model (add if absent, remove if present).
export async function toggleBlacklist(
  provider: string,
  model: string,
): Promise<BlacklistMap> {
  const r = await fetchJson<{ ok: boolean; blacklist: BlacklistMap }>(
    '/api/scan/blacklist',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    },
  );
  return r.blacklist ?? {};
}

// POST clear ONE provider's blacklist (provider="") clears ALL.
export async function clearBlacklist(provider: string): Promise<BlacklistMap> {
  const r = await fetchJson<{ ok: boolean; blacklist: BlacklistMap }>(
    '/api/scan/blacklist/clear',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    },
  );
  return r.blacklist ?? {};
}

export interface CapabilityResult {
  vision_supported: boolean;
  reasoning_supported: boolean;
  tools_supported: boolean;
  error?: string | null;
  // 2026-08-12 : etat fin par capacite ('ok' | 'ko' | 'time' | null).
  // 'time' = la sonde a expire (timeout) -> badge ORANGE 'TIMEOUT'.
  // Ajoute par l'UI/serveur sans casser la compat booleenne existante.
  vision_state?: 'ok' | 'ko' | 'time' | null;
  reasoning_state?: 'ok' | 'ko' | 'time' | null;
  tools_state?: 'ok' | 'ko' | 'time' | null;
}

export async function testCapabilities(provider: string, model: string, cap: 'all' | 'vision' | 'reasoning' | 'tools' = 'all'): Promise<CapabilityResult> {
  // Launch capability probe asynchronously on the server, then poll for
  // results.  This avoids blocking the HTTP handler (and the entire dashboard)
  // for the 600s a full probe can take.
  const startRes = await fetchJson<{ cap_id?: string; status?: string; error?: string }>(
    `/api/scan/test-capabilities?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}&cap=${encodeURIComponent(cap)}`,
    { timeoutMs: 10_000 },
  );
  const capId = (startRes as any).cap_id;
  if (!capId) {
    // Fallback: server returned result directly (legacy path or error)
    return startRes as unknown as CapabilityResult;
  }
  // Poll until done or error (max 600s)
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetchJson<{ status: string; result?: CapabilityResult }>(
      `/api/scan/cap-status?cap_id=${encodeURIComponent(capId)}`,
      { timeoutMs: 10_000 },
    );
    if (poll.status === 'done' || poll.status === 'error') {
      return (poll.result || { vision_supported: false, reasoning_supported: false, tools_supported: false }) as CapabilityResult;
    }
  }
  return { vision_supported: false, reasoning_supported: false, tools_supported: false, error: 'timeout' };
}

// --- Real Hermes cron jobs (req #5) ---
export async function getCron(): Promise<CronJob[]> {
  const r = await fetchJson<{ jobs: CronJob[] }>('/api/cron');
  return r.jobs ?? [];
}

/** Création d'une tâche cron réelle depuis l'onglet Planification. */
export interface CreateCronPayload {
  name: string;
  agent: string;
  prompt: string;
  schedule: string;
  deliver: string | string[];
  enabled: boolean;
}

export async function createCron(
  payload: CreateCronPayload,
): Promise<{ ok: boolean; id?: string; error?: string; profile?: string }> {
  try {
    const res = await apiFetch('/api/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: string;
      error?: string;
      profile?: string;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, id: body.id, profile: body.profile };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// DELETE /api/cron/:id
export async function deleteCron(
  jobId: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    const res = await apiFetch(`/api/cron/${jobId}`, {
      method: 'DELETE',
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      id?: string;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, id: jobId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteCronExecution(
  executionId: string,
): Promise<{ ok: boolean; error?: string; deleted?: number }> {
  try {
    const res = await apiFetch(`/api/cron/execution/${encodeURIComponent(executionId)}`, {
      method: 'DELETE',
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      deleted?: number;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, deleted: body.deleted };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// PATCH /api/cron/:id
export interface UpdateCronPayload {
  name?: string;
  prompt?: string;
  description?: string;
  schedule?: string;
  deliver?: string | string[];
  enabled?: boolean;
  agent?: string;
}

export async function updateCron(
  jobId: string,
  payload: UpdateCronPayload,
): Promise<{ ok: boolean; id?: string; error?: string; profile?: string }> {
  try {
    const res = await apiFetch(`/api/cron/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: string;
      error?: string;
      profile?: string;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, id: body.id, profile: body.profile };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// POST /api/cron/:id/run - Execute cron immediately
export async function runCron(
  jobId: string,
): Promise<{ ok: boolean; execution_id?: string; error?: string }> {
  try {
    const res = await apiFetch(`/api/cron/${jobId}/run`, {
      method: 'POST',
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      execution_id?: string;
      error?: string;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, execution_id: body.execution_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// GET /api/cron/script?path=<nom_du_script> - contenu d'un script de job cron
// (jobs no_agent : "mail-watch.sh", "mc_state_db_watchdog.sh", ...).
export async function getCronScript(
  path: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  try {
    const res = await apiFetch(`/api/cron/script?path=${encodeURIComponent(path)}`);
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      content?: string;
      error?: string;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, content: body.content ?? '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- Content library (req #6): real ~/hermes-docs ---
// No page arg -> backend returns the FULL library (legacy behaviour,
// the ContentTab uses this for client-side search/filter).
export async function getContent(): Promise<ContentFile[]> {
  const r = await fetchJson<{ files: ContentFile[] }>('/api/content');
  return r.files ?? [];
}

// Paginated access (optA 2026-08-02): the Content tab can page through
// ~/hermes-docs (674 MB / 6705 files) 50 at a time instead of pulling the
// whole tree. Returns the full envelope so the UI can render page controls.
export interface ContentPage {
  files: ContentFile[];
  page: number;
  per_page: number;
  total: number;
  pages: number;
}
export async function getContentPage(page: number): Promise<ContentPage> {
  const r = await fetchJson<ContentPage>(`/api/content?page=${page}`);
  return r;
}

export async function getContentFile(
  relPath: string,
): Promise<ContentFileText> {
  return fetchJson<ContentFileText>(
    `/api/content?path=${encodeURIComponent(relPath)}`,
  );
}

/** Result of a single model probe in the Scan tab. */
export type LifeState = 'vert' | 'orange' | 'rouge';

export interface ScanModelResult {
  model: string;
  // ok reste un BOOLEEN (compat totale) : true pour VERT **et** ORANGE (le
  // modele repond), false pour ROUGE. La nuance vit dans life_state.
  ok: boolean;
  reason: string;    // raison lisible (salutation detectee / sans salutation / erreur)
  // Verdict du test de vie a 3 etats (backend 2026-08-06). Absent sur les
  // lignes anterieures a la migration -> on retombe sur ok.
  life_state?: LifeState;
  life_answer?: string;     // texte reellement recu (tronque 300 c.), pour le survol
  latency_ms?: number;      // temps de reponse du probe (ms)
  tokens_per_sec?: number;  // vitesse estimee (tokens/s)
  last_checked?: number;    // epoch seconds (float) du dernier probe (backend _probe_one)
  provider?: string;        // (additif) provider d'origine, taggue cote frontend en mode multi-providers
  // Persisted capability-test detail (server side, since 2026-08-03). Present
  // only when a capability probe ran for this (provider, model); undefined = never probed.
  last_cap_check?: number;
  vision_supported?: boolean;
  reasoning_supported?: boolean;
  tools_supported?: boolean;
  error?: string | null;    // capped to boolean presence at write time
  // 2026-08-11 : dernière sonde capa tombee en erreur reseau -> a reVerifier.
  // Pose par server.py dans GET /api/scan/results (pas de reshape front cote mappage).
  cap_neterr?: boolean;
  cap_conf?: { vision: number; reasoning: number; tools: number };
  // Spécifications techniques du modèle (contexte, paramètres, etc.)
  context_length?: number | null;
  parameter_count?: string | number | null;
  specs_error?: string | null;
  specs_display?: string | null;
}

export interface ModelDeepSpecs {
  context_length?: number | null;
  architecture?: string | null;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    display?: string | null;
  } | null;
  modalities?: string | null;
  description?: string | null;
  raw?: Record<string, unknown> | null;
  specs_display?: string;
  error?: string | null;
}

export type ModelSpecs = ModelDeepSpecs;

// ---------------------------------------------------------------------------
// REGISTRE INTERNE DES MODÈLES D'HERMES AGENT (Source Locale de Vérité)
// Utilisé en fallback / priorité pour NOUS, OMNI-ROUTE, etc.
// ---------------------------------------------------------------------------
interface HermesRegistryModelDef {
  context_length: number;
  architecture?: string;
  modalities?: string;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
    display?: string;
  };
  description?: string;
}

export const HERMES_INTERNAL_MODEL_REGISTRY: Record<string, HermesRegistryModelDef> = {
  // --- Tencent hy3 (free) : context 262144 comme Hermès Agent natif ---
  'hy3:free': { context_length: 262144, architecture: 'MoE / Tencent', modalities: 'Text', pricing: { prompt: 0, completion: 0, display: 'Gratuit' }, description: 'Tencent hy3 free (262k ctx)' },
  'hy3-free': { context_length: 262144, architecture: 'MoE / Tencent', modalities: 'Text', pricing: { prompt: 0, completion: 0, display: 'Gratuit' }, description: 'Tencent hy3 free (262k ctx)' },
  'tencent/hy3:free': { context_length: 262144, architecture: 'MoE / Tencent', modalities: 'Text', pricing: { prompt: 0, completion: 0, display: 'Gratuit' }, description: 'Tencent hy3 free via Nous/OmniRoute (262k ctx)' },
  'tencent/hy3-free': { context_length: 262144, architecture: 'MoE / Tencent', modalities: 'Text', pricing: { prompt: 0, completion: 0, display: 'Gratuit' }, description: 'Tencent hy3 free via Nous/OmniRoute (262k ctx)' },
  // --- StepFun / Nous Portal Models ---
  'stepfun/step-3.7-flash:free': {
    context_length: 262144,
    architecture: 'MoE / StepFun',
    modalities: 'Text+Vision',
    pricing: { prompt: 0, completion: 0, display: 'Gratuit' },
    description: 'StepFun 3.7 Flash Free Tier sur Nous Portal (256k tokens)',
  },
  'stepfun/step-3.7-flash': {
    context_length: 262144,
    architecture: 'MoE / StepFun',
    modalities: 'Text+Vision',
    pricing: { prompt: 0, completion: 0, display: 'Gratuit' },
    description: 'StepFun 3.7 Flash sur Nous Portal (256k tokens)',
  },
  'step-3.7-flash:free': {
    context_length: 262144,
    architecture: 'MoE / StepFun',
    modalities: 'Text+Vision',
    pricing: { prompt: 0, completion: 0, display: 'Gratuit' },
  },
  'step-3.7-flash': {
    context_length: 262144,
    architecture: 'MoE / StepFun',
    modalities: 'Text+Vision',
    pricing: { prompt: 0, completion: 0, display: 'Gratuit' },
  },
  'stepfun/step-3.5-flash:free': {
    context_length: 262144,
    architecture: 'MoE / StepFun',
    modalities: 'Text+Vision',
    pricing: { prompt: 0, completion: 0, display: 'Gratuit' },
  },
  'stepfun/step-3.5-flash': {
    context_length: 262144,
    architecture: 'MoE / StepFun',
    modalities: 'Text+Vision',
  },
  'stepfun/step-2-16k': {
    context_length: 16384,
    architecture: 'StepFun',
    modalities: 'Text',
  },

  // --- Nous Research Hermes Models ---
  'nousresearch/hermes-3-llama-3.1-405b': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text+Tools',
    description: 'Hermes 3 Llama 3.1 405B Flagship',
  },
  'hermes-3-llama-3.1-405b': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text+Tools',
  },
  'nousresearch/hermes-3-llama-3.1-70b': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text+Tools',
    description: 'Hermes 3 Llama 3.1 70B',
  },
  'hermes-3-llama-3.1-70b': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text+Tools',
  },
  'nousresearch/hermes-3-llama-3.1-8b': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text+Tools',
    description: 'Hermes 3 Llama 3.1 8B',
  },
  'hermes-3-llama-3.1-8b': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text+Tools',
  },
  'nousresearch/deephermes-3-llama-3-8b-preview': {
    context_length: 131072,
    architecture: 'Llama 3 / Reasoning',
    modalities: 'Text+Tools',
  },
  'deephermes-3-llama-3-8b-preview': {
    context_length: 131072,
    architecture: 'Llama 3 / Reasoning',
    modalities: 'Text+Tools',
  },
  'nousresearch/hermes-2-pro-llama-3-8b': {
    context_length: 8192,
    architecture: 'Llama 3',
    modalities: 'Text+Tools',
  },
  'hermes-2-pro-llama-3-8b': {
    context_length: 8192,
    architecture: 'Llama 3',
    modalities: 'Text+Tools',
  },

  // --- Meta Llama 3.1 / 3.3 Models ---
  'meta-llama/llama-3.3-70b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.3',
    modalities: 'Text',
  },
  'llama-3.3-70b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.3',
    modalities: 'Text',
  },
  'meta-llama/llama-3.1-405b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text',
  },
  'llama-3.1-405b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text',
  },
  'meta-llama/llama-3.1-70b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text',
  },
  'llama-3.1-70b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text',
  },
  'meta-llama/llama-3.1-8b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text',
  },
  'llama-3.1-8b-instruct': {
    context_length: 131072,
    architecture: 'Llama 3.1',
    modalities: 'Text',
  },

  // --- DeepSeek Models ---
  'deepseek/deepseek-r1': {
    context_length: 65536,
    architecture: 'MoE / DeepSeek R1',
    modalities: 'Text',
  },
  'deepseek-r1': {
    context_length: 65536,
    architecture: 'MoE / DeepSeek R1',
    modalities: 'Text',
  },
  'deepseek/deepseek-chat': {
    context_length: 65536,
    architecture: 'MoE / DeepSeek V3',
    modalities: 'Text',
  },
  'deepseek-chat': {
    context_length: 65536,
    architecture: 'MoE / DeepSeek V3',
    modalities: 'Text',
  },
  'deepseek/deepseek-v3': {
    context_length: 65536,
    architecture: 'MoE / DeepSeek V3',
    modalities: 'Text',
  },
  'deepseek-v3': {
    context_length: 65536,
    architecture: 'MoE / DeepSeek V3',
    modalities: 'Text',
  },

  // --- Qwen 2.5 Models ---
  'qwen/qwen-2.5-72b-instruct': {
    context_length: 131072,
    architecture: 'Qwen 2.5',
    modalities: 'Text',
  },
  'qwen-2.5-72b-instruct': {
    context_length: 131072,
    architecture: 'Qwen 2.5',
    modalities: 'Text',
  },
  'qwen/qwen-2.5-coder-32b-instruct': {
    context_length: 131072,
    architecture: 'Qwen 2.5',
    modalities: 'Text',
  },
  'qwen-2.5-coder-32b-instruct': {
    context_length: 131072,
    architecture: 'Qwen 2.5',
    modalities: 'Text',
  },
  'qwen/qwen-2.5-32b-instruct': {
    context_length: 131072,
    architecture: 'Qwen 2.5',
    modalities: 'Text',
  },
  'qwen/qwen-2.5-14b-instruct': {
    context_length: 131072,
    architecture: 'Qwen 2.5',
    modalities: 'Text',
  },
  'qwen/qwen-2.5-7b-instruct': {
    context_length: 131072,
    architecture: 'Qwen 2.5',
    modalities: 'Text',
  },

  // --- Mistral AI Models ---
  'mistralai/mistral-large-2411': {
    context_length: 131072,
    architecture: 'Mistral',
    modalities: 'Text',
  },
  'mistral-large-2411': {
    context_length: 131072,
    architecture: 'Mistral',
    modalities: 'Text',
  },
  'mistralai/mistral-nemo': {
    context_length: 131072,
    architecture: 'Mistral',
    modalities: 'Text',
  },
  'mistral-nemo': {
    context_length: 131072,
    architecture: 'Mistral',
    modalities: 'Text',
  },
  'mistralai/mixtral-8x22b-instruct': {
    context_length: 65536,
    architecture: 'MoE',
    modalities: 'Text',
  },
  'mixtral-8x22b': {
    context_length: 65536,
    architecture: 'MoE',
    modalities: 'Text',
  },

  // --- Anthropic Models ---
  'anthropic/claude-3-5-sonnet': {
    context_length: 200000,
    architecture: 'Claude 3.5',
    modalities: 'Text+Vision',
  },
  'claude-3-5-sonnet-20241022': {
    context_length: 200000,
    architecture: 'Claude 3.5',
    modalities: 'Text+Vision',
  },
  'anthropic/claude-3-5-haiku': {
    context_length: 200000,
    architecture: 'Claude 3.5',
    modalities: 'Text',
  },
  'claude-3-5-haiku-20241022': {
    context_length: 200000,
    architecture: 'Claude 3.5',
    modalities: 'Text',
  },

  // --- OpenAI Models ---
  'openai/gpt-4o': {
    context_length: 128000,
    architecture: 'GPT-4o',
    modalities: 'Text+Vision',
  },
  'gpt-4o': {
    context_length: 128000,
    architecture: 'GPT-4o',
    modalities: 'Text+Vision',
  },
  'openai/gpt-4o-mini': {
    context_length: 128000,
    architecture: 'GPT-4o',
    modalities: 'Text+Vision',
  },
  'gpt-4o-mini': {
    context_length: 128000,
    architecture: 'GPT-4o',
    modalities: 'Text+Vision',
  },
  'openai/o1': {
    context_length: 200000,
    architecture: 'o1',
    modalities: 'Text',
  },
  'o1': {
    context_length: 200000,
    architecture: 'o1',
    modalities: 'Text',
  },
  'openai/o3-mini': {
    context_length: 200000,
    architecture: 'o3-mini',
    modalities: 'Text',
  },
  'o3-mini': {
    context_length: 200000,
    architecture: 'o3-mini',
    modalities: 'Text',
  },

  // --- Google Gemini Models ---
  'google/gemini-2.0-flash-exp': {
    context_length: 1048576,
    architecture: 'Gemini 2.0',
    modalities: 'Text+Vision+Audio',
  },
  'gemini-2.0-flash-exp': {
    context_length: 1048576,
    architecture: 'Gemini 2.0',
    modalities: 'Text+Vision+Audio',
  },
  'google/gemini-1.5-pro': {
    context_length: 2097152,
    architecture: 'Gemini 1.5',
    modalities: 'Text+Vision+Audio',
  },
  'gemini-1.5-pro': {
    context_length: 2097152,
    architecture: 'Gemini 1.5',
    modalities: 'Text+Vision+Audio',
  },
};

/**
 * Formate un nombre de tokens de contexte de manière lisible (ex: 262k, 128k, 1M, 2M)
 */
export function formatContextLength(ctx: number): string {
  if (ctx >= 1_000_000) {
    return `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (ctx >= 1_000) {
    return `${Math.round(ctx / 1_000)}k`;
  }
  return `${ctx}`;
}

/**
 * Recherche synchrone d'un modèle dans le registre interne Hermes Agent
 * Effectue un matching exact ou par motif de famille.
 */
export function getHermesRegistryModel(provider: string, modelId: string): ModelDeepSpecs | null {
  const provClean = (provider || '').trim();
  const idClean = (modelId || '').trim();
  if (!idClean) return null;

  const lowId = idClean.toLowerCase();
  const withoutPrefix = lowId.includes('/') ? lowId.slice(lowId.indexOf('/') + 1) : lowId;
  const withoutSuffix = lowId.replace(/:(free|beta|nitro|extended)$/i, '');

  // 1. Recherche par correspondance exacte ou normalisée dans le registre
  let match: HermesRegistryModelDef | null =
    HERMES_INTERNAL_MODEL_REGISTRY[lowId] ||
    HERMES_INTERNAL_MODEL_REGISTRY[idClean] ||
    HERMES_INTERNAL_MODEL_REGISTRY[withoutPrefix] ||
    HERMES_INTERNAL_MODEL_REGISTRY[withoutSuffix] ||
    null;

  // 2. Recherche par famille/motif si non trouvé exactement
  if (!match) {
    if (lowId.includes('step-3.7') || lowId.includes('stepfun/step-3.7')) {
      match = {
        context_length: 262144,
        architecture: 'MoE / StepFun',
        modalities: 'Text+Vision',
        pricing: lowId.includes('free') ? { prompt: 0, completion: 0, display: 'Gratuit' } : undefined,
      };
    } else if (lowId.includes('step-3.5') || lowId.includes('stepfun/step-3.5')) {
      match = {
        context_length: 262144,
        architecture: 'MoE / StepFun',
        modalities: 'Text+Vision',
      };
    } else if (lowId.includes('hermes-3') || lowId.includes('deephermes')) {
      match = {
        context_length: 131072,
        architecture: 'Llama 3.1',
        modalities: 'Text+Tools',
      };
    } else if (lowId.includes('llama-3.3') || lowId.includes('llama-3.1')) {
      match = {
        context_length: 131072,
        architecture: 'Llama',
        modalities: 'Text',
      };
    } else if (lowId.includes('deepseek-r1') || lowId.includes('deepseek-v3') || lowId.includes('deepseek-chat')) {
      match = {
        context_length: 65536,
        architecture: 'MoE / DeepSeek',
        modalities: 'Text',
      };
    } else if (lowId.includes('qwen-2.5') || lowId.includes('qwen2.5')) {
      match = {
        context_length: 131072,
        architecture: 'Qwen 2.5',
        modalities: 'Text',
      };
    } else if (lowId.includes('claude-3-5') || lowId.includes('claude-3')) {
      match = {
        context_length: 200000,
        architecture: 'Claude 3.5',
        modalities: 'Text+Vision',
      };
    } else if (lowId.includes('gpt-4o')) {
      match = {
        context_length: 128000,
        architecture: 'GPT-4o',
        modalities: 'Text+Vision',
      };
    } else if (lowId.includes('gemini-2')) {
      match = {
        context_length: 1048576,
        architecture: 'Gemini 2.0',
        modalities: 'Text+Vision+Audio',
      };
    } else if (lowId.includes('gemini-1.5')) {
      match = {
        context_length: 2097152,
        architecture: 'Gemini 1.5',
        modalities: 'Text+Vision+Audio',
      };
    } else if (lowId.includes('nemotron-3-ultra')) {
      // NVIDIA Nemotron 3 Ultra 550B (FreeLLMAPI / OpenRouter) — 1M ctx
      match = {
        context_length: 1000000,
        architecture: 'NVIDIA Nemotron 3 Ultra (550B)',
        modalities: 'Text',
      };
    } else if (lowId.includes('nemotron-3-super')) {
      // NVIDIA Nemotron 3 Super 120B (OmniRoute / OpenRouter) — 128k ctx
      // (Hermes affiche 128k dans le chat pour nvidia/nvidia/nemotron-3-super-120b-a12b)
      match = {
        context_length: 128000,
        architecture: 'NVIDIA Nemotron 3 Super (120B)',
        modalities: 'Text',
      };
    } else if (lowId.includes('nemotron-3.5')) {
      // NVIDIA Nemotron 3.5 Lightning (FreeLLMAPI / OpenRouter) — 1M ctx
      match = {
        context_length: 1000000,
        architecture: 'NVIDIA Nemotron 3.5 Lightning',
        modalities: 'Text',
      };
    } else if (lowId.includes('poolside/laguna') || lowId.includes('laguna')) {
      // Poolside Laguna (Nous Portal / OpenRouter) — 256k ctx
      match = {
        context_length: 262144,
        architecture: 'Poolside Laguna',
        modalities: 'Text',
      };
    } else if (lowId.includes('meituan/longcat') || lowId.includes('longcat')) {
      // Meituan Longcat (Nous Portal) — 32k ctx
      match = {
        context_length: 32768,
        architecture: 'Meituan Longcat',
        modalities: 'Text',
      };
    } else if (lowId.includes('glm-4.5') || lowId.includes('glm4.5')) {
      // Zhipu GLM 4.5 Flash (FreeLLMAPI) — 128k ctx
      match = {
        context_length: 128000,
        architecture: 'Zhipu GLM 4.5',
        modalities: 'Text+Vision',
      };
    } else if (lowId.includes('freellmapi') || lowId.includes('fusion') || lowId.includes('auto')) {
      // FreeLLMAPI : agregateur de modeles (fusion / auto / nemotron-3-ultra-550b).
      // Pas d'API de metadata publique -> on donne une estimation generique.
      // 'fusion' et 'auto' sont des routeurs maison, pas des LLM nominatifs.
      match = {
        context_length: 128000,
        architecture: 'FreeLLMAPI Router',
        modalities: 'Text',
      };
    }
  }

  if (!match) return null;

  const ctxFormatted = formatContextLength(match.context_length);
  const provDisplay = (provClean || 'HERMES').toUpperCase();

  // Instruction 3 : Afficher Ctx: [Valeur de Context] | Source: Hermes Local / [Provider]
  const parts: string[] = [
    `Ctx: ${ctxFormatted}`,
    `Source: Hermes Local / ${provDisplay}`,
  ];
  if (match.architecture) parts.push(`Arch: ${match.architecture}`);
  if (match.pricing?.display) parts.push(`Coût: ${match.pricing.display}`);
  if (match.modalities) parts.push(`Modalités: ${match.modalities}`);

  return {
    context_length: match.context_length,
    architecture: match.architecture || null,
    pricing: match.pricing || null,
    modalities: match.modalities || null,
    description: match.description || null,
    raw: { source: 'hermes_local_registry', provider: provClean, modelId: idClean },
    specs_display: parts.join(' | '),
    error: null,
  };
}

// Cache en mémoire des modèles retournés par les APIs des providers (valide 30 secondes par provider)
const providerModelsApiCache = new Map<string, { timestamp: number; models: any[] }>();

export function normProv(p?: string | null): string {
  const s = (p || '').replace(/^custom:/i, '').trim().toLowerCase();
  if (s === 'omni route' || s === 'omni_route' || s === 'omniroute') {
    return 'omni-route';
  }
  return s.replace(/\s+/g, '-').replace(/_/g, '-');
}

/**
 * Effectue un véritable appel HTTP GET vers l'API du provider ou le registre local Hermes
 * pour obtenir la liste complète brute des modèles avec leurs métadonnées JSON réelles.
 */
async function fetchProviderRawModels(provider: string): Promise<any[]> {
  const provKey = normProv(provider);
  const cached = providerModelsApiCache.get(provKey);
  if (cached && Date.now() - cached.timestamp < 30_000) {
    return cached.models;
  }

  const results: any[] = [];

  // 1. Détermination de l'endpoint direct selon le provider
  if (provKey === 'openrouter' || provKey.includes('openrouter')) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.data)) {
          providerModelsApiCache.set(provKey, { timestamp: Date.now(), models: json.data });
          return json.data;
        }
      }
    } catch (e) {
      console.warn('[ModelSpecs] Échec fetch direct OpenRouter API:', e);
    }
  } else if (provKey === 'nous' || provKey.includes('nous')) {
    // NOUS PORTAL : Tenter l'endpoint direct Nous Portal
    try {
      const res = await apiFetch('https://portal.nousresearch.com/api/v1/models', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeoutMs: 3000,
      });
      if (res.ok) {
        const json = await res.json();
        const list = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
        if (list.length > 0) {
          providerModelsApiCache.set(provKey, { timestamp: Date.now(), models: list });
          return list;
        }
      }
    } catch {
      // Poursuivre vers les fallbacks Hermes locaux
    }
  } else if (provKey === 'ollama' || provKey.includes('ollama')) {
    try {
      const res = await apiFetch('http://localhost:11434/api/tags', { timeoutMs: 3000 });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.models)) {
          providerModelsApiCache.set(provKey, { timestamp: Date.now(), models: json.models });
          return json.models;
        }
      }
    } catch {
      // Poursuivre vers les fallbacks
    }
  } else if (provKey === 'nim' || provKey.includes('nvidia')) {
    try {
      const res = await apiFetch('https://integrate.api.nvidia.com/v1/models', { timeoutMs: 4000 });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.data)) {
          providerModelsApiCache.set(provKey, { timestamp: Date.now(), models: json.data });
          return json.data;
        }
      }
    } catch {
      // Poursuivre vers les fallbacks
    }
  }

  // 2. Interrogation via l'endpoint serveur Hermes local /api/models?provider=X
  try {
    const pData = await getProviderModels(provider);
    if (pData && Array.isArray(pData.models) && pData.models.length > 0) {
      providerModelsApiCache.set(provKey, { timestamp: Date.now(), models: pData.models });
      return pData.models;
    }
  } catch (e) {
    console.warn(`[ModelSpecs] Échec getProviderModels(${provider}):`, e);
  }

  // 3. Fallback sur le catalogue global Hermes /api/models
  try {
    const cat = await getModelCatalog();
    if (cat && cat.providers) {
      const provEntry = cat.providers[provider] || cat.providers[provKey] || cat.providers[provKey.toUpperCase()];
      if (provEntry && Array.isArray(provEntry.models) && provEntry.models.length > 0) {
        providerModelsApiCache.set(provKey, { timestamp: Date.now(), models: provEntry.models });
        return provEntry.models;
      }
    }
  } catch (e) {
    console.warn('[ModelSpecs] Échec fallback getModelCatalog():', e);
  }

  // 4. Fallback sur /v1/models de la passerelle Hermes
  try {
    const v1Res = await apiFetch('/v1/models', { timeoutMs: 3000 });
    if (v1Res.ok) {
      const json = await v1Res.json();
      const list = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
      if (list.length > 0) {
        providerModelsApiCache.set(provKey, { timestamp: Date.now(), models: list });
        return list;
      }
    }
  } catch (e) {
    console.warn('[ModelSpecs] Échec fallback /v1/models:', e);
  }

  return results;
}

/**
 * Extraction profonde (Deep Parsing) des métadonnées techniques depuis l'objet JSON retourné par l'API.
 * Extrait : context_length, architecture, pricing, modalities.
 */
function extractModelSpecsFromJson(raw: any, modelId: string, providerName?: string): ModelDeepSpecs {
  if (!raw || typeof raw !== 'object') {
    return {
      error: 'Objet JSON vide ou invalide',
      specs_display: 'Ctx: Non renseigné | API: Aucune métadonnée',
    };
  }

  // 1. Taille maximale de contexte (context_length)
  const rawCtx = raw.context_length ??
                 raw.context_window ??
                 raw.max_context_length ??
                 raw.max_tokens ??
                 raw.top_provider?.context_length ??
                 raw.top_provider?.max_completion_tokens ??
                 raw.model_info?.['llama.context_length'] ??
                 raw.model_info?.['general.context_length'] ??
                 raw.model_info?.['qwen2.context_length'] ??
                 raw.model_info?.['mistral.context_length'];

  let context_length: number | null = null;
  if (typeof rawCtx === 'number' && !isNaN(rawCtx) && rawCtx > 0) {
    context_length = rawCtx;
  } else if (typeof rawCtx === 'string' && !isNaN(Number(rawCtx)) && Number(rawCtx) > 0) {
    context_length = Number(rawCtx);
  }

  let ctxStr: string | null = null;
  if (context_length !== null) {
    ctxStr = formatContextLength(context_length);
  }

  // 2. Architecture du modèle (ex: Llama, Mixtral, MoE, Qwen)
  let archStr: string | null = null;
  if (typeof raw.architecture === 'string' && raw.architecture.trim() && !raw.architecture.includes('->')) {
    archStr = raw.architecture.trim();
  } else if (raw.architecture && typeof raw.architecture === 'object') {
    archStr = raw.architecture.instruct_type ||
              raw.architecture.tokenizer ||
              raw.architecture.family ||
              raw.architecture.architecture ||
              null;
  }

  if (!archStr && raw.details && typeof raw.details === 'object') {
    const fam = raw.details.family || (Array.isArray(raw.details.families) ? raw.details.families.join(', ') : null);
    if (fam) {
      archStr = fam;
      if (raw.details.format) {
        archStr += ` (${String(raw.details.format).toUpperCase()})`;
      }
    }
  }

  if (!archStr && raw.model_info && typeof raw.model_info === 'object') {
    const genArch = raw.model_info['general.architecture'] || raw.model_info['general.base_model.name'];
    if (genArch) {
      archStr = String(genArch);
    }
  }

  // Formatage propre de l'architecture si trouvée
  if (archStr) {
    if (/^moe$/i.test(archStr) || /mixture[ -_]of[ -_]experts/i.test(archStr)) {
      archStr = 'MoE';
    } else if (/^llama/i.test(archStr)) {
      archStr = archStr.replace(/^llama/i, 'Llama');
    } else if (/^mistral/i.test(archStr)) {
      archStr = archStr.replace(/^mistral/i, 'Mistral');
    } else if (/^mixtral/i.test(archStr)) {
      archStr = archStr.replace(/^mixtral/i, 'Mixtral');
    } else if (/^qwen/i.test(archStr)) {
      archStr = archStr.replace(/^qwen/i, 'Qwen');
    } else if (/^gemma/i.test(archStr)) {
      archStr = archStr.replace(/^gemma/i, 'Gemma');
    }
  }

  // 3. Tarification / Coût par token (Pricing)
  let costStr: string | null = null;
  let pricingObj: ModelDeepSpecs['pricing'] = null;

  if (raw.pricing && typeof raw.pricing === 'object') {
    const promptVal = raw.pricing.prompt ?? raw.pricing.input;
    const compVal = raw.pricing.completion ?? raw.pricing.output;

    const promptNum = promptVal !== undefined && promptVal !== null ? parseFloat(String(promptVal)) : NaN;
    const compNum = compVal !== undefined && compVal !== null ? parseFloat(String(compVal)) : NaN;

    if (promptNum === 0 && compNum === 0) {
      costStr = 'Gratuit';
      pricingObj = { prompt: 0, completion: 0, display: 'Gratuit' };
    } else if (!isNaN(promptNum) || !isNaN(compNum)) {
      const p1m = !isNaN(promptNum) ? promptNum * 1_000_000 : 0;
      const c1m = !isNaN(compNum) ? compNum * 1_000_000 : 0;

      const fmtCost = (val: number) => {
        if (val === 0) return '$0';
        if (val < 0.01) return `$${val.toFixed(3)}`;
        return `$${val.toFixed(2)}`;
      };

      costStr = `${fmtCost(p1m)}/1M in - ${fmtCost(c1m)}/1M out`;
      pricingObj = {
        prompt: promptVal,
        completion: compVal,
        display: costStr,
      };
    }
  }

  // 4. Modalités (Text, Vision, Tools, Audio)
  let modalityStr: string | null = null;
  const rawMod = raw.architecture?.modality || raw.modality;
  if (typeof rawMod === 'string') {
    if (rawMod.includes('image') || rawMod.includes('vision')) {
      modalityStr = rawMod.includes('audio') ? 'Text+Vision+Audio' : 'Text+Vision';
    } else if (rawMod.includes('audio')) {
      modalityStr = 'Text+Audio';
    } else if (rawMod === 'text->text') {
      modalityStr = 'Text';
    } else {
      modalityStr = rawMod;
    }
  } else if (Array.isArray(raw.modalities) || Array.isArray(raw.input_modalities)) {
    const list = (raw.modalities || raw.input_modalities) as string[];
    const hasVision = list.some((m) => /image|vision|photo/i.test(m));
    const hasAudio = list.some((m) => /audio|voice|speech/i.test(m));
    if (hasVision && hasAudio) modalityStr = 'Text+Vision+Audio';
    else if (hasVision) modalityStr = 'Text+Vision';
    else if (hasAudio) modalityStr = 'Text+Audio';
    else modalityStr = 'Text';
  } else if (raw.vision_supported === true) {
    modalityStr = 'Text+Vision';
  }

  // Construction de la ligne technique formatée
  const parts: string[] = [];
  if (ctxStr) parts.push(`Ctx: ${ctxStr}`);
  if (archStr) parts.push(`Arch: ${archStr}`);
  if (costStr) parts.push(`Coût: ${costStr}`);
  if (modalityStr) parts.push(`Modalités: ${modalityStr}`);

  const specs_display = parts.length > 0
    ? parts.join(' | ')
    : 'Ctx: Non renseigné | API: Aucune métadonnée';

  return {
    context_length,
    architecture: archStr,
    pricing: pricingObj,
    modalities: modalityStr,
    description: raw.description || null,
    raw,
    specs_display,
    error: parts.length > 0 ? null : 'Métadonnées non détaillées par l\'API',
  };
}

/**
 * Interroge l'endpoint des métadonnées du provider ET le registre local Hermes Agent
 * pour récupérer et formater les métadonnées techniques avec fallback sur la source locale Hermes.
 */
export async function getModelSpecs(provider: string, modelId: string): Promise<ModelDeepSpecs> {
  const provClean = (provider || '').trim();
  const idClean = (modelId || '').trim();

  if (!provClean || !idClean) {
    return {
      error: 'Provider ou ID manquant',
      specs_display: 'Ctx: Non renseigné | API: Paramètres manquants',
    };
  }

  try {
    // 1. Si Ollama et requête spécifique, possibilité d'interroger directement /api/show pour extraire model_info complet
    if (provClean.toLowerCase().includes('ollama')) {
      try {
        const showRes = await apiFetch('http://localhost:11434/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: idClean }),
          timeoutMs: 3000,
        });
        if (showRes.ok) {
          const showJson = await showRes.json();
          const specs = extractModelSpecsFromJson(showJson, idClean, provClean);
          if (specs.context_length || specs.architecture) {
            return specs;
          }
        }
      } catch {
        // Poursuivre vers les fallbacks
      }
    }

    // 2. Récupération de la liste complète des modèles depuis l'API du provider ou gateway locale
    const rawList = await fetchProviderRawModels(provClean);
    if (Array.isArray(rawList) && rawList.length > 0) {
      const match = rawList.find((m: any) => {
        if (!m) return false;
        const mid = m.id || m.name || m.model;
        if (!mid) return false;
        return mid === idClean ||
               mid === idClean.toLowerCase() ||
               idClean.endsWith(`/${mid}`) ||
               mid.endsWith(`/${idClean}`) ||
               idClean.replace(/:(free|beta)$/i, '') === mid.replace(/:(free|beta)$/i, '');
      });

      if (match) {
        const parsed = extractModelSpecsFromJson(match, idClean, provClean);
        if (parsed.context_length !== null) {
          return parsed;
        }
      }
    }

    // 3. FALLBACK SUR LE REGISTRE INTERNE HERMES AGENT
    // Spécifiquement pour NOUS, OMNI-ROUTE, ou tout modèle non renseigné par l'API externe
    const hermesFallback = getHermesRegistryModel(provClean, idClean);
    if (hermesFallback && hermesFallback.context_length !== null) {
      return hermesFallback;
    }

    // 4. Fallback sur les données d'état Hermes /api/state
    try {
      const st = await getState();
      if (st && Array.isArray(st.models)) {
        const found = st.models.find((m) => {
          const mId = m.id || m.label || (m as any).name;
          return mId === idClean || idClean.endsWith(`/${mId}`) || (mId && mId.endsWith(`/${idClean}`));
        });
        if (found) {
          const ctx = (found as any).context_length ?? (found as any).context_window ?? (found as any).max_tokens;
          if (typeof ctx === 'number' && ctx > 0) {
            const ctxFormatted = formatContextLength(ctx);
            const provDisplay = (provClean || 'HERMES').toUpperCase();
            return {
              context_length: ctx,
              architecture: null,
              pricing: null,
              modalities: null,
              raw: found as any,
              specs_display: `Ctx: ${ctxFormatted} | Source: Hermes Local / ${provDisplay}`,
              error: null,
            };
          }
        }
      }
    } catch {
      // Ignorer
    }

    // 5. Si aucun élément trouvé dans la liste brute, log explicite dans la console
    console.warn(`[ModelSpecs] Aucune métadonnée JSON API pour le modèle "${idClean}" (provider: "${provClean}")`, {
      provider: provClean,
      modelId: idClean,
      totalModelsInApi: rawList.length,
    });

    return {
      error: 'Modèle introuvable dans le flux API du provider',
      specs_display: 'Ctx: Non renseigné | API: Aucune métadonnée',
    };
  } catch (e) {
    // En cas d'erreur de communication réseau, tenter le fallback registre Hermes avant d'échouer
    const hermesFallback = getHermesRegistryModel(provClean, idClean);
    if (hermesFallback && hermesFallback.context_length !== null) {
      return hermesFallback;
    }

    console.error(`[ModelSpecs] Erreur lors de la récupération des specs de ${provClean}::${idClean}:`, e);
    return {
      error: e instanceof Error ? e.message : String(e),
      specs_display: 'Ctx: Non renseigné | API: Erreur de communication',
    };
  }
}

/** Response of GET /api/scan?provider=X&limit=N (req #7, legacy sync). */
export interface ScanResponse {
  provider: string;
  configured: boolean;           // false = provider non configure (pas de cle/URL)
  freeform?: boolean;
  scanned_total?: number;        // nombre total de modeles dispo
  scanned?: number;              // nombre reellement testes (limite appliquee)
  models: ScanModelResult[];
  error?: string;
}

/** Live scan state returned by GET /api/scan/status?scan_id=X (v2 async). */
export interface ScanStatus {
  scan_id: string;
  provider: string;
  freeform?: boolean;
  total: number;                 // nombre de modeles a tester
  done: number;                  // nombre deja testes
  status: 'running' | 'cancelling' | 'done' | 'cancelled' | 'error';
  configured: boolean;
  error?: string | null;
  results: ScanModelResult[];    // resultats partiels (verts d'abord)
}

/** Acknowledgement returned by POST /api/scan (v2 async start). */
export interface ScanStart {
  scan_id: string;
  provider: string;
  total: number;
  status: 'running';
}

/** Start an async scan of explicit model_ids for a provider (v2 UI). */
export async function startScan(
  provider: string,
  models: string[],
): Promise<ScanStart> {
  const qs = `/api/scan?provider=${encodeURIComponent(provider)}`
    + `&models=${encodeURIComponent(models.join(','))}`;
  return fetchJson<ScanStart>(qs);
}

/** Poll the live progress + partial results of a running scan. */
export async function getScanStatus(scanId: string): Promise<ScanStatus> {
  return fetchJson<ScanStatus>(
    `/api/scan/status?scan_id=${encodeURIComponent(scanId)}`,
  );
}

// Authoritative list of scans still running on the backend. Used on tab
// (re)mount so the UI can resume polling a scan that is still in flight even
// if the frontend store / localStorage is inconsistent.
export async function getActiveScans(): Promise<{ scans: Array<{ scan_id: string; provider: string; status: string; total: number; done: number }> }> {
  return fetchJson<{ scans: Array<{ scan_id: string; provider: string; status: string; total: number; done: number }> }>(
    '/api/scan/active',
  );
}

/** Request cancellation of a running scan (Stop button). */
export async function cancelScan(scanId: string): Promise<{ ok: boolean; status: string }> {
  return fetchJson<{ ok: boolean; status: string }>(
    `/api/scan/cancel?scan_id=${encodeURIComponent(scanId)}`,
  );
}

export async function cancelAllScans(): Promise<{ ok: boolean; cancelled: number }> {
  return fetchJson<{ ok: boolean; cancelled: number }>('/api/scan/cancel-all', {
    method: 'POST',
  });
}

/** Response of GET /api/scan/results (DEMANDE 1: persisted scan results). */
export interface ScanResultsResponse {
  provider: string | null;
  results: ScanModelResult[];
}

/** Read persisted scan results from the server-side scan_results.db.
 *  Used at mount to restore prior scans into the frontend store (byKey). */
export async function getScanResults(provider?: string): Promise<ScanResultsResponse> {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  return fetchJson<ScanResultsResponse>(`/api/scan/results${qs}`);
}

/** POINT 3b (2026-08-01): efface les resultats persistes cote serveur.
 *  Sans argument -> toute la table. Avec provider (+ model) -> ciblé.
 *  Indispensable maintenant que l'onglet SCAN restaure TOUJOURS depuis la DB :
 *  sans ce clear serveur, "Effacer les resultats" serait annulé au remontage. */
export async function clearScanResults(
  provider?: string,
  model?: string,
): Promise<{ ok: boolean; deleted: number }> {
  return fetchJson<{ ok: boolean; deleted: number }>('/api/scan/results/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: provider ?? '', model: model ?? '' }),
  });
}

// ---------------------------------------------------------------------------
// Messages tab — real Hermes agent conversation API (backend already present).
// ---------------------------------------------------------------------------

/** A single message in a conversation session. */
export interface MessageItem {
  role: 'user' | 'agent';
  text: string;
  ts: number;          // epoch seconds
  error?: string | null;
  // Optional attachments: absolute file paths (backend may include these).
  attachments?: string[];
}

/** A live (in-progress) agent response being streamed from the server. */
export interface MessageLive {
  running: boolean;
  text: string;
  error?: string | null;
}

/** A conversation session for an agent. */
export interface MessageSession {
  id: string;
  title: string;
  created_at: number;  // epoch seconds
  updated_at: number;  // epoch seconds
  message_count: number;
  messages: MessageItem[];
  live?: MessageLive;
  // POINT 2c (2026-08-01): provider/modele du profil de l'agent, attaches par
  // le backend (/api/messages/sessions) pour affichage sous les bulles agent.
  provider?: string;
  model?: string;
  // Source d'origine de la session (state.db natif): 'cron' | 'mc' | 'telegram'
  // | 'tui' | 'discord' | 'web' | 'cli' | 'api' | ... ; vide si inconnu.
  source?: string;
}

/** Response of GET /api/messages/sessions?agent=X */
export interface MessageSessions {
  agent: string;
  sessions: MessageSession[];
}

/** Response of POST /api/messages/send */
export interface SendMessageResult {
  ok: boolean;
  agent: string;
  session_id: string;
}

/** Response of POST /api/messages/resolve-native (FIX 2026-08-22).
 *  Resout le mc_sid (msg_…) renvoye par /api/messages/send en l'id natif
 *  (20260822_…) de la session creee par le worker. */
export interface ResolveNativeResult {
  agent: string;
  mc_sid: string;
  native_session_id: string | null;
}

/** FIX 2026-08-22 : resout le mc_sid en id natif de session pour ouvrir
 *  EXACTEMENT la session creee (evite le residu = session du haut de liste). */
export async function resolveNativeSession(
  agent: string,
  mcSid: string,
): Promise<ResolveNativeResult> {
  return fetchJson<ResolveNativeResult>('/api/messages/resolve-native', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, mc_sid: mcSid }),
  });
}

/** Response of GET /api/messages/status?agent=X&session_id=Y */
export interface MessageStatus {
  agent: string;
  session_id: string;
  running: boolean;
  text: string;
  error: string | null;
  /** Phase de finalisation (piloubruce 2026-07-26) : 'finalizing' quand le
   *  modele a fini de generer mais que des sous-process (outils terminal)
   *  tournent encore cote serveur. La coche verte n'apparait qu'a la fin. */
  phase?: string | null;
}

/** Response of DELETE /api/messages/delete */
export interface DeleteMessagesResult {
  ok: boolean;
  removed: number;
}

/** Response of POST /api/messages/upload */
export interface UploadMessageFileResult {
  ok: boolean;
  path: string;       // absolute path on disk
  name: string;
  size: number;
}

/** List an agent's conversation sessions. Empty sessions array if none. */
export async function getMessageSessions(agent: string): Promise<MessageSessions> {
  return fetchJson<MessageSessions>(
    `/api/messages/sessions?agent=${encodeURIComponent(agent)}`,
  );
}

/**
 * Send a message to an agent. Launches the response in the background server-
 * side and returns immediately with the session id. If sessionId is omitted a
 * new session is created. files = absolute paths returned by uploadMessageFile.
 */
export async function sendMessage(
  agent: string,
  sessionId: string | null | undefined,
  text: string,
  files?: string[],
  persist: boolean = true,
): Promise<SendMessageResult> {
  return fetchJson<SendMessageResult>('/api/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent,
      // PILU (2026-08-17) : on transmet le session_id ouvert pour CONTINUER
      // la conversation (--resume cote Hermes) au lieu de creer une nouvelle
      // session a chaque message. Le backend gere deja ce cas (voir
      // /api/messages/send : _provided = data.get("session_id")).
      session_id: sessionId ?? null,
      text,
      files: files ?? [],
      persist,
    }),
  });
}

/**
 * Poll the live status of an agent's response for a session. While running=true
 * the text is the partial streamed reply; once running=false text is COMPLETE
 * (never truncated). Re-querying after navigating away returns the full text.
 */
export async function getMessageStatus(
  agent: string,
  sessionId: string,
): Promise<MessageStatus> {
  return fetchJson<MessageStatus>(
    `/api/messages/status?agent=${encodeURIComponent(agent)}` +
    `&session_id=${encodeURIComponent(sessionId)}`,
  );
}

/**
 * Real-time chat token streaming over SSE (2026-07-30, DEVELOPPEUR).
 * Subscribes to GET /api/chat/stream?agent=&session_id= and invokes callbacks
 * as tokens arrive (no 1.5s poll delay). Replaces startPolling in MessagesTab.
 *
 *   subscribeChatStream('developpeur', 'sid_123', {
 *     onToken: (text) => ...,   // incremental chunk (NOT cumulative)
 *     onDone:  (error) => ...,  // stream finished (error: string|null)
 *   })
 *
 * Returns the EventSource so the caller can close() it (e.g. on unmount or
 * when switching session). Supports a fallback: if EventSource is unavailable
 * we leave onToken/onDone uncalled and the caller keeps its polling fallback.
 */
export interface ChatStreamHandlers {
  onToken?: (chunk: string) => void;
  onDone?: (error: string | null) => void;
  onError?: (err: Event) => void;
}

export function subscribeChatStream(
  agent: string,
  sessionId: string,
  handlers: ChatStreamHandlers,
): EventSource | null {
  if (typeof EventSource === 'undefined') {
    // No SSE support (very old browser) -> caller falls back to polling.
    return null;
  }
  const url =
    `/api/chat/stream?agent=${encodeURIComponent(agent)}` +
    `&session_id=${encodeURIComponent(sessionId)}`;
  const es = new EventSource(url);
  es.addEventListener('token', (ev: MessageEvent) => {
    handlers.onToken?.(ev.data ?? '');
  });
  es.addEventListener('done', (ev: MessageEvent) => {
    let err: string | null = null;
    try {
      const parsed = JSON.parse(ev.data || '{}');
      err = parsed.error ?? null;
    } catch {
      err = null;
    }
    handlers.onDone?.(err);
    es.close();
  });
  es.addEventListener('ping', () => {
    /* keepalive — nothing to do */
  });
  es.onerror = (ev: Event) => {
    // onerror also fires on normal close; only surface unexpected ones.
    handlers.onError?.(ev);
    try { es.close(); } catch { /* ignore */ }
  };
  return es;
}

/**
 * Delete sessions for an agent. Pass ids=[] or ['__all__'] to delete ALL of the
 * agent's sessions.
 */
export async function deleteMessageSessions(
  agent: string,
  ids: string[],
): Promise<DeleteMessagesResult> {
  return fetchJson<DeleteMessagesResult>('/api/messages/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, session_ids: ids }),
  });
}

/**
 * Delete ONE message inside a session (index in session.messages[]).
 * Changes the conversation history read back by --resume.
 */
export async function deleteMessage(
  agent: string,
  sessionId: string,
  messageIndex: number,
): Promise<{ ok: boolean; removed?: boolean }> {
  return fetchJson('/api/messages/message/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, session_id: sessionId, message_index: messageIndex }),
  });
}

/** Rewrite the text of a user message in place. */
export async function editMessage(
  agent: string,
  sessionId: string,
  messageIndex: number,
  text: string,
  files?: string[],
): Promise<{ ok: boolean; edited?: boolean }> {
  return fetchJson('/api/messages/message/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent,
      session_id: sessionId,
      message_index: messageIndex,
      text,
      ...(files ? { files } : {}),
    }),
  });
}

/** Remove one attachment path from a message. */
export async function deleteAttachment(
  agent: string,
  sessionId: string,
  messageIndex: number,
  attachmentPath: string,
): Promise<{ ok: boolean; removed?: boolean }> {
  return fetchJson('/api/messages/attachment/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent,
      session_id: sessionId,
      message_index: messageIndex,
      attachment_path: attachmentPath,
    }),
  });
}

/**
 * Upload a file (base64) to the server's uploads/ dir. Returns the absolute
 * path to pass in the files:[] array of sendMessage.
 */
export async function uploadMessageFile(
  name: string,
  file: string, // base64 (no data: prefix)
): Promise<UploadMessageFileResult> {
  return fetchJson<UploadMessageFileResult>('/api/messages/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, file }),
  });
}

/**
 * useApiState — fetches /api/state immediately, then subscribes to the SSE
 * /events stream (event: state) for live 3s updates. Falls back to polling
 * the REST endpoint if EventSource is unavailable.
 *
 * Returns the latest snapshot (or null while loading) and a connection flag.
 */
// ---------------------------------------------------------------------------
// Live SSE channel for /api/state (audit 2026-08-07 : utilise le singleton
// partage lib/sse.ts au lieu d'ouvrir SA PROPRE EventSource par composant).

export function useApiState(): {
  state: ApiState | null;
  connected: boolean;
  error: string | null;
  sseDown: boolean;
  refresh: () => void;
} {
  const [state, setState] = React.useState<ApiState | null>(null);
  const [connected, setConnected] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sseDown, setSseDown] = React.useState<boolean>(false);

  const refresh = React.useCallback(() => {
    getState()
      .then((snap) => { setState(snap); setConnected(true); setError(null); })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); });
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const apply = (snap: ApiState) => {
      if (!cancelled) {
        setState(snap);
        setConnected(true);
        setError(null);
      }
    };
    const fail = (e: unknown) => {
      // REST fetch genuinely failed (e.g. 401/network). Surface as error.
      if (!cancelled) {
        setError(e instanceof Error ? e.message : String(e));
        setConnected(false);
      }
    };

    // Initial REST fetch (immediate paint).
    getState().then(apply).catch(fail);

    // Fallback REST polling — active UNIQUEMENT quand le SSE est en panne.
    // Redondance entre plusieurs onglets montes : bornee (rare) et auto-stop
    // des que le flux partage revient (onOpen).
    const startPoll = () => {
      if (pollTimer === null && !cancelled) {
        pollTimer = setInterval(() => {
          getState().then(apply).catch(fail);
        }, 3000);
      }
    };
    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const onState = (ev: MessageEvent) => {
      try {
        apply(JSON.parse(ev.data) as ApiState);
      } catch (e) {
        fail(e);
      }
    };
    const onOpen = () => {
      if (!cancelled) setSseDown(false);
      stopPoll();
    };
    const onError = () => {
      if (!cancelled) setSseDown(true);
      startPoll();
    };

    // Une SEULE connexion /events pour toute l'app (lib/sse.ts).
    const unsubState = subscribeSse('state', onState);
    const unsubOpen = subscribeSseOpen(onOpen);
    const unsubError = subscribeSseError(onError);

    return () => {
      cancelled = true;
      stopPoll();
      unsubState();
      unsubOpen();
      unsubError();
    };
  }, []);

  return { state, connected, error, sseDown, refresh };
}



// ---------------------------------------------------------------------------
// NEW FEATURES (2026-08-05)
// ---------------------------------------------------------------------------

// Feature 1: Cron execution logs
export interface ExecutionLog {
  id: string;
  job_id: string;
  source?: string | null;
  status: string;
  timestamp: string | null;
  duration: number | null;
  error: string | null;
  returncode: number;
}

export interface CronLogsResponse {
  ok: boolean;
  executions?: ExecutionLog[];
  error?: string;
}

export async function getCronExecutionLogs(jobId: string, limit?: number): Promise<CronLogsResponse> {
  const url = `/api/cron/${jobId}/logs${limit ? `?limit=${limit}` : ''}`;
  return fetchJson<CronLogsResponse>(url);
}

export async function getCronAllLogs(limit?: number): Promise<CronLogsResponse> {
  const url = `/api/cron/logs${limit ? `?limit=${limit}` : ''}`;
  return fetchJson<CronLogsResponse>(url);
}

// Feature 4: Notifications
export interface Notification {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  ts: number;
  agent?: string | null;
}

export interface NotificationsResponse {
  ok: boolean;
  notifications?: Notification[];
}

export async function getNotifications(clear: boolean = false): Promise<NotificationsResponse> {
  const url = `/api/notifications${clear ? '?clear=1' : ''}`;
  return fetchJson<NotificationsResponse>(url);
}

export async function addNotification(
  type: 'success' | 'error' | 'warning' | 'info',
  title: string,
  message: string,
  agent?: string
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>('/api/notifications/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, title, message, agent }),
  });
}

export async function clearNotifications(
  ids?: string[] | null
): Promise<{ ok: boolean; remaining?: number }> {
  return fetchJson<{ ok: boolean; remaining?: number }>('/api/notifications/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ids ?? null }),
  });
}

// ---------------------------------------------------------------------------
// Feature 7 : SCORING DES MODELES (enrichi v1.17.62)
// ---------------------------------------------------------------------------
// PONDERATION (total = 100 points pour un modele OK) :
//   - Disponibilite (ok)        : 40 pts  (socle, acquis des que le probe repond)
//   - Latence                   : 30 pts  (0 ms -> 30 pts ; >= 10 000 ms -> 0 pt, lineaire)
//   - Debit (tokens/sec)        : 15 pts  (0 tok/s -> 0 pt ; >= 60 tok/s -> 15 pts, lineaire)
//   - Capacites prouvees        : 15 pts  (vision / reasoning / tools)
//                                 -> 5 pts par capacite TESTEE ET VRAIE
//   TOTAL                       : 100 pts
//
// NEUTRALISATION DU BIAIS "NON TESTE" :
//   Une composante qui n'a jamais ete mesuree ne doit ni rapporter ni penaliser.
//   On applique donc une NORMALISATION SUR LE POIDS REELLEMENT MESURE :
//     score = 100 * (points obtenus) / (somme des poids des composantes mesurees)
//   Exemples :
//     * modele OK, latence connue, pas de tok/s, aucune capacite testee
//       -> poids mesure = 40 + 30 = 70, un modele parfait sur ces deux axes
//          obtient donc bien 100/100 et n'est pas puni pour l'absence du reste.
//     * capacites : on ne compte dans le denominateur QUE les capacites dont le
//       booleen est defini (true OU false). Un `undefined` (jamais sonde) est
//       totalement ignore ; un `false` (teste, non supporte) compte 0/5 - c'est
//       une information reelle, pas une absence d'information.
//
// MODELE KO : le score est calcule sur une echelle plafonnee a 25/100 (donc
// lettre D, ou C au mieux jamais atteint), quelle que soit sa latence ou ses
// capacites. Un modele qui ne repond pas ne peut pas etre bien note.
//   - base KO         : 15 pts
//   - malus par type d'erreur : timeout/500 -8, quota/rate limit -5, 401 -3
//   -> plage finale KO : 7 a 15 / 100.

/** Poids de chaque composante du score (documentation executable). */
export const SCORE_WEIGHTS = {
  availability: 40,
  latency: 30,
  throughput: 15,
  capabilities: 15, // 5 pts x 3 capacites
} as const;

/** Bornes de normalisation des mesures continues. */
export const SCORE_BOUNDS = {
  latency_best_ms: 0,      // <= : 100% des points latence
  latency_worst_ms: 10000, // >= : 0% des points latence
  tps_best: 60,            // >= : 100% des points debit
} as const;

export interface ModelScore {
  ok: boolean;
  score: number;
  score_letter: string;
  latency_ms: number | null;
  error: string | null;
  /** Detail lisible (tooltip) : ce qui a ete pris en compte et ce qui a ete ignore. */
  detail: string;
  /** Somme des poids reellement mesures (denominateur de la normalisation). */
  measured_weight: number;
}

export interface ScoreInputs {
  latency_ms?: number | null;
  ok?: boolean;
  error?: string | null;
  tokens_per_sec?: number | null;
  vision_supported?: boolean;
  reasoning_supported?: boolean;
  tools_supported?: boolean;
}

/**
 * SOURCE UNIQUE DE VERITE (2026-08-06) : un modele est "non mesure" quand la
 * base ne contient AUCUNE mesure de test de vie pour lui (aucun scan, ou ligne
 * remise a plat par scripts/repair_cap_clobber.py -> reason='a rescanner').
 * Dans ce cas l'onglet SCAN **et** la modale ModelSelector doivent afficher
 * '—' : jamais un score, qui serait indistinguable d'un modele KO (<=25).
 */
export function isUnmeasured(r?: {
  reason?: string | null;
  latency_ms?: number | null;
  last_checked?: number | null;
} | null): boolean {
  if (!r) return true;
  if (r.reason === 'a rescanner') return true;
  return (r.latency_ms === undefined || r.latency_ms === null)
    && (r.last_checked === undefined || r.last_checked === null);
}

function letterFor(score: number): string {
  return score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
}

/**
 * Calcule le score 0-100 d'un modele.
 * Compatible avec l'ancienne signature positionnelle
 * `calculateModelScore(latency, ok, error)` ; passer un objet `ScoreInputs`
 * pour beneficier du debit et des capacites.
 */
export function calculateModelScore(
  latencyOrInputs: number | null | ScoreInputs,
  ok: boolean = false,
  error: string | null = null,
): ModelScore {
  const inputs: ScoreInputs =
    latencyOrInputs !== null && typeof latencyOrInputs === 'object'
      ? latencyOrInputs
      : { latency_ms: latencyOrInputs as number | null, ok, error };

  const isOk = inputs.ok === true;
  const latency = typeof inputs.latency_ms === 'number' ? inputs.latency_ms : null;
  const tps = typeof inputs.tokens_per_sec === 'number' ? inputs.tokens_per_sec : null;
  const err = inputs.error ?? null;

  // ---------------- Modele KO : plafond dur a 25/100 ----------------
  if (!isOk) {
    let ko = 15;
    const e = (err ?? '').toLowerCase();
    if (e.includes('500') || e.includes('timeout')) ko -= 8;
    else if (e.includes('quota') || e.includes('rate limit')) ko -= 5;
    else if (e.includes('401') || e.includes('unauthorized')) ko -= 3;
    const score = Math.max(0, Math.min(25, ko));
    return {
      ok: false,
      score,
      score_letter: letterFor(score),
      latency_ms: latency,
      error: err,
      measured_weight: SCORE_WEIGHTS.availability,
      detail:
        `Score ${score}/100 (${letterFor(score)}) — modele KO (plafonne a 25).\n` +
        `Erreur: ${err || 'inconnue'}\n` +
        `Latence et capacites ne sont pas prises en compte pour un modele KO.`,
    };
  }

  // ---------------- Modele OK : somme ponderee normalisee ----------------
  let points = 0;
  let weight = 0;
  const lines: string[] = [];

  // 1) Disponibilite : toujours mesuree des lors qu'on a un resultat.
  points += SCORE_WEIGHTS.availability;
  weight += SCORE_WEIGHTS.availability;
  lines.push(`Disponibilite: OK (+${SCORE_WEIGHTS.availability}/${SCORE_WEIGHTS.availability})`);

  // 2) Latence (si mesuree).
  if (latency !== null) {
    const span = SCORE_BOUNDS.latency_worst_ms - SCORE_BOUNDS.latency_best_ms;
    const ratio = Math.max(0, Math.min(1, 1 - (latency - SCORE_BOUNDS.latency_best_ms) / span));
    const p = ratio * SCORE_WEIGHTS.latency;
    points += p;
    weight += SCORE_WEIGHTS.latency;
    lines.push(`Latence: ${latency.toFixed(0)} ms (+${p.toFixed(1)}/${SCORE_WEIGHTS.latency})`);
  } else {
    lines.push('Latence: non mesuree (ignoree, aucune penalite)');
  }

  // 3) Debit tokens/sec (si mesure).
  if (tps !== null) {
    const ratio = Math.max(0, Math.min(1, tps / SCORE_BOUNDS.tps_best));
    const p = ratio * SCORE_WEIGHTS.throughput;
    points += p;
    weight += SCORE_WEIGHTS.throughput;
    lines.push(`Debit: ${tps.toFixed(1)} tok/s (+${p.toFixed(1)}/${SCORE_WEIGHTS.throughput})`);
  } else {
    lines.push('Debit: non mesure (ignore, aucune penalite)');
  }

  // 4) Capacites : 5 pts chacune, et SEULES celles reellement testees
  //    (booleen defini) entrent au denominateur.
  const perCap = SCORE_WEIGHTS.capabilities / 3;
  const caps: Array<[string, boolean | undefined]> = [
    ['Vision', inputs.vision_supported],
    ['Raisonnement', inputs.reasoning_supported],
    ['Tools', inputs.tools_supported],
  ];
  const untested: string[] = [];
  for (const [label, val] of caps) {
    if (val === undefined) {
      untested.push(label);
      continue;
    }
    weight += perCap;
    if (val) {
      points += perCap;
      lines.push(`${label}: prouve (+${perCap.toFixed(1)}/${perCap.toFixed(1)})`);
    } else {
      lines.push(`${label}: teste, non supporte (+0/${perCap.toFixed(1)})`);
    }
  }
  if (untested.length) {
    lines.push(`Non teste (ignore, aucune penalite): ${untested.join(', ')}`);
  }

  const score = weight > 0 ? Math.max(0, Math.min(100, (points / weight) * 100)) : 0;
  const rounded = Math.round(score);

  return {
    ok: true,
    score: rounded,
    score_letter: letterFor(rounded),
    latency_ms: latency,
    error: null,
    measured_weight: weight,
    detail:
      `Score ${rounded}/100 (${letterFor(rounded)})\n` +
      lines.join('\n') +
      `\nNormalisation: ${points.toFixed(1)} pts obtenus / ${weight.toFixed(1)} pts mesurables x 100`,
  };
}
