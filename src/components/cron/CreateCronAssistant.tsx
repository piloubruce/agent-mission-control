import React, { useState } from 'react';
import { X, Clock, Check, AlertCircle, HelpCircle, Calendar, RefreshCw, Shuffle } from 'lucide-react';
import { createCron, type CronJob } from '../../api';
import { ScheduleEditor, buildCron, type ScheduleEditorState } from './ScheduleEditor';

interface CreateCronAssistantProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

// Step definitions
type Step = 'name' | 'schedule' | 'target' | 'validation';

// Agent list (same as CreateCronModal)
const AGENTS: { key: string; label: string; description: string }[] = [
  { key: 'manager', label: 'Manager (A-00)', description: 'Coordonnateur principal' },
  { key: 'recherche', label: 'Recherche (A-01)', description: 'Analyse académique, papers' },
  { key: 'analyse', label: 'Analyse (A-05)', description: 'Data analysis, insights' },
  { key: 'redacteur', label: 'Redacteur (A-06)', description: 'Documents, docs writing' },
  { key: 'social', label: 'Social (A-07)', description: 'Social media, posts' },
  { key: 'vision-image', label: 'Vision-Image (A-08)', description: 'Image analysis' },
  { key: 'vision-media', label: 'Vision-Media (A-09)', description: 'Video, media processing' },
  { key: 'bob', label: 'Bob (A-10)', description: 'Agentique, tools' },
  { key: 'agentique', label: 'Agentique (A-11)', description: 'Multi-agent workflows' },
];

// Cron expression helpers (handled by ScheduleEditor's shared logic)
export const CreateCronAssistant: React.FC<CreateCronAssistantProps> = ({
  open,
  onClose,
  onCreated,
}) => {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('manager');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [deliver, setDeliver] = useState<'local' | 'origin' | 'telegram' | 'discord' | 'signal' | 'email'>('local');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  
  // État du schedule utilisant le type partagé
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

  if (!open) return null;

  const handleNext = () => {
    if (step === 'name') {
      if (!name.trim()) {
        setError('Le nom de la tâche est requis.');
        return;
      }
      setError(null);
      setStep('schedule');
    } else if (step === 'schedule') {
      if (!buildCron(scheduleState).ok) {
        setError('Choisissez une planification valide.');
        return;
      }
      setError(null);
      setStep('target');
    } else if (step === 'target') {
      if (!description.trim() && !prompt.trim()) {
        setError('Décrivez ce que la tâche doit faire.');
        return;
      }
      setError(null);
      setStep('validation');
    }
  };

  const handleBack = () => {
    setError(null);
    if (step === 'schedule') setStep('name');
    else if (step === 'target') setStep('schedule');
    else if (step === 'validation') setStep('target');
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    setOk(null);

    try {
      // Utiliser buildCron pour obtenir la valeur finale du schedule
      const scheduleResult = buildCron(scheduleState);
      if (!scheduleResult.ok) {
        setError(scheduleResult.error || 'Planification invalide.');
        setSaving(false);
        return;
      }

      const result = await createCron({
        name: name.trim(),
        agent,
        prompt: prompt.trim() || description.trim(),
        schedule: scheduleResult.value,
        deliver,
        enabled,
      });

      if (result.ok) {
        setOk(`Tâche créée avec succès (ID: ${result.id})`);
        if (onCreated) onCreated();
        setTimeout(() => {
          onClose();
          setStep('name');
          setName('');
          setAgent('manager');
          setDescription('');
          setPrompt('');
          setDeliver('local');
          setEnabled(true);
          // Réinitialiser l'état du schedule
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
        }, 1500);
      } else {
        setError(result.error || 'Échec de la création.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const renderStepContent = () => {
    switch (step) {
      case 'name':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-stone-300 mb-2">Nom de la tâche</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex: Veille quotidienne, Scraping données"
                className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-stone-300 mb-2">Agent cible</label>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
              >
                {AGENTS.map(a => (
                  <option key={a.key} value={a.key}>
                    <div>
                      <span className="font-medium">{a.label}</span>
                      <div className="text-xs text-stone-500">{a.description}</div>
                    </div>
                  </option>
                ))}
              </select>
            </div>
          </div>
        );

      case 'schedule':
        return (
          <div className="space-y-2">
            <ScheduleEditor
              state={scheduleState}
              onChange={(partial) => setScheduleState((prev) => ({ ...prev, ...partial }))}
              showPreview={true}
            />
          </div>
        );

      case 'target':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-stone-300 mb-2">Description / Objectif</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Que doit-elle faire? (ex: Lire les derniers articles de..., extraire les points clés...)"
                className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600 min-h-[80px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-stone-300 mb-2">Prompt détaillé (optionnel)</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Instructions détaillées pour l'agent (explicatif, format de sortie, etc.)"
                className="w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600 min-h-[80px]"
              />
              <div className="text-xs text-stone-500 mt-1">
                Laissez vide pour utiliser la description ci-dessus.
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-stone-300 mb-2">Mode de livraison</label>
              <div className="space-y-2">
                <label className="flex items-center gap-3 p-3 bg-stone-900/50 rounded-lg cursor-pointer hover:bg-stone-800 transition-colors">
                  <input
                    type="radio"
                    name="deliver"
                    checked={deliver === 'local'}
                    onChange={() => setDeliver('local')}
                    className="accent-orange-600 w-4 h-4"
                  />
                  <div>
                    <span className="font-medium text-stone-200">Local</span>
                    <div className="text-xs text-stone-500">Sauvegarde uniquement dans le répertoire des jobs</div>
                  </div>
                </label>
                <label className="flex items-center gap-3 p-3 bg-stone-900/50 rounded-lg cursor-pointer hover:bg-stone-800 transition-colors">
                  <input
                    type="radio"
                    name="deliver"
                    checked={deliver === 'origin'}
                    onChange={() => setDeliver('origin')}
                    className="accent-orange-600 w-4 h-4"
                  />
                  <div>
                    <span className="font-medium text-stone-200">Origine</span>
                    <div className="text-xs text-stone-500">Livraison via le canal du job (si configuré)</div>
                  </div>
                </label>
                <label className="flex items-center gap-3 p-3 bg-stone-900/50 rounded-lg cursor-pointer hover:bg-stone-800 transition-colors">
                  <input
                    type="radio"
                    name="deliver"
                    checked={deliver === 'telegram'}
                    onChange={() => setDeliver('telegram')}
                    className="accent-orange-600 w-4 h-4"
                  />
                  <div>
                    <span className="font-medium text-stone-200">Telegram</span>
                    <div className="text-xs text-stone-500">Livraison sur Telegram</div>
                  </div>
                </label>
                <label className="flex items-center gap-3 p-3 bg-stone-900/50 rounded-lg cursor-pointer hover:bg-stone-800 transition-colors">
                  <input
                    type="radio"
                    name="deliver"
                    checked={deliver === 'discord'}
                    onChange={() => setDeliver('discord')}
                    className="accent-orange-600 w-4 h-4"
                  />
                  <div>
                    <span className="font-medium text-stone-200">Discord</span>
                    <div className="text-xs text-stone-500">Livraison sur Discord</div>
                  </div>
                </label>
                <label className="flex items-center gap-3 p-3 bg-stone-900/50 rounded-lg cursor-pointer hover:bg-stone-800 transition-colors">
                  <input
                    type="radio"
                    name="deliver"
                    checked={deliver === 'email'}
                    onChange={() => setDeliver('email')}
                    className="accent-orange-600 w-4 h-4"
                  />
                  <div>
                    <span className="font-medium text-stone-200">Email</span>
                    <div className="text-xs text-stone-500">Livraison par email</div>
                  </div>
                </label>
              </div>
            </div>
          </div>
        );

      case 'validation':
        return (
          <div className="space-y-4">
            <div className="bg-stone-900/50 border border-stone-800 rounded-lg p-4">
              <h4 className="font-medium text-stone-200 mb-3">Résumé de la tâche</h4>
              <div className="space-y-2 text-sm">
                <div><span className="text-stone-500">Nom:</span> <span className="text-stone-300">{name}</span></div>
                <div><span className="text-stone-500">Agent:</span> <span className="text-stone-300">{AGENTS.find(a => a.key === agent)?.label || agent}</span></div>
                <div><span className="text-stone-500">Planification:</span> <span className="font-mono text-orange-400">{buildCron(scheduleState).ok ? buildCron(scheduleState).value : '...'}</span></div>
                <div><span className="text-stone-500">Objectif:</span> <span className="text-stone-300">{description || prompt || '(non défini)'}</span></div>
                <div><span className="text-stone-500">Livraison:</span> <span className="text-stone-300">{deliver === 'local' ? 'Local' : deliver === 'origin' ? 'Origine' : deliver === 'telegram' ? 'Telegram' : deliver === 'discord' ? 'Discord' : deliver === 'email' ? 'Email' : deliver}</span></div>
                <div><span className="text-stone-500">Activé:</span> <span className={enabled ? 'text-emerald-400' : 'text-stone-500'}>{enabled ? 'Oui' : 'Non'}</span></div>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        className="bg-stone-900 border border-stone-800 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-stone-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-orange-500" />
            <h2 className="text-xl font-serif text-stone-100">Assistant de création de cron</h2>
          </div>
          <button
            onClick={onClose}
            className="text-stone-500 hover:text-stone-200 transition-colors"
            title="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress indicator */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-stone-800">
          {(['name', 'schedule', 'target', 'validation'] as Step[]).map((s, idx) => (
            <React.Fragment key={s}>
              <div className="flex items-center">
                <div className={`w-2 h-2 rounded-full ${
                  step === s ? 'bg-orange-500' :
                  s < step ? 'bg-emerald-400' : 'bg-stone-600'
                }`} />
                {idx < 3 && (
                  <div className="w-8 h-0.5 bg-stone-700" />
                )}
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* Form content */}
        <form onSubmit={(e) => e.preventDefault()} className="px-6 py-5 space-y-5">
          {renderStepContent()}

          {/* Navigation */}
          <div className="flex justify-between items-center pt-2">
            {step !== 'name' && (
              <button
                type="button"
                onClick={handleBack}
                className="px-4 py-2 text-sm text-stone-400 hover:text-stone-200 transition-colors"
                disabled={saving}
              >
                ← Retour
              </button>
            )}
            {step !== 'validation' ? (
              <button
                type="button"
                onClick={handleNext}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-500 transition-colors disabled:opacity-50"
                disabled={saving}
              >
                Continuer →
              </button>
            ) : (
              <button
                type="submit"
                onClick={handleSubmit}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50"
                disabled={saving}
              >
                {saving ? 'Création...' : 'Créer la tâche'}
              </button>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Success */}
          {ok && (
            <div className="text-sm text-emerald-400 bg-emerald-900/20 border border-emerald-900/40 rounded-lg px-3 py-2">
              {ok}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

