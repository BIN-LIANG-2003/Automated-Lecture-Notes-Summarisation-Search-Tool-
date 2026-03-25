const SOURCE_LABEL_MAP = {
  huggingface: 'Hugging Face',
  fallback: 'Fallback',
  cache: 'Cache',
};

const toInteger = (value, fallback = 0, minValue = 0) => {
  const num = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(minValue, num);
};

const toFloat = (value, fallback = 0) => {
  const num = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(num) ? num : fallback;
};

const sourceLabel = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return SOURCE_LABEL_MAP[key] || (key || 'Unknown');
};

export const buildSummaryDiagnostics = (analysisResult) => {
  if (!analysisResult || typeof analysisResult !== 'object') return [];
  const options = analysisResult.options_used && typeof analysisResult.options_used === 'object'
    ? analysisResult.options_used
    : {};
  const diagnostics = [];

  const summarySource = sourceLabel(analysisResult.summary_source);
  diagnostics.push({
    key: 'source',
    label: 'Source',
    value: analysisResult.cache_hit ? `${summarySource} (cache hit)` : summarySource,
  });

  const model = String(options.summarizer_model || '').trim();
  if (model) {
    diagnostics.push({
      key: 'model',
      label: 'Model',
      value: model,
    });
  }

  const wordCount = toInteger(options.text_word_count, 0, 0);
  const charCount = toInteger(options.text_char_count, 0, 0);
  if (wordCount > 0 || charCount > 0) {
    diagnostics.push({
      key: 'input',
      label: 'Input Size',
      value: `${wordCount || 0} words${charCount > 0 ? ` / ${charCount} chars` : ''}`,
    });
  }

  const chunkCount = toInteger(options.chunk_count, 1, 1);
  const mergeRounds = toInteger(options.merge_rounds, 0, 0);
  diagnostics.push({
    key: 'chunks',
    label: 'Chunking',
    value: `${chunkCount} chunk${chunkCount > 1 ? 's' : ''}${mergeRounds ? `, ${mergeRounds} merge round${mergeRounds > 1 ? 's' : ''}` : ''}`,
  });

  if (options.refreshed_from_file) {
    diagnostics.push({
      key: 'refresh',
      label: 'Document Text',
      value: 'Refreshed from source file',
    });
  }

  const extractor = String(options.pdf_extractor || '').trim();
  const ocrAttempted = Boolean(options.pdf_ocr_attempted);
  const ocrUsed = Boolean(options.pdf_ocr_used);
  if (extractor || ocrAttempted) {
    let pipelineLabel = extractor || 'Default parser';
    if (ocrAttempted) {
      pipelineLabel += ocrUsed ? ' + OCR fallback' : ' (OCR checked)';
    }
    diagnostics.push({
      key: 'pdf-pipeline',
      label: 'PDF Pipeline',
      value: pipelineLabel,
    });
  }

  const qualityBefore = toFloat(options.pdf_quality_score_before, 0);
  const qualityAfter = toFloat(options.pdf_quality_score_after, 0);
  if (qualityBefore > 0 || qualityAfter > 0) {
    const beforeLabel = qualityBefore > 0 ? qualityBefore.toFixed(2) : '--';
    const afterLabel = qualityAfter > 0 ? qualityAfter.toFixed(2) : '--';
    diagnostics.push({
      key: 'pdf-quality',
      label: 'PDF Text Quality',
      value: `${beforeLabel} -> ${afterLabel}`,
    });
  }

  return diagnostics;
};

export const formatSummaryErrorMessage = (payload) => {
  const baseError = String(payload?.error || 'Service error').trim() || 'Service error';
  const details = payload?.details && typeof payload.details === 'object' ? payload.details : {};
  const fileType = String(details.file_type || '').trim().toLowerCase();
  const textSource = String(details.text_source || '').trim().toLowerCase();
  const extractionError = String(details.file_extraction_error || '').trim();
  const attemptedExtraction = Boolean(details.attempted_file_extraction);

  const hints = [];
  if (fileType === 'pdf') {
    if (attemptedExtraction && extractionError) {
      hints.push(`PDF extract detail: ${extractionError}`);
    } else if (textSource === 'empty' || attemptedExtraction) {
      hints.push('If this is a scanned PDF, OCR fallback must be available on the server. Try Rebuild after deployment.');
    }
  } else if (fileType === 'docx' || fileType === 'txt') {
    if (attemptedExtraction && extractionError) {
      hints.push(`File extract detail: ${extractionError}`);
    } else if (textSource === 'empty') {
      hints.push('The server could not read text from the source file. Re-upload or open the note and save content once.');
    }
  } else if (fileType && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(fileType)) {
    hints.push('Run OCR first, then summarize the extracted text.');
  }

  return [baseError, ...hints].filter(Boolean).join(' ');
};
