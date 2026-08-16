// Centralized date/time formatting for the Mission Control dashboard.
//
// ALL timestamps are rendered in France local time (Europe/Paris) regardless
// of the viewer's browser timezone. Europe/Paris natively handles DST
// (CEST = UTC+2 in summer, CET = UTC+1 in winter), so no manual offset math.

const TZ = 'Europe/Paris';

// Format a UNIX epoch (seconds) as "DD/MM/YYYY HH:MM" in France time.
export function formatEpoch(tsSeconds: number): string {
  try {
    return new Date(tsSeconds * 1000).toLocaleString('fr-FR', {
      timeZone: TZ,
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// Format a UNIX epoch (seconds) as "DD/MM/YYYY" (date only) in France time.
export function formatEpochDate(tsSeconds: number): string {
  try {
    return new Date(tsSeconds * 1000).toLocaleDateString('fr-FR', {
      timeZone: TZ,
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
  } catch {
    return '';
  }
}

// Format a UNIX epoch (seconds) as "DD/MM HH:MM" (compact) in France time.
export function formatEpochShort(tsSeconds: number): string {
  try {
    return new Date(tsSeconds * 1000).toLocaleString('fr-FR', {
      timeZone: TZ,
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// Format an arbitrary date-like value (ISO string, epoch ms Date, or number)
// as "DD/MM HH:MM" in France time. Accepts ISO strings such as
// "2026-07-19T23:15:35Z" (UTC) and renders them in Europe/Paris.
export function formatAny(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString('fr-FR', {
      timeZone: TZ,
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}
