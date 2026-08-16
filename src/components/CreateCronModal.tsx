import React, { useEffect, useState } from 'react';
import { X, Clock, Loader2 } from 'lucide-react';
import { createCron } from '../api';
import { ScheduleEditor, parseCron, buildCron, type ScheduleEditorState, type Mode } from './cron/ScheduleEditor';

interface CreateCronModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

const AGENTS: { key: string; label: string }[] = [
  { key: 'manager', label: 'Manager (A-00)' },
  { key: 'recherche', label: 'Recherche (A-01)' },
  { key: 'reseau', label: 'Reseau (A-03)' },
  { key: 'developpeur', label: 'Developpeur (A-04)' },
  { key: 'analyse', label: 'Analyse (A-05)' },
  { key: 'redacteur', label: 'Redacteur (A-06)' },
  { key: 'social', label: 'Social (A-07)' },
  { key: 'vision-image', label: 'Vision-Image (A-08)' },
  { key: 'vision-media', label: 'Vision-Media (A-09)' },
  { key: 'bob', label: 'Bob (A-10)' },
  { key: 'agentique', label: 'Agentique (A-11)' },
];

const DELIVERS: { key: string; label: string }[] = [
  { key: 'local', label: 'Local (sauvegarde seule)' },
  { key: 'origin', label: 'Origine (canal du job)' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'discord', label: 'Discord' },
  { key: 'signal', label: 'Signal' },
  { key: 'email', label: 'Email' },
];

const DAYS: { key: number; label: string }[] = [
  { key: 1, label: 'Lun' },
  { key: 2, label: 'Mar' },
  { key: 3, label: 'Mer' },
  { key: 4, label: 'Jeu' },
  { key: 5, label: 'Ven' },
  { key: 6, label: 'Sam' },
  { key: 7, label: 'Dim' },
];

const inputCls =
  'w-full bg-stone-950 border border-stone-800 rounded-xl px-3 py-2 text-sm ' +
  'text-stone-200 placeholder-stone-600 focus:outline-none focus:border-orange-600 transition-colors';
const labelCls = 'block text-[10px] uppercase tracking-widest text-stone-500 mb-1.5';

const range = (a: number, b: number) => {
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
};
const pad = (n: number) => String(n).padStart(2, '0');

export const CreateCronModal: React.FC<CreateCronModalProps> = ({ open, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('manager');
  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [scheduleState, setScheduleState] = useState<ScheduleEditorState>({
    mode: 'interval',
    ivHours: 0,
    ivMinutes: 30,
    days: [1],
    atHour: 9,
    atMinute: 0,
    everyN: 2,
    onceAt: '',
  });
  const [delivers, setDelivers] = useState<string[]>(['local']);
  const [emailAddress, setEmailAddress] = useState('piloubruce@gmail.com');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (!open) return null;

  const buildSchedule = (): { ok: boolean; value: string; error?: string } => {
    return buildCron(scheduleState);
  };

  const preview = buildSchedule();

  const reset = () => {
    setName('');
    setAgent('manager');
    setPrompt('');
    setEnabled(true);
    setScheduleState({
      mode: 'interval',
      ivHours: 0,
      ivMinutes: 30,
      days: [1],
      atHour: 9,
      atMinute: 0,
      everyN: 2,
      onceAt: '',
    });
    setDelivers(['local']);
    setEmailAddress('piloubruce@gmail.com');
    setError(null);
    setOk(null);
    setSaving(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggleDay = (d: number) => {
    setScheduleState(prev => ({
      ...prev,
      days: prev.days.includes(d) ? prev.days.filter((x) => x !== d) : [...prev.days, d]
    }));
  };

  const toggleDeliver = (k: string) => {
    setDelivers(prev => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!prompt.trim()) {
      setError('Le prompt / instruction est obligatoire.');
      return;
    }
    const sched = buildSchedule();
    if (!sched.ok) {
      setError(sched.error || 'Planification invalide.');
      return;
    }
    if (delivers.length === 0) {
      setError('Sélectionnez au moins une cible de livraison.');
      return;
    }
    setSaving(true);
    // Feature 2 : si 'email' est sélectionné, encoder la cible au format
    // `email:adresse` (format Hermes `platform:chat_id`).
    const deliverParts = delivers.map((d) =>
      d === 'email' ? `email:${emailAddress.trim() || 'piloubruce@gmail.com'}` : d
    );
    const res = await createCron({
      name: name.trim(),
      agent,
      prompt: prompt.trim(),
      schedule: sched.value,
      deliver: deliverParts.length === 1 ? deliverParts[0] : deliverParts.join(','),
      enabled,
    });
    if (res.ok) {
      setOk(`Tâche créée (id ${res.id}) sur le profil « ${res.profile} ».`);
      setSaving(false);
      if (onCreated) onCreated();
      setTimeout(() => close(), 1600);
    } else {
      setError(res.error || 'Échec de la création.');
      setSaving(false);
    }
  };

  const modeBtn = (m: Mode, label: string) => (
    <button
      key={m}
      type="button"
      onClick={() => setScheduleState(prev => ({ ...prev, mode: m }))}
      className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
        scheduleState.mode === m
          ? 'border-orange-600 text-orange-400 bg-orange-900/20'
          : 'border-stone-800 text-stone-400 hover:border-stone-700'
      }`}
    >
      {label}
    </button>
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl bg-stone-950 border border-stone-800 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-800">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-orange-500" />
            <h3 className="text-sm font-semibold text-stone-100">Nouvelle tâche planifiée</h3>
          </div>
          <button type="button" onClick={close} className="text-stone-500 hover:text-stone-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={submit} className="px-5 py-4 space-y-4 max-h-[80vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Nom</label>
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nom de la tâche"
              />
            </div>
            <div>
              <label className={labelCls}>Agent cible</label>
              <select
                className={inputCls}
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                {AGENTS.map((a) => (
                  <option key={a.key} value={a.key}>{a.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Prompt / Instruction</label>
            <textarea
              className={inputCls}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Instruction autonome et complète (le job s'exécute sans contexte de chat)."
            />
          </div>

          <div>
            <label className={labelCls}>Planification</label>
            <ScheduleEditor
              state={scheduleState}
              onChange={(partial) => setScheduleState((prev) => ({ ...prev, ...partial }))}
              showPreview={true}
            />
          </div>

          <div>
            <label className={labelCls}>Livraison (multi-sélection)</label>
            <div className="flex flex-wrap gap-2">
              {DELIVERS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleDeliver(d.key)}
                  className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
                    delivers.includes(d.key)
                      ? 'border-orange-600 text-orange-400 bg-orange-900/20'
                      : 'border-stone-800 text-stone-400 hover:border-stone-700'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {/* Feature 2 : sélecteur d'adresse email (compact) quand Email est choisi */}
            {delivers.includes('email') && (
              <div className="mt-2 flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-widest text-stone-500">
                  Adresse email
                </label>
                <select
                  value={emailAddress}
                  onChange={(e) => setEmailAddress(e.target.value)}
                  className="bg-stone-950 border border-stone-800 rounded-lg px-2 py-1 text-xs text-stone-200 focus:outline-none focus:border-orange-600"
                >
                  <option value="piloubruce@gmail.com">piloubruce@gmail.com</option>
                  <option value="piloubruce@free.fr">piloubruce@free.fr</option>
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              id="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-orange-600"
            />
            <label htmlFor="enabled" className="text-sm text-stone-300">
              Activer immédiatement
            </label>
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}
          {ok && <div className="text-xs text-emerald-400">{ok}</div>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={close} className="text-sm text-stone-400 hover:text-stone-200">
              Annuler
            </button>
            <button
              type="submit"
              disabled={saving}
              className="text-sm px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white disabled:opacity-60"
            >
              {saving ? 'Sauvegarde...' : 'Créer la tâche'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};