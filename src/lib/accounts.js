export const ACCOUNTS_KEY = 'accounts';

export const loadAccounts = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    console.warn('Failed to parse accounts from localStorage', err);
  }
  return [];
};

export const persistAccounts = (accounts) => {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
};
