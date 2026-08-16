/**
 * #6 — Onglet EXPLORATEUR DE FICHIERS (UI seulement).
 *
 * Consomme les endpoints backend, sandbox /home/piloubruce :
 *   GET    /api/files?path=            liste
 *   GET    /api/files/download?path=   téléchargement
 *   POST   /api/files/upload           (multipart path + file)
 *   POST   /api/files/rename           { from, to }
 *   DELETE /api/files?path=            suppression
 *
 * L'UI ne propose jamais de remonter au-dessus de la racine sandbox.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderTree, Folder, File as FileIcon, Upload, Download, Pencil,
  Trash2, RefreshCw, ChevronRight, Home, FolderPlus, Eye,
} from 'lucide-react';
import {
  listFiles, uploadFile, renameFile, deleteFile, makeDir, downloadFileUrl, viewFileUrl, FILES_ROOT,
} from '../../lib/mcApi';
import type { FileEntry } from '../../lib/mcApi';

function fmtSize(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} Mo`;
  return `${(n / 1073741824).toFixed(2)} Go`;
}

function fmtDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Join sûr : jamais de '..', jamais de chemin absolu. */
function joinPath(dir: string, name: string): string {
  const clean = name.replace(/^\/+/, '').replace(/\.\./g, '');
  return dir ? `${dir}/${clean}` : clean;
}

export const FilesTab: React.FC = () => {
  const [dir, setDir] = useState('');            // relatif à FILES_ROOT
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (d: string, showHiddenFiles = false) => {
    setBusy(true);
    setErr(null);
    try {
      const list = await listFiles(d, showHiddenFiles);
      list.sort((a, b) => (Number(b.is_dir) - Number(a.is_dir)) || a.name.localeCompare(b.name));
      setEntries(list);
      setDir(d);
    } catch (e) {
      setEntries([]);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load('', showHidden); }, [load, showHidden]);

  const crumbs = dir ? dir.split('/').filter(Boolean) : [];

  const onUpload = async (f: File | null | undefined) => {
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      await uploadFile(dir, f);
      setInfo(`Téléversé : ${f.name}`);
      await load(dir, showHidden);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const onRename = async (entry: FileEntry) => {
    const next = prompt(`Nouveau nom pour « ${entry.name} » :`, entry.name);
    if (!next || next === entry.name) return;
    setBusy(true);
    setErr(null);
    try {
      await renameFile(entry.path, joinPath(dir, next));
      setInfo(`Renommé : ${entry.name} → ${next}`);
      await load(dir, showHidden);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const onDelete = async (entry: FileEntry) => {
    if (!confirm(`Supprimer définitivement « ${entry.name} » ?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteFile(entry.path);
      setInfo(`Supprimé : ${entry.name}`);
      await load(dir, showHidden);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const onMkdir = async () => {
    const name = prompt('Nom du nouveau dossier :', 'nouveau-dossier');
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      await makeDir(joinPath(dir, name));
      setInfo(`Dossier créé : ${name}`);
      await load(dir, showHidden);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const btn = 'px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2';
  const iconBtn = 'p-1.5 rounded-md text-stone-500 hover:text-orange-500 hover:bg-stone-800 transition-colors';

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-serif text-stone-100 flex items-center gap-3">
            <FolderTree className="w-7 h-7 text-orange-500" /> Explorateur
          </h2>
          <p className="text-stone-500 mt-1">
            Racine : <code className="font-mono text-stone-400">{FILES_ROOT}</code>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Toggle fichiers cachés */}
          <label className="flex items-center gap-2 px-3 py-2 text-xs text-stone-400 bg-stone-800/50 rounded-md hover:bg-stone-800 cursor-pointer">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="accent-orange-500 w-4 h-4"
            />
            Fichiers cachés
          </label>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={(e) => void onUpload(e.target.files?.[0])}
          />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className={`${btn} bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-50`}
          >
            <Upload className="w-4 h-4" /> Téléverser
          </button>
          <button
            onClick={() => void onMkdir()}
            disabled={busy}
            className={`${btn} bg-stone-800 hover:bg-stone-700 text-stone-200 disabled:opacity-50`}
          >
            <FolderPlus className="w-4 h-4" /> Nouveau dossier
          </button>
          <button
            onClick={() => void load(dir, showHidden)}
            disabled={busy}
            className={`${btn} bg-stone-800 hover:bg-stone-700 text-stone-200 disabled:opacity-50`}
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Actualiser
          </button>
        </div>
      </div>

      {/* Fil d'Ariane — jamais au-dessus de la racine sandbox. */}
      <div className="flex items-center flex-wrap gap-1 text-sm text-stone-400">
        <button onClick={() => void load('', showHidden)} className="flex items-center gap-1 hover:text-orange-500">
          <Home className="w-4 h-4" /> piloubruce
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="w-3.5 h-3.5 text-stone-600" />
            <button
              onClick={() => void load(crumbs.slice(0, i + 1).join('/'), showHidden)}
              className="hover:text-orange-500"
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      {err && (
        <div className="text-sm text-amber-400 border border-amber-900/50 bg-amber-950/20 rounded-xl px-4 py-3">
          {err}
        </div>
      )}
      {info && !err && (
        <div className="text-sm text-emerald-400 border border-emerald-900/50 bg-emerald-950/20 rounded-xl px-4 py-3">
          {info}
        </div>
      )}

      <div className="bg-stone-900 border border-stone-800 rounded-3xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-stone-500 border-b border-stone-800">
              <th className="text-left font-medium px-5 py-3">Nom</th>
              <th className="text-right font-medium px-5 py-3 w-28">Taille</th>
              <th className="text-right font-medium px-5 py-3 w-40">Modifié</th>
              <th className="text-right font-medium px-5 py-3 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && !busy && (
              <tr><td colSpan={4} className="px-5 py-8 text-center text-stone-600">Dossier vide ou inaccessible.</td></tr>
            )}
            {entries.map((e) => (
              <tr key={e.path} className="border-b border-stone-800/60 last:border-0 hover:bg-stone-950/40">
                <td className="px-5 py-2.5">
                  {e.is_dir ? (
                    <button
                      onClick={() => void load(e.path, showHidden)}
                      className="flex items-center gap-2 text-stone-200 hover:text-orange-500"
                    >
                      <Folder className="w-4 h-4 text-orange-500/80 shrink-0" /> {e.name}
                    </button>
                  ) : (
                    <span className="flex items-center gap-2 text-stone-300">
                      <FileIcon className="w-4 h-4 text-stone-600 shrink-0" /> {e.name}
                    </span>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right text-stone-500 font-mono text-xs">
                  {e.is_dir ? '—' : fmtSize(e.size)}
                </td>
                <td className="px-5 py-2.5 text-right text-stone-500 font-mono text-xs">{fmtDate(e.mtime)}</td>
                <td className="px-5 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    {!e.is_dir && (
                      <>
                        {/* Bouton Ouvrir - ouvre le fichier inline dans un nouvel onglet */}
                        <a
                          href={viewFileUrl(e.path)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Ouvrir"
                          className="p-1.5 rounded-md text-stone-500 hover:text-orange-500 hover:bg-stone-800 transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </a>
                        {/* Bouton Télécharger - télécharge le fichier */}
                        <a href={downloadFileUrl(e.path)} download title="Télécharger" className={iconBtn}>
                          <Download className="w-4 h-4" />
                        </a>
                      </>
                    )}
                    <button onClick={() => void onRename(e)} title="Renommer" className={iconBtn}>
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => void onDelete(e)}
                      title="Supprimer"
                      className={`${iconBtn} hover:text-red-500`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};