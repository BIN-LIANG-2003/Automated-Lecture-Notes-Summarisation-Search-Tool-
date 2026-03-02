export const WORKSPACES_STORE_KEY = 'workspaceStateByAccount';

const normalizeName = (value) => String(value || '').trim();

const keyForAccount = (accountName) => {
  const name = normalizeName(accountName);
  return name || '__guest__';
};

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

export const createWorkspace = (accountName, overrides = {}) => {
  const owner = normalizeName(accountName) || '访客';
  const now = new Date().toISOString();
  return {
    id: overrides.id || `ws-${Date.now()}-${randomSuffix()}`,
    name: normalizeName(overrides.name) || `${owner} 的工作空间`,
    plan: normalizeName(overrides.plan) || '免费版',
    members: Array.isArray(overrides.members) && overrides.members.length
      ? Array.from(new Set(overrides.members.map((item) => normalizeName(item)).filter(Boolean)))
      : [owner],
    invites: Array.isArray(overrides.invites)
      ? Array.from(new Set(overrides.invites.map((item) => normalizeName(item).toLowerCase()).filter(Boolean)))
      : [],
    createdAt: overrides.createdAt || now,
  };
};

const loadStore = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACES_STORE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const persistStore = (store) => {
  localStorage.setItem(WORKSPACES_STORE_KEY, JSON.stringify(store));
};

const normalizeWorkspaceEntry = (entry, accountName) => {
  if (!entry || typeof entry !== 'object') return null;
  const list = Array.isArray(entry.workspaces) ? entry.workspaces : [];
  const workspaces = list
    .map((item) => createWorkspace(accountName, item))
    .filter((item, idx, arr) => arr.findIndex((row) => row.id === item.id) === idx);
  if (!workspaces.length) return null;
  const activeWorkspaceId = workspaces.some((item) => item.id === entry.activeWorkspaceId)
    ? entry.activeWorkspaceId
    : workspaces[0].id;
  return { activeWorkspaceId, workspaces };
};

const createDefaultWorkspaceState = (accountName) => {
  const workspace = createWorkspace(accountName);
  return { activeWorkspaceId: workspace.id, workspaces: [workspace] };
};

export const loadWorkspaceState = (accountName) => {
  const store = loadStore();
  const accountKey = keyForAccount(accountName);
  const normalized = normalizeWorkspaceEntry(store[accountKey], accountName);
  if (normalized) {
    store[accountKey] = normalized;
    persistStore(store);
    return normalized;
  }

  const fallback = createDefaultWorkspaceState(accountName);
  store[accountKey] = fallback;
  persistStore(store);
  return fallback;
};

export const persistWorkspaceState = (accountName, state) => {
  const accountKey = keyForAccount(accountName);
  const store = loadStore();
  const normalized = normalizeWorkspaceEntry(state, accountName) || createDefaultWorkspaceState(accountName);
  store[accountKey] = normalized;
  persistStore(store);
  return normalized;
};

