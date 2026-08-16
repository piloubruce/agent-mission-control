import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApiState } from '../../api';
import { getContentPage, getContentFile, type ContentFile } from '../../api';
import { FileText, Folder, FolderOpen, Search, ArrowLeft, ChevronRight, ChevronDown, ExternalLink, Download } from 'lucide-react';
import { formatEpoch as formatDate } from '../../lib/datetime';

/* ---------- Arborescence ---------- */

type TreeNode = {
  name: string;
  path: string;              // chemin cumulé (clé d'ouverture)
  dirs: Map<string, TreeNode>;
  files: ContentFile[];
};

const newNode = (name: string, path: string): TreeNode => ({
  name,
  path,
  dirs: new Map(),
  files: [],
});

function buildTree(files: ContentFile[]): TreeNode {
  const root = newNode('', '');
  for (const f of files) {
    const segs = f.rel_path.split('/').filter(Boolean);
    const dirSegs = segs.slice(0, -1);
    let cur = root;
    let acc = '';
    for (const s of dirSegs) {
      acc = acc ? `${acc}/${s}` : s;
      let next = cur.dirs.get(s);
      if (!next) {
        next = newNode(s, acc);
        cur.dirs.set(s, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return root;
}

/** Filtre récursif: conserve un dossier s'il matche ou s'il contient un match. */
function filterTree(node: TreeNode, q: string): TreeNode | null {
  if (!q) return node;
  const out = newNode(node.name, node.path);
  const selfMatch = node.name.toLowerCase().includes(q);
  for (const [k, child] of node.dirs) {
    const kept = filterTree(child, q);
    if (kept) out.dirs.set(k, kept);
  }
  out.files = node.files.filter(
    (f) => (f.name + ' ' + f.rel_path).toLowerCase().includes(q),
  );
  if (out.dirs.size || out.files.length) return out;
  if (selfMatch) return { ...out, files: node.files };
  return null;
}

function countFiles(node: TreeNode): number {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}

function allDirPaths(node: TreeNode, acc: string[] = []): string[] {
  for (const d of node.dirs.values()) {
    acc.push(d.path);
    allDirPaths(d, acc);
  }
  return acc;
}

/* ---------- Composant ---------- */

export const ContentTab: React.FC = () => {
  const { connected } = useApiState();
  const [allFiles, setAllFiles] = useState<ContentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Selected file for reading.
  const [selected, setSelected] = useState<ContentFile | null>(null);
  const [fileText, setFileText] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);

  // Chargement global unique: toute la librairie d'un coup (pas de pagination).
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    // page=0 -> le backend bascule en mode legacy et renvoie TOUTE la librairie
    // (per_page=total, pages=1). Aucun changement backend/api.ts requis.
    getContentPage(0)
      .then((pg) => {
        setAllFiles(pg.files ?? []);
        setOpen({}); // sous-dossiers repliés, racine dépliée
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const openFile = useCallback(async (f: ContentFile) => {
    setSelected(f);
    setFileLoading(true);
    setFileText('');
    try {
      const r = await getContentFile(f.rel_path);
      setFileText(r.ok ? (r.text ?? '') : (r.error ?? 'Lecture impossible.'));
    } catch (e) {
      setFileText(e instanceof Error ? e.message : String(e));
    } finally {
      setFileLoading(false);
    }
  }, []);

  const files = allFiles;
  const q = query.trim().toLowerCase();

  const tree = useMemo(() => {
    const full = buildTree(files);
    return q ? filterTree(full, q) : full;
  }, [files, q]);

  // Auto-dépliage des branches contenant un match pendant une recherche.
  const forcedOpen = useMemo(
    () => (q && tree ? new Set(allDirPaths(tree)) : null),
    [q, tree],
  );

  const isOpen = (p: string) => (forcedOpen ? forcedOpen.has(p) : !!open[p]);
  const toggle = (p: string) =>
    setOpen((o) => ({ ...o, [p]: !o[p] }));

  const matchCount = tree ? countFiles(tree) : 0;

  const total = allFiles.length;

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => (
    <React.Fragment key={node.path || '__root__'}>
      {Array.from(node.dirs.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => {
          const opened = isOpen(d.path);
          return (
            <div key={d.path}>
              <button
                onClick={() => toggle(d.path)}
                className="w-full text-left p-2 rounded-xl transition-all flex items-center space-x-2 hover:bg-stone-800/50"
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                {opened
                  ? <ChevronDown className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                  : <ChevronRight className="w-3.5 h-3.5 text-stone-500 shrink-0" />}
                {opened
                  ? <FolderOpen className="w-4 h-4 text-orange-400/80 shrink-0" />
                  : <Folder className="w-4 h-4 text-stone-500 shrink-0" />}
                <span className="text-sm text-stone-300 truncate flex-1">{d.name}</span>
                <span className="text-[10px] text-stone-600 shrink-0">{countFiles(d)}</span>
              </button>
              {opened && renderNode(d, depth + 1)}
            </div>
          );
        })}

      {node.files
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => (
          <button
            key={f.rel_path}
            onClick={() => openFile(f)}
            className={`w-full text-left p-2 rounded-xl transition-all flex items-center space-x-2 ${
              selected?.rel_path === f.rel_path ? 'bg-stone-800 shadow-sm' : 'hover:bg-stone-800/50'
            }`}
            style={{ paddingLeft: 8 + depth * 14 + 18 }}
          >
            <FileText className="w-4 h-4 text-stone-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-stone-200 truncate">{f.name}</div>
              <div className="text-[10px] text-stone-600 truncate">{formatDate(f.mtime)}</div>
            </div>
          </button>
        ))}
    </React.Fragment>
  );

  return (
    <div className="flex h-[calc(100vh-140px)] space-x-6">
      <div className="w-1/3 flex flex-col space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-4xl font-serif text-stone-100">Bibliothèque.</h2>
          <div className="text-stone-500 text-sm">
            {loading ? 'Chargement…' : `${total} document${total > 1 ? 's' : ''}`}
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-stone-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrer..."
            className="w-full bg-stone-900 border border-stone-800 rounded-xl pl-10 pr-4 py-3 text-sm text-stone-200 focus:outline-none focus:border-orange-500 transition-colors placeholder:text-stone-600"
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
          {loading && <p className="text-stone-600 text-sm p-2">Chargement…</p>}
          {error && <p className="text-red-400 text-sm p-2">Erreur: {error}</p>}
          {!loading && !error && matchCount === 0 && (
            <div className="text-center text-stone-600 mt-10">
              <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">Aucun document.</p>
              {!connected && <p className="text-xs mt-1 text-stone-700">API indisponible.</p>}
            </div>
          )}
          {!loading && !error && tree && matchCount > 0 && renderNode(tree, 0)}
        </div>

      </div>

      <div className="w-2/3 bg-stone-900 border border-stone-800 rounded-3xl overflow-hidden flex flex-col">
        <div className="p-6 border-b border-stone-800 flex justify-between items-center bg-stone-950/50">
          <div className="flex items-center text-stone-400 text-sm min-w-0">
            {selected ? (
              <>
                <button onClick={() => setSelected(null)} className="hover:text-orange-400 transition-colors mr-2 shrink-0" title="Retour">
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <FileText className="w-4 h-4 mr-2 shrink-0" />
                <span className="font-mono text-xs truncate">{selected.rel_path}</span>
                <button
                  onClick={() => window.open('/api/content/file/' + encodeURIComponent(selected.rel_path), '_blank')}
                  title="Ouvrir dans le navigateur"
                  className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors shrink-0 ml-2"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
                <button
                  onClick={() => window.open('/api/content/download/' + encodeURIComponent(selected.rel_path), '_blank')}
                  title="Enregistrer le fichier"
                  className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors shrink-0"
                >
                  <Download className="w-4 h-4" />
                </button>
              </>
            ) : (
              <span>/content</span>
            )}
          </div>
          {selected && (
            <span className="text-xs text-stone-600 shrink-0 ml-3">{(selected.size / 1024).toFixed(1)} Ko</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {!selected && (
            <p className="text-stone-600 text-center mt-10">Sélectionnez un document à gauche pour le lire.</p>
          )}
          {selected && fileLoading && <p className="text-stone-500 text-sm">Lecture…</p>}
          {selected && !fileLoading && (
            <pre className="text-sm text-stone-300 whitespace-pre-wrap font-mono leading-relaxed">{fileText}</pre>
          )}
        </div>
      </div>
    </div>
  );
};
