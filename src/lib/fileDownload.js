const CONTENT_DISPOSITION_FILENAME_STAR = /filename\*=UTF-8''([^;]+)/i;
const CONTENT_DISPOSITION_FILENAME = /filename="?([^"]+)"?/i;

const decodeFilename = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const parseDownloadFilename = (contentDisposition = '') => {
  const header = String(contentDisposition || '').trim();
  if (!header) return '';
  const utf8Match = header.match(CONTENT_DISPOSITION_FILENAME_STAR);
  if (utf8Match?.[1]) {
    return decodeFilename(utf8Match[1]);
  }
  const basicMatch = header.match(CONTENT_DISPOSITION_FILENAME);
  if (basicMatch?.[1]) {
    return decodeFilename(basicMatch[1]);
  }
  return '';
};

const guessFilenameFromUrl = (input) => {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const resolved = new URL(raw, window.location.origin);
    const parts = resolved.pathname.split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1] || '';
    return decodeFilename(lastPart);
  } catch {
    const parts = raw.split('/').filter(Boolean);
    return decodeFilename(parts[parts.length - 1] || '');
  }
};

export async function downloadFileWithAuth(url, { authToken = '', filename = '', headers = {} } = {}) {
  const safeUrl = String(url || '').trim();
  if (!safeUrl) {
    throw new Error('Missing download URL');
  }

  const requestHeaders = new Headers(headers || {});
  const safeToken = String(authToken || '').trim();
  if (safeToken && !requestHeaders.has('Authorization')) {
    requestHeaders.set('Authorization', `Bearer ${safeToken}`);
  }

  const response = await window.fetch(safeUrl, {
    method: 'GET',
    headers: requestHeaders,
  });

  if (!response.ok) {
    let errorMessage = '';
    try {
      const payload = await response.clone().json();
      errorMessage = String(payload?.error || '').trim();
    } catch {
      errorMessage = '';
    }
    if (!errorMessage) {
      try {
        errorMessage = String(await response.text()).trim();
      } catch {
        errorMessage = '';
      }
    }
    throw new Error(errorMessage || `Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const objectUrl = window.URL.createObjectURL(blob);
  const resolvedFilename =
    parseDownloadFilename(response.headers.get('content-disposition')) ||
    String(filename || '').trim() ||
    guessFilenameFromUrl(safeUrl) ||
    'download';

  const link = window.document.createElement('a');
  link.href = objectUrl;
  link.download = resolvedFilename;
  link.style.display = 'none';
  window.document.body.appendChild(link);
  link.click();
  window.document.body.removeChild(link);
  window.setTimeout(() => {
    window.URL.revokeObjectURL(objectUrl);
  }, 1000);

  return {
    filename: resolvedFilename,
    contentType: String(response.headers.get('content-type') || '').trim(),
  };
}
