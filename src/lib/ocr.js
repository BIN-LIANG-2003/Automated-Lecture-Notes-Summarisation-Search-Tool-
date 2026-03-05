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
