import React from 'react';

export type Mode = 'interval' | 'weekly' | 'everyn' | 'once';

export interface ScheduleEditorState {
  mode: Mode;
  ivHours: number;
  ivMinutes: number;
  days: number[];
  atHour: number;
  atMinute: number;
  everyN: number;
  onceAt: string;
}

export const DEFAULT_SCHEDULE_STATE: ScheduleEditorState = {
  mode: 'interval',
  ivHours: 0,
  ivMinutes: 30,
  days: [1],
  atHour: 9,
  atMinute: 0,
  everyN: 2,
  onceAt: '',
};

export const DAYS: { key: number; label: string }[] = [
  { key: 1, label: 'Lun' },
  { key: 2, label: 'Mar' },
  { key: 3, label: 'Mer' },
  { key: 4, label: 'Jeu' },
  { key: 5, label: 'Ven' },
  { key: 6, label: 'Sam' },
  { key: 7, label: 'Dim' },
];

const range = (a: number, b: number) => {
  const out: number[] = [];
  for (let n = a; n <= b; n++) out.push(n);
  return out;
};

const pad = (n: number) => String(n).padStart(2, '0');

// Parse une expression cron existante pour pré-remplir l'interface
export const parseCron = (schedule?: string): ScheduleEditorState => {
  const s = (schedule || '').trim();
  // Intervalle : "30m", "120m", "2h", "1h30m"
  const iv = s.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (iv && (iv[1] !== undefined || iv[2] !== undefined)) {
    const total = parseInt(iv[1] || '0', 10) * 60 + parseInt(iv[2] || '0', 10);
    return {
      ...DEFAULT_SCHEDULE_STATE,
      mode: 'interval',
      ivHours: Math.floor(total / 60),
      ivMinutes: total % 60,
    };
  }
  // Cron standard : "0 */6 * * *" -> toutes les 6h
  const step = s.match(/^0 \*\/(\d+) \* \* \*$/);
  if (step) {
    const hours = parseInt(step[1], 10);
    return {
      ...DEFAULT_SCHEDULE_STATE,
      mode: 'interval',
      ivHours: hours,
      ivMinutes: 0,
    };
  }
  // Cron standard : "0 9 * * *" -> quotidien à 9h00
  const daily = s.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) {
    return {
      ...DEFAULT_SCHEDULE_STATE,
      mode: 'weekly',
      days: [1, 2, 3, 4, 5, 6, 7],
      atHour: parseInt(daily[2], 10),
      atMinute: parseInt(daily[1], 10),
    };
  }
  // Hebdomadaire : "0 9 * * 1,2,3" ou "0 9 * * *"
  const wk = s.match(/^(\d{1,2}) (\d{1,2}) \* \* ([\d,*]+)$/);
  if (wk) {
    const days = wk[3] === '*' ? [1, 2, 3, 4, 5, 6, 7] : wk[3].split(',').map(Number);
    return {
      ...DEFAULT_SCHEDULE_STATE,
      mode: 'weekly',
      days,
      atHour: parseInt(wk[2], 10),
      atMinute: parseInt(wk[1], 10),
    };
  }
  // Tous les N jours : "0 9 */2 * *"
  const en = s.match(/^(\d{1,2}) (\d{1,2}) \*\/(\d{1,2}) \* \*$/);
  if (en) {
    return {
      ...DEFAULT_SCHEDULE_STATE,
      mode: 'everyn',
      atHour: parseInt(en[2], 10),
      atMinute: parseInt(en[1], 10),
      everyN: Math.min(Math.max(parseInt(en[3], 10), 2), 30),
    };
  }
  // Date unique : "2026-08-08T14:30" (format ISO local)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    return { ...DEFAULT_SCHEDULE_STATE, mode: 'once', onceAt: s.slice(0, 16) };
  }
  // Par défaut : intervalle 0h30
  return { ...DEFAULT_SCHEDULE_STATE };
};

// Reconstruction de l'expression cron à partir des états
export const buildCron = (state: ScheduleEditorState): { ok: boolean; value: string; error?: string } => {
  if (state.mode === 'interval') {
    const total = state.ivHours * 60 + state.ivMinutes;
    if (total <= 0) return { ok: false, value: '', error: "L'intervalle doit être supérieur à 0." };
    return { ok: true, value: `${total}m` };
  }
  if (state.mode === 'weekly') {
    if (state.days.length === 0) return { ok: false, value: '', error: 'Sélectionnez au moins un jour.' };
    const dow = state.days.length === 7 ? '*' : [...state.days].sort((a, b) => a - b).join(',');
    return { ok: true, value: `${state.atMinute} ${state.atHour} * * ${dow}` };
  }
  if (state.mode === 'everyn') {
    if (state.everyN < 2 || state.everyN > 30) return { ok: false, value: '', error: 'N doit être entre 2 et 30.' };
    return { ok: true, value: `${state.atMinute} ${state.atHour} */${state.everyN} * *` };
  }
  if (!state.onceAt) return { ok: false, value: '', error: 'Choisissez une date et une heure.' };
  return { ok: true, value: state.onceAt.slice(0, 16) };
};

interface ScheduleEditorProps {
  state: ScheduleEditorState;
  onChange: (state: Partial<ScheduleEditorState>) => void;
  showPreview?: boolean;
}

const inputCls = 'w-full bg-stone-950 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-200 focus:outline-none focus:border-orange-600';
const labelCls = 'text-xs text-stone-500';

export const ScheduleEditor: React.FC<ScheduleEditorProps> = ({ state, onChange, showPreview = true }) => {
  const { mode, ivHours, ivMinutes, days, atHour, atMinute, everyN, onceAt } = state;
  const preview = buildCron(state);

  const modeBtn = (m: Mode, label: string) => (
    <button
      key={m}
      type="button"
      onClick={() => onChange({ mode: m })}
      className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
        mode === m
          ? 'border-orange-600 text-orange-400 bg-orange-900/20'
          : 'border-stone-800 text-stone-400 hover:border-stone-700'
      }`}
    >
      {label}
    </button>
  );

  const toggleDay = (d: number) =>
    onChange({ days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] });

  return (
    <div className="space-y-3">
      <label className={labelCls}>Planification</label>
      <div className="flex flex-wrap gap-2 mb-2">
        {modeBtn('interval', 'Intervalle')}
        {modeBtn('weekly', 'Jours de la semaine')}
        {modeBtn('everyn', 'Tous les N jours')}
        {modeBtn('once', 'Date unique')}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {mode === 'interval' && (
          <>
            <div>
              <label className={labelCls}>Heures</label>
              <select
                value={ivHours}
                onChange={(e) => onChange({ ivHours: Number(e.target.value) })}
                className={inputCls}
              >
                {range(0, 23).map((h) => (
                  <option key={h} value={h}>
                    {h} h
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Minutes</label>
              <select
                value={ivMinutes}
                onChange={(e) => onChange({ ivMinutes: Number(e.target.value) })}
                className={inputCls}
              >
                {range(0, 59).map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {mode === 'weekly' && (
          <>
            <div className="sm:col-span-2">
              <label className={labelCls}>Jours</label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {DAYS.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => toggleDay(d.key)}
                    className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
                      days.includes(d.key)
                        ? 'border-orange-600 text-orange-400 bg-orange-900/20'
                        : 'border-stone-800 text-stone-400 hover:border-stone-700'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={labelCls}>Heure</label>
              <select
                value={atHour}
                onChange={(e) => onChange({ atHour: Number(e.target.value) })}
                className={inputCls}
              >
                {range(0, 23).map((h) => (
                  <option key={h} value={h}>
                    {pad(h)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Minute</label>
              <select
                value={atMinute}
                onChange={(e) => onChange({ atMinute: Number(e.target.value) })}
                className={inputCls}
              >
                {range(0, 59).map((m) => (
                  <option key={m} value={m}>
                    {pad(m)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {mode === 'everyn' && (
          <>
            <div>
              <label className={labelCls}>Tous les N jours</label>
              <select
                value={everyN}
                onChange={(e) => onChange({ everyN: Number(e.target.value) })}
                className={inputCls}
              >
                {range(2, 30).map((n) => (
                  <option key={n} value={n}>
                    {n} jours
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Heure</label>
              <select
                value={atHour}
                onChange={(e) => onChange({ atHour: Number(e.target.value) })}
                className={inputCls}
              >
                {range(0, 23).map((h) => (
                  <option key={h} value={h}>
                    {pad(h)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Minute</label>
              <select
                value={atMinute}
                onChange={(e) => onChange({ atMinute: Number(e.target.value) })}
                className={inputCls}
              >
                {range(0, 59).map((m) => (
                  <option key={m} value={m}>
                    {pad(m)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {mode === 'once' && (
          <div className="sm:col-span-2">
            <label className={labelCls}>Date et heure</label>
            <input
              type="datetime-local"
              value={onceAt}
              onChange={(e) => onChange({ onceAt: e.target.value })}
              className={inputCls}
            />
          </div>
        )}
      </div>

      {showPreview && (
        <div className="mt-1 text-xs text-stone-500">
          Expression générée :{' '}
          <span className={preview.ok ? 'text-orange-400' : 'text-red-400'}>
            {preview.ok ? preview.value : preview.error || '...'}
          </span>
        </div>
      )}
    </div>
  );
};