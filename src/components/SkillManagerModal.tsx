import React, { useEffect, useMemo, useState } from 'react';
import {
  getAgentSkills,
  toggleAgentSkill,
  type AgentSkill,
} from '../api';
import { Check, Loader2, Search, X } from 'lucide-react';

interface Props {
  agent: string | null;
  open: boolean;
  onClose: () => void;
}

export const SkillManagerModal: React.FC<Props> = ({ agent, open, onClose }) => {
  const [skills, setSkills] = useState<AgentSkill[] | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  // Fetch the skill list every time the modal opens (fresh state).
  useEffect(() => {
    if (!open || !agent) return;
    let cancelled = false;
    setSkills(null);
    setFilter('');
    setErr(null);
    getAgentSkills(agent)
      .then((data) => {
        if (!cancelled) setSkills(data.skills ?? []);
      })
      .catch(() => {
        if (!cancelled) setErr('lecture des skills impossible');
      });
    return () => {
      cancelled = true;
    };
  }, [open, agent]);

  const activeCount = useMemo(
    () => (skills ? skills.filter((s) => s.enabled).length : 0),
    [skills],
  );

  const displayed = useMemo(() => {
    if (!skills) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => s.name.toLowerCase().includes(q));
  }, [skills, filter]);

  const toggle = async (skill: AgentSkill) => {
    if (!agent) return;
    const next = !skill.enabled;
    setBusy((prev) => new Set(prev).add(skill.name));
    setErr(null);
    try {
      const res = await toggleAgentSkill(agent, skill.name, next);
      if (!res.ok) {
        setErr(res.error || `échec du toggle pour ${skill.name}`);
        return;
      }
      // Authoritative state: the backend returns the full disabled list.
      const disabled = new Set(res.disabled ?? []);
      setSkills((prev) =>
        prev
          ? prev.map((s) => ({ ...s, enabled: !disabled.has(s.name) }))
          : prev,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'erreur réseau');
    } finally {
      setBusy((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(skill.name);
        return nextSet;
      });
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-stone-800 bg-stone-950 shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-base font-medium text-stone-200">
            Skills — {agent}
          </span>
          <button
            onClick={onClose}
            className="text-stone-500 hover:text-stone-300 text-xs"
          >
            fermer
          </button>
        </div>

        <p className="text-[10px] text-stone-500 mb-4">
          Active ou désactive les skills de cet agent (sécurité si le manager ne
          les a pas activés).
        </p>

        {err && <p className="text-xs text-red-400 mb-2">{err}</p>}

        {!skills ? (
          <p className="text-xs text-stone-500 py-6 text-center">Chargement…</p>
        ) : (
          <>
            {/* Search + counter */}
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-600" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="filtrer par nom…"
                  className="w-full bg-stone-900 border border-stone-800 text-stone-200 rounded-lg pl-8 pr-7 py-2 text-sm focus:outline-none focus:border-orange-500"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
                    title="effacer le filtre"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <span className="shrink-0 text-[10px] text-stone-500 whitespace-nowrap">
                {activeCount} actifs / {skills.length} total
              </span>
            </div>

            {/* Skill list */}
            <div className="max-h-[50vh] overflow-y-auto space-y-1 pr-1">
              {displayed.map((s) => {
                const toggling = busy.has(s.name);
                return (
                  <label
                    key={s.name}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors border ${
                      s.enabled
                        ? 'border-emerald-900/40 bg-emerald-950/20'
                        : 'border-transparent hover:bg-stone-900'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={toggling}
                      onChange={() => toggle(s)}
                      className="h-4 w-4 rounded border-stone-600 bg-stone-800 text-emerald-500 focus:ring-emerald-500 disabled:opacity-50"
                    />
                    <span className="flex-1 min-w-0">
                      <span
                        className={`text-sm truncate block ${
                          s.enabled ? 'text-stone-200' : 'text-stone-500'
                        }`}
                      >
                        {s.name}
                      </span>
                    </span>
                    {toggling ? (
                      <Loader2 className="w-3.5 h-3.5 text-stone-500 animate-spin shrink-0" />
                    ) : s.enabled ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1 shrink-0">
                        <Check className="w-3 h-3" /> actif
                      </span>
                    ) : (
                      <span className="text-[10px] text-stone-600 uppercase tracking-wider shrink-0">
                        inactif
                      </span>
                    )}
                  </label>
                );
              })}
              {displayed.length === 0 && (
                <p className="text-[10px] text-stone-600 py-3 text-center">
                  {filter
                    ? 'Aucun skill ne correspond au filtre.'
                    : 'Aucun skill installé pour cet agent.'}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
