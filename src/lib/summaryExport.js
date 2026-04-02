export const buildSummaryExportText = (analysisResult) => {
  if (!analysisResult) return '';
  const keywords = Array.isArray(analysisResult.keywords) ? analysisResult.keywords : [];
  const keySentences = Array.isArray(analysisResult.key_sentences)
    ? analysisResult.key_sentences
    : [];
  const blocks = [
    `Summary:\n${analysisResult.summary || ''}`,
    `Keywords:\n${keywords.length ? keywords.join(', ') : 'N/A'}`,
    `Key Sentences:\n${keySentences.length ? keySentences.join('\n') : 'N/A'}`,
    `Source:\n${analysisResult.summary_source || 'fallback'}`,
  ];
  if (analysisResult.summary_note) {
    blocks.push(`Note:\n${analysisResult.summary_note}`);
  }
  return blocks.join('\n\n').trim();
};

export const downloadTextFile = (filename, content) => {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
