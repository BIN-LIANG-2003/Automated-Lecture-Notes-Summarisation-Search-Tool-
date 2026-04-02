export const copyTextToClipboard = async (value) => {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error('Nothing to copy');
  }
  await navigator.clipboard.writeText(text);
  return text;
};
