import { buildSummaryDiagnostics } from '../lib/summaryDiagnostics.js';

export default function SummaryResultModal({
  open,
  onClose,
  title = 'Summary Result',
  summaryTitle = '',
  analysisResult = null,
  onCopySummary,
  onExportSummary,
  onExportSummaryPdf,
  onEmailSummary,
  onRebuildSummary,
  canRebuildSummary = false,
  rebuildSummaryLoading = false,
  closeLabel = 'Close',
  allowExport = true,
}) {
  if (!open || !analysisResult) return null;

  const diagnostics = buildSummaryDiagnostics(analysisResult);
  const keywords = Array.isArray(analysisResult.keywords) ? analysisResult.keywords : [];
  const keySentences = Array.isArray(analysisResult.key_sentences) ? analysisResult.key_sentences : [];

  return (
    <div className="notion-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="notion-modal-card notion-summary-result-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="summary-result-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="notion-summary-result-head">
          <div>
            <h3 id="summary-result-title">{title}</h3>
            {summaryTitle ? (
              <p className="notion-settings-help">Source: {summaryTitle}</p>
            ) : (
              <p className="notion-settings-help">Current generated summary result.</p>
            )}
          </div>
          <button
            type="button"
            className="notion-modal-close"
            onClick={onClose}
            aria-label="Dismiss Summary Result"
          >
            ×
          </button>
        </div>

        <section className="notion-ai-results">
          <article className="notion-ai-output">
            <h3>Summary</h3>
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
          </article>

          <article className="notion-ai-output">
            <h4>Keywords</h4>
            <ul>
              {keywords.length ? (
                keywords.map((keyword, index) => (
                  <li key={`${keyword}-${index}`}>{keyword}</li>
                ))
              ) : (
                <li>No keywords available.</li>
              )}
            </ul>
            <h4>Key Sentences</h4>
            <ul>
              {keySentences.length ? (
                keySentences.map((sentence, index) => (
                  <li key={`summary-sentence-${index}`}>{sentence}</li>
                ))
              ) : (
                <li>No key sentences available.</li>
              )}
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
                onClick={onExportSummaryPdf}
                disabled={!allowExport}
              >
                Export PDF
              </button>
              <button
                type="button"
                className="btn"
                onClick={onEmailSummary}
                disabled={!allowExport}
              >
                Share by Email
              </button>
              {canRebuildSummary && (
                <button
                  type="button"
                  className="btn"
                  onClick={onRebuildSummary}
                  disabled={rebuildSummaryLoading}
                  title="Bypass cache and refresh document text before summarizing"
                >
                  {rebuildSummaryLoading ? 'Rebuilding...' : 'Rebuild + Refresh'}
                </button>
              )}
            </div>
          </article>
        </section>

        <div className="notion-modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            {closeLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
