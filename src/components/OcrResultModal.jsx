export default function OcrResultModal({
  open,
  onClose,
  sourceLabel = '',
  sourceDetail = '',
  extractedText = '',
  onChangeExtractedText,
  saveFormat = 'txt',
  onSaveFormatChange,
  onSave,
  onSummarize,
  isExtracting = false,
  isAnalyzing = false,
  isSaving = false,
  canSave = true,
  canSummarize = true,
}) {
  if (!open) return null;

  return (
    <div className="notion-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="notion-modal-card notion-ocr-result-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-result-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="notion-summary-result-head">
          <div>
            <h3 id="ocr-result-title">OCR Result</h3>
            <p className="notion-settings-help">
              {sourceLabel ? `Image source: ${sourceLabel}` : 'Review and edit OCR output before saving.'}
            </p>
          </div>
          <button
            type="button"
            className="notion-modal-close"
            onClick={onClose}
            aria-label="Close OCR Result"
          >
            ×
          </button>
        </div>

        <article className="notion-ai-output">
          <div className="notion-ocr-modal-toolbar">
            <div className="notion-ocr-modal-status">
              <strong>{isExtracting ? 'Running image OCR...' : 'OCR text output'}</strong>
              {sourceDetail ? <span>{sourceDetail}</span> : null}
            </div>
            <label className="notion-results-control notion-ocr-format-select" htmlFor="ocr-save-format">
              <span>Save format</span>
              <select
                id="ocr-save-format"
                value={saveFormat}
                onChange={(event) => onSaveFormatChange?.(event.target.value)}
                disabled={isSaving}
              >
                <option value="txt">TXT</option>
                <option value="docx">DOCX</option>
                <option value="pdf">PDF</option>
              </select>
            </label>
          </div>
          <textarea
            className="notion-ai-textarea"
            value={extractedText}
            onChange={(event) => onChangeExtractedText?.(event.target.value)}
            rows={12}
            placeholder="OCR output will appear here. You can edit it before saving."
          />
          <p className="muted tiny">
            Saving creates a new note in the current workspace. The source image is never overwritten.
          </p>
          <div className="notion-ai-export-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSummarize}
              disabled={isAnalyzing || !String(extractedText || '').trim() || !canSummarize}
            >
              {isAnalyzing ? 'Summarizing...' : 'Summarize Text'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={onSave}
              disabled={isSaving || !String(extractedText || '').trim() || !canSave}
            >
              {isSaving ? 'Saving...' : `Save as ${String(saveFormat || 'txt').toUpperCase()}`}
            </button>
          </div>
        </article>

        <div className="notion-modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
