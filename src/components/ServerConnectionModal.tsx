import React, { useState, useEffect } from 'react';
import { X, Server, CheckCircle2, AlertTriangle, RefreshCw, Globe, Terminal, ExternalLink } from 'lucide-react';
import { getApiBase, setApiBase, getState, Health } from '../api';
import { reconnectSse } from '../lib/sse';

interface ServerConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected?: () => void;
}

export const ServerConnectionModal: React.FC<ServerConnectionModalProps> = ({
  isOpen,
  onClose,
  onConnected,
}) => {
  const [url, setUrl] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    latency?: number;
    health?: Health;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setUrl(getApiBase());
      setTestResult(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const start = performance.now();
    try {
      // Sauvegarder temporairement pour tester
      const cleanUrl = url.trim().replace(/\/+$/, '');
      const testFetch = async () => {
        const target = (cleanUrl || window.location.origin) + '/api/state';
        const res = await fetch(target, {
          headers: { Accept: 'application/json' },
          credentials: cleanUrl ? 'include' : 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      };

      const data = await Promise.race([
        testFetch(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Délai dépassé (timeout 6s)')), 6000)),
      ]);

      const latency = Math.round(performance.now() - start);
      setTestResult({
        ok: true,
        message: 'Connexion réussie ! Hermès Agent répond correctement.',
        latency,
        health: (data as any)?.health,
      });
    } catch (e: any) {
      let msg = e?.message || 'Impossible de joindre le serveur';
      if (window.location.protocol === 'https:' && url.startsWith('http://')) {
        msg = 'Le navigateur bloque les requêtes HTTP non chiffrées depuis cette page HTTPS (Mixed Content). Utilisez un tunnel HTTPS (ex: Cloudflare Tunnel ou ngrok).';
      }
      setTestResult({
        ok: false,
        message: msg,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    setApiBase(url);
    reconnectSse();
    if (onConnected) onConnected();
    onClose();
    // Recharger la page pour reconnecter tous les hooks et EventSources proprement
    setTimeout(() => {
      window.location.reload();
    }, 200);
  };

  const handleReset = () => {
    setUrl('');
    setApiBase('');
    reconnectSse();
    if (onConnected) onConnected();
    onClose();
    setTimeout(() => {
      window.location.reload();
    }, 200);
  };

  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-stone-900 border border-stone-800 rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-5 text-stone-200">
        <div className="flex items-center justify-between border-b border-stone-800 pb-3">
          <div className="flex items-center gap-2.5">
            <Server className="w-5 h-5 text-orange-500" />
            <h2 className="text-base font-semibold tracking-tight text-stone-100">
              Connexion à l'Agent Hermès
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-stone-400 hover:text-stone-100 hover:bg-stone-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block text-xs font-mono tracking-wider uppercase text-stone-400">
            URL de l'API / Backend Hermès
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Globe className="w-4 h-4 absolute left-3 top-3 text-stone-500" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Ex: http://192.168.1.240:51763 ou https://hermes.home.lan"
                className="w-full bg-stone-950 border border-stone-800 rounded-lg pl-9 pr-3 py-2 text-sm text-stone-100 placeholder-stone-600 focus:outline-none focus:border-orange-500 transition-colors"
              />
            </div>
            <button
              onClick={handleTest}
              disabled={testing}
              className="px-4 py-2 bg-stone-800 hover:bg-stone-700 disabled:opacity-50 text-xs font-medium rounded-lg text-stone-200 flex items-center gap-2 transition-colors shrink-0"
            >
              {testing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Tester
            </button>
          </div>

          {/* Raccourcis rapides */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <span className="text-[11px] text-stone-500 self-center mr-1">Raccourcis :</span>
            <button
              type="button"
              onClick={() => setUrl('http://192.168.1.240:51763')}
              className="px-2 py-1 bg-stone-950 hover:bg-stone-800 border border-stone-800 rounded text-[11px] text-stone-300 font-mono transition-colors"
            >
              VM (192.168.1.240:51763)
            </button>
            <button
              type="button"
              onClick={() => setUrl('https://hermes.home.lan')}
              className="px-2 py-1 bg-stone-950 hover:bg-stone-800 border border-stone-800 rounded text-[11px] text-stone-300 font-mono transition-colors"
            >
              https://hermes.home.lan
            </button>
            <button
              type="button"
              onClick={() => setUrl('')}
              className="px-2 py-1 bg-stone-950 hover:bg-stone-800 border border-stone-800 rounded text-[11px] text-stone-300 font-mono transition-colors"
            >
              Origine locale (/)
            </button>
          </div>

          {testResult && (
            <div
              className={`p-3 rounded-lg border text-xs flex items-start gap-2.5 ${
                testResult.ok
                  ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                  : 'bg-red-950/40 border-red-800/60 text-red-300'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1">
                <div>{testResult.message}</div>
                {testResult.latency !== undefined && (
                  <div className="text-[11px] opacity-80 font-mono">
                    Latence : {testResult.latency} ms
                  </div>
                )}
              </div>
            </div>
          )}

          {isHttps && (
            <div className="p-3 bg-stone-950/80 rounded-lg border border-stone-800/80 text-xs space-y-2 text-stone-400">
              <div className="font-semibold text-stone-300 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-orange-400" />
                Comment tester depuis la preview en ligne (HTTPS) :
              </div>
              <p className="leading-relaxed">
                Sur votre machine <code className="text-orange-300 bg-stone-900 px-1 py-0.5 rounded">192.168.1.240</code>, lancez un tunnel temporaire pour obtenir une URL HTTPS sécurisée :
              </p>
              <div className="bg-stone-900 px-2.5 py-1.5 rounded font-mono text-[11px] text-stone-200 select-all border border-stone-800">
                cloudflared tunnel --url http://127.0.0.1:51763
              </div>
              <p className="text-[11px] text-stone-500">
                Puis copiez l'URL <code className="text-stone-400">https://xxxx.trycloudflare.com</code> ci-dessus.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-stone-800 pt-4">
          <button
            onClick={handleReset}
            className="text-xs text-stone-400 hover:text-stone-200 transition-colors"
          >
            Réinitialiser (Origine locale)
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-xs font-medium rounded-lg text-stone-300 transition-colors"
            >
              Annuler
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 text-xs font-medium rounded-lg text-white transition-colors"
            >
              Enregistrer & Reconnecter
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
