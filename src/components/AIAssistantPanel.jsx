export default function AIAssistantPanel({
  allowAiTools = true,
  allowOcr = true,
  allowExport = true,
  aiImageInputRef,
  onAIImageChange,
  onOpenAIImagePicker,
  onAnalyzeText,
  onCopySummary,
  onExportSummary,
  onEmailSummary,
  isExtracting = false,
  isAnalyzing = false,
  extractedText = '',
  onChangeExtractedText,
  analysisResult = null,
}) {
  if (!allowAiTools) {
    return (
      <section id="ai-section" className="notion-ai-section">
        <article className="notion-ai-shell">
          <p className="muted">AI tools are disabled in this workspace settings.</p>
        </article>
      </section>
    );
  }

  return (
    <section id="ai-section" className="notion-ai-section">
      <article className="notion-ai-shell" aria-live="polite">
        <input
          ref={aiImageInputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={onAIImageChange}
        />

        <div className="notion-ai-actions-simple">
          <button
            type="button"
            className="btn notion-ai-action-chip"
            onClick={onOpenAIImagePicker}
            disabled={isExtracting || !allowOcr}
          >
            {!allowOcr
              ? 'OCR Disabled'
              : isExtracting
                ? 'Running image OCR...'
                : 'Image OCR'}
          </button>
          <button
            type="button"
            className="btn btn-primary notion-ai-action-chip"
            onClick={onAnalyzeText}
            disabled={isAnalyzing || !String(extractedText || '').trim()}
          >
            {isAnalyzing ? 'Summarizing text...' : 'Summarize Text'}
          </button>
        </div>

        {(extractedText || analysisResult) && (
          <section className="notion-ai-results">
            {extractedText && (
              <article className="notion-ai-output">
                <h3>Input Text</h3>
                <textarea
                  className="notion-ai-textarea"
                  value={extractedText}
                  onChange={(event) => onChangeExtractedText?.(event.target.value)}
                  rows={10}
                  placeholder="OCR output or note text will appear here."
                />
              </article>
            )}

            {analysisResult && (
              <article className="notion-ai-output">
                <h3>Summary Result</h3>
                <p>{analysisResult.summary || 'No summary available.'}</p>
                <h4>Keywords</h4>
                <ul>
                  {(analysisResult.keywords || []).map((keyword, index) => (
                    <li key={`${keyword}-${index}`}>{keyword}</li>
                  ))}
                </ul>
                <h4>Key Sentences</h4>
                <ul>
                  {(analysisResult.key_sentences || []).map((sentence, index) => (
                    <li key={`sentence-${index}`}>{sentence}</li>
                  ))}
                </ul>
                <div className="notion-ai-export-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={onCopySummary}
                    disabled={!allowExport}
                  >
                    Copy Summary
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={onExportSummary}
                    disabled={!allowExport}
                  >
                    Export TXT
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={onEmailSummary}
                    disabled={!allowExport}
                  >
                    Share by Email
                  </button>
                </div>
              </article>
            )}
          </section>
        )}
      </article>
    </section>
  );
}
