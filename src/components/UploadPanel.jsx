const formatFileSize = (size) => {
  const bytes = Number(size) || 0;
  if (bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export default function UploadPanel({
  allowUploads,
  dragUploadActive,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onSubmit,
  fileInputRef,
  onFileChange,
  uploadCategory,
  onUploadCategoryChange,
  categorySuggestions,
  uploadQueueRunning,
  fileHint,
  uploadQueueSummary,
  uploadQueueExpanded,
  onToggleUploadQueueExpanded,
  onRetryFailedUploads,
  canRetryFailedUploads,
  onClearCompletedUploads,
  canClearUploadQueue,
  uploadQueue,
}) {
  return (
    <section className="uploader notion-panel-block notion-upload-panel" aria-labelledby="uploader-title">
      <div className="notion-panel-head">
        <h2 id="uploader-title" className="section-title">Upload Files</h2>
        <p>Add new notes to this workspace and auto-index them for search.</p>
      </div>
      <div
        className={`notion-upload-dropzone${dragUploadActive ? ' is-active' : ''}${
          !allowUploads ? ' is-disabled' : ''
        }`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <form id="upload-form" onSubmit={onSubmit} noValidate>
          <input
            id="file-input"
            type="file"
            accept=".pdf,.docx,.txt,image/*"
            ref={fileInputRef}
            onChange={onFileChange}
            className="sr-only"
            disabled={!allowUploads}
          />
          <label htmlFor="upload-category-input">Category (optional)</label>
          <input
            id="upload-category-input"
            type="text"
            list="upload-category-options"
            placeholder="e.g. Computer Science"
            value={uploadCategory}
            onChange={(event) => onUploadCategoryChange(event.target.value)}
            disabled={!allowUploads}
          />
          <datalist id="upload-category-options">
            {categorySuggestions.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
          <div className="uploader-actions">
            <label
              htmlFor="file-input"
              className={`btn file-btn${!allowUploads ? ' disabled' : ''}`}
              aria-disabled={!allowUploads}
            >
              Choose Files
            </label>
            <button
              id="upload-btn"
              className="btn btn-primary"
              type="submit"
              disabled={!allowUploads || uploadQueueRunning}
            >
              {uploadQueueRunning ? 'Uploading...' : 'Upload'}
            </button>
          </div>
          <span id="file-hint" className="muted file-picker-text" aria-live="polite">
            {fileHint || 'No file selected yet'}
          </span>
          {uploadQueueSummary.total > 0 && (
            <section className="notion-upload-queue" aria-label="Upload queue">
              <div className="notion-upload-queue-head">
                <div className="notion-upload-queue-stats">
                  <span>Total {uploadQueueSummary.total}</span>
                  <span className="is-success">Success {uploadQueueSummary.success}</span>
                  <span className="is-failed">Failed {uploadQueueSummary.failed}</span>
                  <span>Running {uploadQueueSummary.uploading}</span>
                </div>
                <div className="notion-upload-queue-actions">
                  <button type="button" className="btn" onClick={onToggleUploadQueueExpanded}>
                    {uploadQueueExpanded ? 'Collapse' : 'Expand'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={onRetryFailedUploads}
                    disabled={!canRetryFailedUploads}
                  >
                    Retry Failed
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={onClearCompletedUploads}
                    disabled={!canClearUploadQueue}
                  >
                    Clear Finished
                  </button>
                </div>
              </div>
              {uploadQueueExpanded && (
                <>
                  <div className="notion-upload-queue-progress" role="presentation">
                    <span style={{ width: `${uploadQueueSummary.progress}%` }} />
                  </div>
                  <ul className="notion-upload-queue-list">
                    {uploadQueue.slice(0, 8).map((item) => (
                      <li key={item.id}>
                        <div>
                          <strong>{item.name}</strong>
                          <span>{item.message || formatFileSize(item.size)}</span>
                        </div>
                        <span className={`notion-upload-status notion-upload-status-${item.status}`}>
                          {item.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {uploadQueue.length > 8 && (
                    <p className="muted tiny">+{uploadQueue.length - 8} more item(s) in queue</p>
                  )}
                </>
              )}
            </section>
          )}
        </form>
        <p className="notion-upload-drop-hint">Drag & drop files here for quick upload.</p>
      </div>
      <p className="muted tiny">
        {allowUploads
          ? 'Supports PDF / DOCX / TXT / images, up to 20MB per file. Empty category will be auto-assigned.'
          : 'Uploads are currently disabled by workspace settings.'}
      </p>
    </section>
  );
}
