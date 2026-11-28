/** Default behavior detaches the whole baseline. Explicit immutable top-level
 * fields may share read-only objects until a delta touches them. */
export function projectViewChanges(before, changes, immutableTopLevelFields = []) {
  const unsafe = key => key === '__proto__' || key === 'constructor' || key === 'prototype';
  if (!Array.isArray(immutableTopLevelFields) || immutableTopLevelFields.length > 16 || immutableTopLevelFields.some(key => typeof key !== 'string' || unsafe(key))) throw new Error('INVALID_DELTA');
  const shared = new Set();
  let result;
  if (immutableTopLevelFields.length && before !== null && typeof before === 'object' && !Array.isArray(before)) {
    const dynamic = { ...before };
    for (const key of immutableTopLevelFields) if (Object.hasOwn(dynamic, key)) { shared.add(key); delete dynamic[key]; }
    result = structuredClone(dynamic);
    for (const key of shared) result[key] = before[key];
  } else result = structuredClone(before);
  for (const change of changes) {
    if (!Array.isArray(change.path) || change.path.some(key => unsafe(key) || typeof key !== 'string' && !(typeof key === 'number' && Number.isSafeInteger(key) && key >= 0))) throw new Error('INVALID_DELTA');
    if (!change.path.length) { result = structuredClone(change.value); shared.clear(); continue; }
    const first = change.path[0];
    if (shared.has(first)) { if (change.path.length > 1) result[first] = structuredClone(result[first]); shared.delete(first); }
    let parent = result;
    for (const key of change.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('INVALID_DELTA');
      parent = parent[key];
    }
    const key = change.path.at(-1);
    if (!parent || typeof parent !== 'object') throw new Error('INVALID_DELTA');
    if (change.remove) delete parent[key]; else parent[key] = structuredClone(change.value);
  }
  return result;
}
