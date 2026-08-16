/**
 * Client API pour les ajouts front #4 (Configuration) et #6 (Explorateur).
 *
 * Endpoints fournis par le backend (server.py, périmètre Bob) :
 *   GET  /api/config            -> { theme, shortcuts, ... }
 *   POST /api/config            -> body JSON
 *   GET  /api/files?path=       -> { entries: [...] }
 *   GET  /api/files/download?path=
 *   POST /api/files/upload      (multipart : path + file)
 *   POST /api/files/rename      { from, to }
 *   DELETE /api/files?path=
 *
 * Tolérance : tant que Bob n'a pas livré, /api/config renvoie le SPA (HTML).
 * On détecte le content-type et on retombe sur localStorage sans casser l'UI.
 */

import { apiFetch, getApiBase } from '../api';

// ------------------------------------------------------------------ #4
export interface McConfig {
  theme?: 'dark' | 'light';
  shortcuts?: Record<string, string>;
  [k: string]: unknown;
}

export const CONFIG_LS_KEY = 'mc_config';

export function readLocalConfig(): McConfig {
  try {
    const raw = localStorage.getItem(CONFIG_LS_KEY);
    if (raw) return JSON.parse(raw) as McConfig;
  } catch { /* ignore */ }
  return {};
}

function writeLocalConfig(cfg: McConfig): void {
  try { localStorage.setItem(CONFIG_LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

export type CfgSource = 'server' | 'local';

/** GET /api/config (fallback localStorage). */
export async function getConfig(): Promise<{ config: McConfig; source: CfgSource }> {
  try {
    const res = await apiFetch('/api/config', {
      headers: { Accept: 'application/json' },
    });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const cfg = (await res.json()) as McConfig;
      writeLocalConfig(cfg);
      return { config: cfg, source: 'server' };
    }
  } catch { /* backend indisponible */ }
  return { config: readLocalConfig(), source: 'local' };
}

/** POST /api/config. Le cache local est toujours écrit (fallback). */
export async function setConfig(
  cfg: McConfig,
): Promise<{ ok: boolean; source: CfgSource; error?: string }> {
  writeLocalConfig(cfg);
  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(cfg),
    });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) return { ok: true, source: 'server' };
    return { ok: false, source: 'local', error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, source: 'local', error: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ #6
export const FILES_ROOT = '/home/piloubruce';

export interface FileEntry {
  name: string;
  path: string;        // chemin relatif à la racine sandbox
  is_dir: boolean;
  size?: number;
  mtime?: number;
}

async function filesJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    headers: { Accept: 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error(`Endpoint indisponible (HTTP ${res.status}) — backend pas encore livré ?`);
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** Normalise les formes possibles renvoyées par le backend. */
function normalizeEntries(raw: unknown[]): FileEntry[] {
  return raw.map((e) => {
    const o = e as Record<string, unknown>;
    const name = String(o.name ?? o.filename ?? o.path ?? '');
    return {
      name,
      path: String(o.path ?? name),
      is_dir: Boolean(o.dir ?? o.is_dir ?? o.isDir ?? (o.type === 'dir')),
      size: typeof o.size === 'number' ? o.size : undefined,
      mtime: typeof o.mtime === 'number' ? o.mtime : undefined,
    };
  });
}

/** Liste un dossier (chemin relatif à /home/piloubruce ; '' = racine).
 *  Backend : GET /api/fs/list?path=&hidden=1 -> { ok, root, items:[{name,path,dir,size,mtime}] }
 *  show_hidden = true pour inclure les fichiers/dossiers cachés (commençant par '.').
 */
export async function listFiles(dir = '', show_hidden = false): Promise<FileEntry[]> {
  const hiddenParam = show_hidden ? 1 : 0;
  const r = await filesJson<{ items?: unknown[]; entries?: unknown[]; files?: unknown[] }>
    (`/api/fs/list?path=${encodeURIComponent(dir)}&hidden=${hiddenParam}`);
  return normalizeEntries(r.items ?? r.entries ?? r.files ?? []);
}

export function downloadFileUrl(path: string): string {
  const base = getApiBase();
  return `${base}/api/files/download?path=${encodeURIComponent(path)}`;
}

export function viewFileUrl(path: string): string {
  const base = getApiBase();
  return `${base}/api/files/download?inline=1&path=${encodeURIComponent(path)}`;
}

export async function uploadFile(dir: string, file: File): Promise<{ ok: boolean }> {
  const fd = new FormData();
  fd.append('path', dir);
  fd.append('file', file);
  return filesJson<{ ok: boolean }>('/api/files/upload', { method: 'POST', body: fd });
}

/** POST /api/files/rename { old, new } */
export async function renameFile(from: string, to: string): Promise<{ ok: boolean }> {
  return filesJson<{ ok: boolean }>('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old: from, new: to }),
  });
}

/** POST /api/files/mkdir { path } */
export async function makeDir(path: string): Promise<{ ok: boolean }> {
  return filesJson<{ ok: boolean }>('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

/** DELETE /api/files?path= (le backend accepte aussi POST /api/files/delete). */
export async function deleteFile(path: string): Promise<{ ok: boolean }> {
  return filesJson<{ ok: boolean }>(`/api/files?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
}

/** URL du WebSocket terminal (#5), dérivée de l'origine courante. */
export function terminalWsUrl(): string {
  const base = getApiBase();
  if (base) {
    const wsProto = base.startsWith('https:') ? 'wss:' : 'ws:';
    const host = base.replace(/^https?:\/\//, '');
    return `${wsProto}//${host}/ws/terminal`;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/terminal`;
}

// ------------------------------------------------------------------ #7 Backup/Restore
export async function createBackup(): Promise<{ ok: boolean; msg?: string; backup_name?: string; error?: string }> {
  try {
    const res = await apiFetch('/api/mc/backup/create', { method: 'POST' });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = await res.json();
      return { ok: true, msg: data.msg, backup_name: data.backup_name };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listBackups(): Promise<{ ok: boolean; backups?: Array<{name: string; size: number; mtime: number}>; error?: string }> {
  try {
    const res = await apiFetch('/api/mc/backup/list', { headers: { Accept: 'application/json' } });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = await res.json();
      return { ok: true, backups: data.backups };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function downloadBackupUrl(filename: string): string {
  const base = getApiBase();
  return `${base}/api/mc/backup/download/${encodeURIComponent(filename)}`;
}

export async function restoreBackup(file: string): Promise<{ ok: boolean; msg?: string; error?: string }> {
  try {
    const res = await apiFetch('/api/mc/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, confirm: true })
    });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = await res.json();
      return { ok: true, msg: data.msg };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
