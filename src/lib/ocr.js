const OCR_CANDIDATE_KEYS = [
  'text',
  'ocr_text',
  'extracted_text',
  'result',
  'content',
  'generated_text',
  'output_text',
  'prediction',
  'predictions',
  'value',
  'data',
  'lines',
  'texts',
];

export const coerceOcrText = (payload, depth = 0) => {
  if (depth > 5 || payload == null) return '';

  if (typeof payload === 'string') return payload.trim();
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload).trim();

  if (Array.isArray(payload)) {
    const parts = payload
      .map((item) => coerceOcrText(item, depth + 1))
      .filter(Boolean);
    return parts.join('\n').trim();
  }

  if (typeof payload === 'object') {
    for (const key of OCR_CANDIDATE_KEYS) {
      if (!(key in payload)) continue;
      const text = coerceOcrText(payload[key], depth + 1);
      if (text) return text;
    }

    if (Array.isArray(payload.choices)) {
      const parts = payload.choices
        .map((choice) => {
          if (!choice || typeof choice !== 'object') return '';
          if (choice.message && typeof choice.message === 'object') {
            return coerceOcrText(choice.message.content, depth + 1);
          }
          return coerceOcrText(choice.text, depth + 1);
        })
        .filter(Boolean);
      if (parts.length) return parts.join('\n').trim();
    }
  }

  return '';
};

const looksLikeHtmlError = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return text.startsWith('<!doctype html') || text.startsWith('<html') || text.includes('<html');
};

const normalizeOcrErrorPart = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!looksLikeHtmlError(text)) return text;
  if (text.includes('410')) {
    return 'Hugging Face OCR endpoint returned 410 Gone. The configured OCR model or inference endpoint is unavailable.';
  }
  return 'Hugging Face OCR endpoint returned an HTML error page instead of JSON.';
};

export const formatOcrErrorMessage = (payload) => {
  const details = payload?.details && typeof payload.details === 'object' ? payload.details : {};
  const runtimeHints = Array.isArray(details?.runtime?.hints)
    ? details.runtime.hints
    : [];
  const parts = [
    payload?.error,
    details?.external,
    details?.huggingface,
    details?.local,
    ...runtimeHints,
  ]
    .map(normalizeOcrErrorPart)
    .filter(Boolean);

  const deduped = [];
  const seen = new Set();
  parts.forEach((part) => {
    const key = part.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(part);
  });
  return deduped.join(' | ').trim() || 'Service error';
};
