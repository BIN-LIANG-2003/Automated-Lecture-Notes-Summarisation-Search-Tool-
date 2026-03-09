import { buildSummaryDiagnostics } from '../lib/summaryDiagnostics.js';

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
  onOpenSummaryCenter,
  isExtracting = false,
  isAnalyzing = false,
  extractedText = '',
  hideInputText = false,
  onChangeExtractedText,
  analysisResult = null,
  summaryHistoryCount = 0,
}) {
  const diagnostics = buildSummaryDiagnostics(analysisResult);

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
          <button
            type="button"
            className="btn notion-ai-action-chip"
            onClick={onOpenSummaryCenter}
            disabled={typeof onOpenSummaryCenter !== 'function'}
          >
            Summary Center ({Number(summaryHistoryCount) || 0})
          </button>
        </div>
        <p className="muted tiny">
          For PDF/DOCX/TXT notes, use <strong>Summarize Document</strong> in My Documents. Raw source text stays hidden.
        </p>

        <section className="notion-ai-results">
          {!hideInputText ? (
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
          ) : (
            <article className="notion-ai-output">
              <h3>Input Text</h3>
              <p className="muted tiny">This summary is generated from document content on server. Source text is hidden.</p>
            </article>
          )}

          {analysisResult && (
            <article className="notion-ai-output">
              <h3>Summary Result</h3>
              <p>{analysisResult.summary || 'No summary available.'}</p>
              {!!diagnostics.length && (
                <div className="notion-ai-diagnostics" aria-label="Summary diagnostics">
                  {diagnostics.map((item) => (
                    <div key={item.key} className="notion-ai-diagnostic-item">
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </div>
              )}
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
      </article>
    </section>
  );
}
