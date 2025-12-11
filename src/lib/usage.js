export const USAGE_KEY = 'usageByDate';

export const loadUsageMap = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const persistUsageMap = (map) => {
  localStorage.setItem(USAGE_KEY, JSON.stringify(map));
};
