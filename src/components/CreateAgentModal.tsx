import React, { useState, useEffect, useRef } from 'react';
import { Plus, X, User, FileText } from 'lucide-react';

interface CreateAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

interface AgentForm {
  key: string;
  name: string;
  role: string;
  mission: string;
  functions: string;
}

export const CreateAgentModal: React.FC<CreateAgentModalProps> = ({ open, onClose, onCreated }) => {
  const [form, setForm] = useState<AgentForm>(() => ({ key: '', name: '', role: '', mission: '', functions: '' }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Ferme automatiquement la modale de confirmation apres un court delai
  // (evite une fenetre bloquante qui reste ouverte apres la creation).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!ok) return;
    const t = setTimeout(() => onCloseRef.current(), 3000);
    return () => clearTimeout(t);
  }, [ok]);

  if (!open) return null;

  // Note (2026-07-30) : pas de useEffect de reset ici — il levait un React
  // #310 (objet enfant invalide) car il re-injectait la constante module
  // `emptyForm` (reference partagee) via setForm a chaque montage. Le reset est
  // fait dans onClose/onCreated (setForm a un objet frais) + via la `key` posee
  // par AgentsTab.

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const key = form.key.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const name = form.name.trim();
    const role = form.role.trim();
    const mission = form.mission.trim();
    const functions = form.functions.trim();
    if (!key || !name || !role) {
      setError('Remplis au minimum : clé, nom et rôle.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/fleet/agent/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        // mission = ce que l'agent doit faire (description libre) ; le backend
        // la transmet au Redacteur pour rediger le SOUL.md dedie.
        body: JSON.stringify({ key, name, role, mission, functions }),
      });
      const body = (await res.json().catch(() => ({ ok: false, error: `${res.status}` }))) as { ok?: boolean; error?: string };
      if (body.ok) {
        setOk(`Agent « ${name} » créé. Le SOUL.md est rédigé par l'agent Rédacteur.`);
        setForm({ key: '', name: '', role: '', mission: '', functions: '' });
        // Previens le parent (AgentsTab) pour rafraichir la flotte immediatement.
        if (onCreated) onCreated();
      } else {
        setError(typeof body.error === 'string' ? body.error : `Echec HTTP ${res.status}`);
        setSaving(false);
      }
    } catch (e) {
      setError((e as Error).message || 'Erreur réseau');
      setSaving(false);
    }
  };

  if (saving && ok) {
    return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => onClose()}>
        <div className="w-full max-w-sm rounded-xl border border-stone-800 bg-stone-950 p-6 shadow-2xl text-center" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-stone-200 mb-2">{ok}</p>
          <p className="text-xs text-stone-500 mb-4">L'agent apparaîtra dans tous les onglets sous peu (référentiel de flotte mis à jour).</p>
          <button type="button" onClick={() => onClose()} className="px-4 py-2 text-xs font-medium rounded-md bg-orange-600 text-white hover:bg-orange-500 transition-colors">Fermer</button>
        </div>
      </div>
    );
  }

  const inputCls =
    'w-full bg-stone-900 border border-stone-700 rounded-md px-3 py-2 text-sm text-stone-100 placeholder-stone-500 focus:outline-none focus:border-orange-500';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-xl border border-stone-800 bg-stone-950 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-stone-100">
            <Plus className="w-4 h-4 text-orange-500" />
            Nouvel agent
          </h2>
          <button onClick={onClose} title="Fermer" className="text-stone-500 hover:text-stone-200 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label className="mb-1 block text-xs text-stone-400">Clé interne</label>
              <input value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} className={inputCls} placeholder="ex: truc" inputMode="text" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-stone-400">Nom affiché</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="ex: Truc" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-stone-400">Rôle de l'agent</label>
            <input value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className={inputCls} placeholder="ex: Support avancé" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-stone-400">Ce que l'agent doit faire (mission)</label>
            <textarea
              value={form.mission}
              onChange={(e) => setForm((f) => ({ ...f, mission: e.target.value }))}
              className={`${inputCls} min-h-[90px] resize-y`}
              placeholder={"Décris en quelques phrases ce que l'agent a pour mission (ex: surveiller les serveurs et alerter en cas d'incident)."}
            />
          </div>

          <div>
            <label className="mb-1 flex items-center gap-2 text-xs text-stone-400">
              <User className="w-3 h-3" />
              Ses fonctions
            </label>
            <textarea
              value={form.functions}
              onChange={(e) => setForm((f) => ({ ...f, functions: e.target.value }))}
              className={`${inputCls} min-h-[140px] resize-y`}
              placeholder="Une ligne par fonction :\n- Fait X\n- Fait Y\n- Fait Z"
            />
          </div>

          <div className="rounded-md bg-stone-900/60 border border-stone-800 p-3 text-[11px] leading-relaxed text-stone-400">
            <div className="flex items-center gap-2 mb-1 text-stone-300">
              <FileText className="w-3 h-3" />
              Déroulé
            </div>
            <p>À l'enregistrement, le profil Hermes est créé, puis l'agent <span className="font-mono">Rédacteur</span> rédige le <span className="font-mono">SOUL.md</span> (partie commune de la flotte + partie dédiée à cet agent). L'agent apparaît ensuite automatiquement dans tous les onglets du dashboard.</p>
          </div>

          {error && (
            <p className="rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400">{error}</p>
          )}
          {ok && (
            <p className="rounded-md bg-green-500/10 border border-green-500/30 px-3 py-2 text-xs text-green-400">{ok}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-2 text-xs rounded-md text-stone-400 hover:text-stone-200 hover:bg-stone-900/50 transition-colors">
              Annuler
            </button>
            <button type="button" disabled={saving} onClick={(e) => { e.preventDefault(); submit(e as unknown as React.FormEvent); }} className="px-4 py-2 text-xs font-medium rounded-md bg-orange-600 text-white hover:bg-orange-500 disabled:opacity-50 transition-colors">
              {saving ? 'Création...' : 'Créer l\'agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
