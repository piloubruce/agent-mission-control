// Unified model filtering logic: Inclusion, -Exclusion (case-insensitive)
// Usage: filterModels(models, filterString)
// - filterString: comma-separated terms; prefix with '-' to exclude
// - Each model is matched against model.id and model.provider

export type ModelFilterItem = {
  id: string;
  provider?: string;
  display?: string;
  description?: string;
};

export function filterModels<T extends ModelFilterItem>(models: T[], filter: string): T[] {
  const q = filter.trim();
  if (!q) return models;

  const terms = q.split(/\s*,\s*/);
  const inclusions: string[] = [];
  const exclusions: string[] = [];

  for (const t of terms) {
    if (t.startsWith('-')) {
      exclusions.push(t.slice(1).toLowerCase());
    } else if (t.length > 0) {
      inclusions.push(t.toLowerCase());
    }
  }

  const lower = (s: string) => (s || '').toLowerCase();

  return models.filter((m) => {
    const modelStr = lower(m.id);
    const providerStr = lower((m.provider as string) ?? '');

    // Step 1: Negative filter (exclusions)
    for (const ex of exclusions) {
      if (modelStr.includes(ex) || providerStr.includes(ex)) {
        return false;
      }
    }

    // Step 2: Positive filter (inclusions)
    if (inclusions.length === 0) return true;
    for (const inc of inclusions) {
      if (modelStr.includes(inc) || providerStr.includes(inc)) {
        return true;
      }
    }
    return false;
  });
}

