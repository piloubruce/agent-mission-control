import React from 'react';
import { useApiState, deleteCron, updateCron, runCron, getCronScript, type CronJob } from '../../api';
import { Clock, Plus, Edit, Trash2, History, HelpCircle, Play } from 'lucide-react';
import { CreateCronModal } from '../CreateCronModal';
import { CreateCronAssistant } from '../cron/CreateCronAssistant';
import { CronLogsDisplay } from '../cron/CronLogsDisplay';
import { ScheduleEditor, parseCron, buildCron, type ScheduleEditorState } from '../cron/ScheduleEditor';

// Recuperer les fonctions API depuis l'objet importe
// Note: on utilise destructuration pour les types

const DELIVERS: { key: string; label: string }[] = [
  { key: 'local', label: 'Local (sauvegarde seule)' },
  { key: 'origin', label: 'Origine (canal du job)' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'discord', label: 'Discord' },
  { key: 'signal', label: 'Signal' },
  { key: 'email', label: 'Email' },
];

// Fallback statique (utilisé si state.fleet pas encore chargé). Synchronisé
// avec FLEET_ORDER côté backend : inclut TOUS les agents réels de la flotte
// (agentique compris). La source dynamique state.fleet est fusionnée par-dessus
// dans le composant (voir `agentOptions`) pour ne jamais omettre un agent.
const AGENT_FALLBACK: { key: string; label: string }[] = [
  { key: 'manager', label: 'Manager' },
  { key: 'recherche', label: 'Recherche' },
  { key: 'analyse', label: 'Analyse' },
  { key: 'redacteur', label: 'Redacteur' },
  { key: 'social', label: 'Social' },
  { key: 'reseau', label: 'Reseau' },
  { key: 'developpeur', label: 'Developpeur' },
  { key: 'vision-image', label: 'Vision-Image' },
  { key: 'vision-media', label: 'Vision-Media' },
  { key: 'bob', label: 'Bob' },
  { key: 'agentique', label: 'Agentique' },
];

// Affiche le schedule d'un job de façon robuste : le backend (read_cron_jobs)
// envoie une string normalisée, mais certains jobs (créés via l'API MC) ont un
// schedule sous forme d'objet { kind, expr, display } ou un champ
// `schedule_display` dédié. Ordre : schedule_display -> expr -> display ->
// string brute -> fallback vide.
const displaySchedule = (job: CronJob): string => {
  if (job.schedule_display) return job.schedule_display;
  if (job.schedule && typeof job.schedule === 'object') {
    const s = job.schedule as Record<string, unknown>;
    return String((s.expr as string) || (s.display as string) || '');
  }
  return String(job.schedule || '');
};

export const ScheduleTab: React.FC = () => {
  const { state, connected, refresh } = useApiState();

  // Source dynamique de la flotte (SSE) fusionnée avec le fallback statique :
  // garantit que TOUS les agents réels (agentique inclus) sont disponibles dans
  // le sélecteur d'édition de cron, même avant que state.fleet soit prêt.
  const agentOptions: { key: string; label: string }[] = (() => {
    const map = new Map<string, string>();
    for (const a of AGENT_FALLBACK) map.set(a.key, a.label);
    for (const f of ((state as any)?.fleet ?? []) as Array<{ agent?: string; name?: string }>) {
      const k = f.agent;
      const lbl = f.name || k || '';
      if (k) map.set(k, lbl);
    }
    return Array.from(map, ([key, label]) => ({ key, label }));
  })();
  const cronJobs: CronJob[] = (state?.hermes_cron ?? []) as CronJob[];
  const loading = state === null;
  const [modalOpen, setModalOpen] = React.useState(false);
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const [editingJob, setEditingJob] = React.useState<CronJob | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showLogs, setShowLogs] = React.useState<Record<string, boolean>>({});

  // États de la modale Editer (planification + livraison) - utilisant le type partagé
  const [editSchedule, setEditSchedule] = React.useState<ScheduleEditorState>({
    mode: 'interval',
    ivHours: 0,
    ivMinutes: 30,
    days: [1],
    atHour: 9,
    atMinute: 0,
    everyN: 2,
    onceAt: '',
  });
  const [editDelivers, setEditDelivers] = React.useState<string[]>(['local']);
  const [editEmailAddress, setEditEmailAddress] = React.useState('piloubruce@gmail.com');
  // Contenu du script d'un job no_agent (bloc dépliable "Voir le contenu du script")
  const [editScriptContent, setEditScriptContent] = React.useState<string>('');
  const [editScriptLoading, setEditScriptLoading] = React.useState(false);
  const [editScriptOpen, setEditScriptOpen] = React.useState(false);
  const [editScriptError, setEditScriptError] = React.useState('');
  const [editAgent, setEditAgent] = React.useState<string>('');

  const toggleLogs = (jobId: string) => {
    setShowLogs(prev => ({ ...prev, [jobId]: !prev[jobId] }));
  };

  // Rafraichissement cible apres creation : on re-tire /api/state tout de
  // suite (le SSE peut mettre jusqu'a 3 s), puis une 2e fois pour laisser au
  // scheduler le temps d'ecrire jobs.json — pas de reload de page.
  const afterCreate = React.useCallback(() => {
    refresh();
    setTimeout(refresh, 1200);
  }, [refresh]);

  const afterUpdate = React.useCallback(() => {
    refresh();
    setTimeout(refresh, 800);
  }, [refresh]);

  const handleDelete = async (job: CronJob) => {
    if (!confirm(`Supprimer définitivement la tâche "${job.name}" ?`)) return;
    setBusy(true);
    const res = await deleteCron(job.id);
    if (res.ok) {
      alert('Tâche supprimée avec succès.');
      refresh();
    } else {
      alert(`Erreur: ${res.error || 'inconnu'}`);
    }
    setBusy(false);
  };

  const handleEdit = (job: CronJob) => {
    // Reset du bloc "Voir le contenu du script" à chaque ouverture.
    setEditScriptContent('');
    setEditScriptLoading(false);
    setEditScriptOpen(false);
    setEditScriptError('');
    // BUG 2 : le backend (read_cron_jobs) envoie le prompt dans `description`
    // et n'expose pas `prompt`/`script`. On normalise ici l'objet édité pour
    // que le champ "Prompt / Instruction" affiche le vrai contenu du job.
    setEditingJob({
      ...job,
      prompt: job.prompt ?? job.description ?? '',
      script: job.script,
    });
    // BUG 1 : le schedule peut arriver sous forme d'objet (jobs créés via
    // l'API MC : { kind, expr, display }) ou de string. parseCron() attend
    // une string — on extrait donc la bonne valeur avant de parser.
    const rawSchedule =
      typeof job.schedule === 'object' && job.schedule !== null
        ? (job.schedule as Record<string, unknown>).expr
          ? String((job.schedule as Record<string, unknown>).expr)
          : String((job.schedule as Record<string, unknown>).display || '')
        : String(job.schedule || '');
    const sched = parseCron(rawSchedule);
    setEditSchedule(sched);
    setEditDelivers(
      (job.deliver || 'local').split(',').map((d) => d.trim()).filter(Boolean)
        .map((d) => d.startsWith('email:') ? 'email' : d)
    );
    // Pré-remplir l'adresse email depuis un deliver existant 'email:adresse@x.com'
    const emailPart = (job.deliver || '').split(',').map((d) => d.trim()).find((d) => d.startsWith('email:'));
    if (emailPart) {
      const addr = emailPart.slice('email:'.length).trim();
      if (addr) setEditEmailAddress(addr);
    } else {
      setEditEmailAddress('piloubruce@gmail.com');
    }
    // Feature (2026-08-13) : pré-remplir le sélecteur d'agent avec le profil
    // actuel du job pour la modale d'édition.
    setEditAgent(job.profile || '');
  };

  const handleUpdate = async (jobId: string, data: Partial<CronJob>) => {
    const sched = buildCron(editSchedule);
    if (!sched.ok) {
      alert(sched.error || 'Planification invalide.');
      return;
    }
    if (editDelivers.length === 0) {
      alert('Sélectionnez au moins une cible de livraison.');
      return;
    }
    setBusy(true);
    const payload: Record<string, unknown> = {};
    if (data.name !== undefined) payload.name = data.name;
    payload.schedule = sched.value;
    // BUG 2 : le vrai contenu du job est le champ `prompt`. Si l'utilisateur
    // l'a édité via le champ "Prompt / Instruction", on l'envoie en priorité ;
    // sinon on retombe sur `description` (mapping historique : le backend
    // accepte prompt OU description et mappe sur --prompt du CLI).
    // BUG 2 fix (2026-08-10) : un seul champ "Prompt / Instruction" pilote
    // le --prompt du CLI. On n'envoie JAMAIS de champ `description` separe
    // (le backend mappe description -> prompt, donc envoyer les deux
    // dupliquait le contenu a l'edition).
    payload.prompt = data.prompt ?? data.description ?? '';
    if (data.enabled !== undefined) payload.enabled = data.enabled;
    // Feature (2026-08-13) : sélecteur d'agent — le backend recrée le job dans
    // le profil cible si l'agent diffère du profil actuel (sinon édition simple).
    payload.agent = editAgent;
    // Feature 2 : si 'email' est sélectionné, encoder la cible au format
    // `email:adresse` (format Hermes `platform:chat_id` supporté par le
    // scheduler). Les autres cibles restent inchangées.
    const deliverParts = editDelivers.map((d) =>
      d === 'email' ? `email:${editEmailAddress.trim() || 'piloubruce@gmail.com'}` : d
    );
    payload.deliver = deliverParts.length === 1 ? deliverParts[0] : deliverParts.join(',');

    const res = await updateCron(jobId, payload as Parameters<typeof updateCron>[1]);
    if (res.ok) {
      alert('Tâche mise à jour avec succès.');
      setEditingJob(null);
      refresh();
    } else {
      alert(`Erreur: ${res.error || 'inconnu'}`);
    }
    setBusy(false);
  };

  const handleCloseEdit = () => {
    setEditingJob(null);
    setEditScriptContent('');
    setEditScriptLoading(false);
    setEditScriptOpen(false);
    setEditScriptError('');
  };

  // Charge (une fois) le contenu du script d'un job no_agent puis bascule le
  // bloc dépliable. Un clic suivant masque/affiche sans refetch.
  const handleViewScript = async () => {
    if (!editingJob?.script) return;
    if (editScriptContent) {
      setEditScriptOpen((o) => !o);
      return;
    }
    setEditScriptLoading(true);
    setEditScriptError('');
    const res = await getCronScript(editingJob.script);
    if (res.ok) {
      setEditScriptContent(res.content ?? '');
      setEditScriptOpen(true);
    } else {
      setEditScriptError(res.error || 'Impossible de lire le script.');
    }
    setEditScriptLoading(false);
  };

  const toggleEditDeliver = (k: string) =>
    setEditDelivers((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));


  const handleRun = async (job: CronJob) => {
    if (busy) return;
    setBusy(true);
    const res = await runCron(job.id);
    if (res.ok) {
      alert('Exécution déclenchée avec succès.');
      // Refresh logs to show the new execution
      setShowLogs(prev => ({ ...prev, [job.id]: true }));
      // Also refresh the main state to update last_run
      setTimeout(refresh, 1000);
    } else {
      alert(`Erreur: ${res.error || 'échec de l\'exécution'}`);
    }
    setBusy(false);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <CreateCronAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        onCreated={afterCreate}
      />

      <CreateCronModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={afterCreate}
      />

      {/* Modal Editer */}
      {editingJob && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-stone-900 border border-stone-800 rounded-2xl p-6 max-w-xl w-full">
            <h3 className="text-lg font-medium text-stone-200 mb-4 flex items-center gap-2">
              <Edit className="w-4 h-4 text-orange-500" />
              Editer la tâche
            </h3>
            <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
              <div>
                <label className="text-xs text-stone-500">Nom</label>
                <input
                  type="text"
                  value={editingJob.name}
                  onChange={(e) => setEditingJob({ ...editingJob, name: e.target.value })}
                  className="mt-1 w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
                />
              </div>
              <ScheduleEditor
                state={editSchedule}
                onChange={(partial) => setEditSchedule((prev) => ({ ...prev, ...partial }))}
                showPreview={true}
              />
              {/* BUG 2 fix (2026-08-10) : le backend mappe tout sur --prompt
                  (read_cron_jobs met `prompt` dans `description`). Afficher 2
                  champs (Description + Prompt / Instruction) dupliquait le meme
                  contenu a l'edition. On ne garde QUE "Prompt / Instruction". */}
              <div>
                <label className="text-xs text-stone-500">Prompt / Instruction</label>
                <textarea
                  value={editingJob.prompt ?? ''}
                  onChange={(e) => setEditingJob({ ...editingJob, prompt: e.target.value })}
                  className="mt-1 w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600 max-h-32 overflow-y-auto"
                  rows={4}
                />
              </div>
              {editingJob.script ? (
                <div>
                  <label className="text-xs text-stone-500">Script</label>
                  <input
                    type="text"
                    value={editingJob.script}
                    disabled
                    title="Job de type script : le contenu est exécuté directement, pas via un agent."
                    className="mt-1 w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-400 focus:outline-none disabled:opacity-70 disabled:cursor-not-allowed"
                  />
                  <button
                    type="button"
                    onClick={handleViewScript}
                    disabled={editScriptLoading}
                    className="mt-2 text-xs text-orange-400 hover:text-orange-300 disabled:opacity-50"
                  >
                    {editScriptLoading
                      ? 'Chargement du script…'
                      : editScriptOpen
                        ? 'Masquer le contenu du script'
                        : 'Voir le contenu du script'}
                  </button>
                  {editScriptError && (
                    <p className="mt-1 text-xs text-red-500">{editScriptError}</p>
                  )}
                  {editScriptOpen && editScriptContent !== '' && (
                    <pre className="mt-2 max-h-48 overflow-y-auto font-mono text-xs text-stone-400 bg-stone-950 border border-stone-800 rounded p-2 whitespace-pre-wrap break-words">
                      {editScriptContent}
                    </pre>
                  )}
                </div>
              ) : null}
              <div>
                <label className="text-xs text-stone-500">Activé</label>
                <select
                  value={editingJob.enabled !== false ? 'true' : 'false'}
                  onChange={(e) => setEditingJob({ ...editingJob, enabled: e.target.value === 'true' })}
                  className="mt-1 w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
                >
                  <option value="true">Oui</option>
                  <option value="false">Non</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-stone-500">Agent (profil)</label>
                <select
                  value={editAgent}
                  onChange={(e) => setEditAgent(e.target.value)}
                  className="mt-1 w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600"
                >
                  {agentOptions.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
                {editAgent !== editingJob.profile && (
                  <p className="mt-1 text-xs text-amber-500">
                    ⚠ Le job sera recréé dans le profil <span className="font-medium">{editAgent}</span> (ancien : <span className="font-medium">{editingJob.profile}</span>).
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs text-stone-500">Livraison (multi-sélection)</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {DELIVERS.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => toggleEditDeliver(d.key)}
                      className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
                        editDelivers.includes(d.key)
                          ? 'border-orange-600 text-orange-400 bg-orange-900/20'
                          : 'border-stone-800 text-stone-400 hover:border-stone-700'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                {/* Feature 2 : sélecteur d'adresse email (compact) quand Email est choisi */}
                {editDelivers.includes('email') && (
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-[10px] uppercase tracking-widest text-stone-500">
                      Adresse email
                    </label>
                    <select
                      value={editEmailAddress}
                      onChange={(e) => setEditEmailAddress(e.target.value)}
                      className="bg-stone-950 border border-stone-700 rounded-lg px-2 py-1 text-xs text-stone-200 focus:outline-none focus:border-orange-600"
                    >
                      <option value="piloubruce@gmail.com">piloubruce@gmail.com</option>
                      <option value="piloubruce@free.fr">piloubruce@free.fr</option>
                    </select>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={handleCloseEdit}
                className="px-4 py-2 text-sm text-stone-400 hover:text-stone-200"
              >
                Annuler
              </button>
              <button
                onClick={() => handleUpdate(editingJob.id, editingJob)}
                disabled={busy}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-500 disabled:opacity-50"
              >
                Sauvegarder
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-end justify-between border-b border-stone-800 pb-6">
        <div>
          <h1 className="text-5xl font-serif text-stone-100">Planification.</h1>
          <p className="text-stone-500 mt-2">Tâches automatisées récurrentes (tâches Cron Hermès réelles).</p>
        </div>
        <div className="flex gap-2">
        <button
          className="flex items-center px-4 py-2 bg-orange-600 text-white rounded-xl hover:bg-orange-500 transition-colors text-sm font-medium"
          onClick={() => setModalOpen(true)}
          title="Créer une tâche cron Hermès réelle"
        >
          <Plus className="w-4 h-4 mr-1" /> Nouvelle tâche
        </button>
        <button
          className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-500 transition-colors text-sm font-medium"
          onClick={() => setAssistantOpen(true)}
          title="Utiliser l'assistant visuel de création cron"
        >
          <HelpCircle className="w-4 h-4 mr-1" /> Assistant
        </button>
      </div>
      </div>

      {loading && <p className="text-stone-500 text-sm">Chargement…</p>}

      {!loading && cronJobs.length === 0 ? (
        <div className="text-center text-stone-600 py-16">
          <Clock className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Aucune tâche planifiée.</p>
          {!connected && <p className="text-xs mt-1 text-stone-700">API indisponible.</p>}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-6 mb-8">
            <div className="bg-stone-900 border border-stone-800 rounded-2xl p-6">
              <div className="text-4xl font-serif text-stone-200">{cronJobs.length}</div>
              <div className="text-[10px] uppercase tracking-widest text-stone-500 mt-1">Tâches actives</div>
            </div>
            <div className="bg-stone-900 border border-stone-800 rounded-2xl p-6">
              <div className="text-4xl font-serif text-stone-200">
                {cronJobs.filter((j) => j.enabled !== false).length}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-stone-500 mt-1">Activées</div>
            </div>
            <div className="bg-stone-900 border border-stone-800 rounded-2xl p-6">
              <div className="text-4xl font-serif text-stone-200">
                {cronJobs.filter((j) => j.last_status === 'ok').length}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-stone-500 mt-1">Dernier run OK</div>
            </div>
          </div>

          <div className="space-y-4">
            {cronJobs.map((job) => (
              <React.Fragment key={job.id}>
                <div className="bg-stone-900 border border-stone-800 rounded-2xl p-6 flex flex-col sm:flex-row gap-6 transition-all hover:border-stone-700">
                  <div className="sm:w-1/4 shrink-0">
                    <div className="flex items-center space-x-2 text-orange-500 mb-2">
                      <Clock className="w-4 h-4" />
                      <span className="font-mono text-sm">{displaySchedule(job)}</span>
                    </div>
                    <div className="text-xs text-stone-500">Prochaine exécution :</div>
                    <div className="text-xs text-stone-400 font-mono">{job.next_run || '—'}</div>
                    <div className="text-xs text-stone-500 mt-2">Dernier run :</div>
                    <div className="text-xs text-stone-400 font-mono">{job.last_run || '—'}</div>
                  </div>

                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-medium text-stone-200 mb-1">{job.name}</h3>
                      {job.enabled === false && (
                        <span className="text-[10px] uppercase tracking-widest text-stone-500 border border-stone-700 rounded px-1.5 py-0.5">paused</span>
                      )}
                      {job.profile && (
                        <span className="text-[10px] uppercase tracking-widest text-stone-400 border border-stone-700 rounded px-1.5 py-0.5">{job.profile}</span>
                      )}
                    </div>
                    <p className="text-sm text-stone-400 max-h-20 overflow-y-auto pr-1 leading-relaxed">{job.description}</p>
                  </div>

                  <div className="flex items-center sm:flex-col sm:justify-center gap-3 border-t sm:border-t-0 sm:border-l border-stone-800 pt-4 sm:pt-0 sm:pl-6">
                    <button
                      onClick={() => handleEdit(job)}
                      disabled={busy}
                      title="Editer"
                      className="p-2 rounded-lg text-stone-400 hover:text-orange-500 hover:bg-stone-800 transition-colors disabled:opacity-50"
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleRun(job)}
                      disabled={busy}
                      title="Executer maintenant"
                      className="p-2 rounded-lg text-stone-400 hover:text-green-500 hover:bg-stone-800 transition-colors disabled:opacity-50"
                    >
                      <Play className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(job)}
                      disabled={busy}
                      title="Supprimer"
                      className="p-2 rounded-lg text-red-400 hover:text-red-300 hover:bg-stone-800 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => toggleLogs(job.id)}
                      title="Voir les logs d'execution"
                      className="p-2 rounded-lg text-stone-400 hover:text-blue-500 hover:bg-stone-800 transition-colors"
                    >
                      <History className="w-4 h-4" />
                    </button>
                    <span
                      className={`text-[10px] uppercase tracking-widest px-2 py-0.5 rounded ${
                        job.last_status === 'ok'
                          ? 'text-emerald-400 bg-emerald-900/20'
                          : job.last_status
                          ? 'text-red-400 bg-red-900/20'
                          : 'text-stone-500 bg-stone-800/50'
                      }`}
                    >
                      {job.last_status || 'n/a'}
                    </span>
                  </div>
                </div>
                
                {/* Feature 1: Cron Execution Logs - expandible sous chaque job */}
                {showLogs[job.id] && (
                  <div className="px-6 pb-4">
                    <CronLogsDisplay jobId={job.id} maxLogs={5} />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
