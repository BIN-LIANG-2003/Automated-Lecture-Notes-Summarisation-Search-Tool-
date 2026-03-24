import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import UiFeedbackLayer from './UiFeedbackLayer.jsx';
import { useUiFeedback } from '../hooks/useUiFeedback.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const MIN_SCALE = 0.8;
const MAX_SCALE = 2.4;
const SCALE_STEP = 0.2;
const THUMB_SCALE = 0.2;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 48;
const DEFAULT_SCALE = 1.2;
const SMALL_SCREEN_BREAKPOINT = 720;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const makeAnnotationId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const toRgbChannels = (hex) => {
  const raw = String(hex || '')
    .trim()
    .replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    return { r: 0.78, g: 0.16, b: 0.16 };
  }
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  return { r, g, b };
};

export default function PdfInlineViewer({
  src,
  title,
  uploadedAt = '',
  tags = [],
  downloadUrl = '',
  editable = false,
  onSummarizeDocument,
  canSummarize = true,
  isSummarizing = false,
  summarizeDisabledHint = '',
  onSaveEditedPdf,
  saveLoading = false,
  saveError = '',
  onClearSaveError,
  requestConfirmation,
  requestTextInput,
}) {
  const canvasRef = useRef(null);
  const canvasWrapRef = useRef(null);
  const renderTaskRef = useRef(null);
  const {
    toastState,
    confirmDialogState,
    dismissToast,
    requestConfirmation: requestInlineConfirmation,
    closeConfirmDialog,
  } = useUiFeedback();

  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [renderScale, setRenderScale] = useState(DEFAULT_SCALE);
  const [fitWidth, setFitWidth] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= SMALL_SCREEN_BREAKPOINT
  );
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState({});
  const [thumbsLoading, setThumbsLoading] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [error, setError] = useState('');
  const [editorError, setEditorError] = useState('');
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [canvasWrapWidth, setCanvasWrapWidth] = useState(0);

  const [editMode, setEditMode] = useState(false);
  const [annotationColor, setAnnotationColor] = useState('#c62828');
  const [annotationSize, setAnnotationSize] = useState(14);
  const [annotations, setAnnotations] = useState([]);

  const totalPages = pdfDoc?.numPages || 0;
  const pageAnnotations = useMemo(
    () => annotations.filter((item) => item.page === pageNum),
    [annotations, pageNum]
  );

  useEffect(() => {
    let cancelled = false;
    let loadingTask = null;

    setPdfDoc(null);
    setPageNum(1);
    setScale(DEFAULT_SCALE);
    setRenderScale(DEFAULT_SCALE);
    setFitWidth(typeof window !== 'undefined' && window.innerWidth <= SMALL_SCREEN_BREAKPOINT);
    setOverviewOpen(false);
    setThumbnails({});
    setThumbsLoading(false);
    setError('');
    setLoadingDoc(true);
    setCanvasSize({ width: 0, height: 0 });
    setCanvasWrapWidth(0);
    setEditorError('');
    setEditMode(false);
    setAnnotations([]);

    try {
      loadingTask = pdfjsLib.getDocument(src);
      loadingTask.promise
        .then((doc) => {
          if (cancelled) {
            doc.destroy();
            return;
          }
          setPdfDoc(doc);
          setLoadingDoc(false);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('PDF load failed:', err);
          setError('Unable to load PDF inline. Please try again later.');
          setLoadingDoc(false);
        });
    } catch (err) {
      console.error('PDF open failed:', err);
      setError('Unable to load PDF inline. Please try again later.');
      setLoadingDoc(false);
    }

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      if (loadingTask) loadingTask.destroy();
    };
  }, [src]);

  useEffect(() => {
    const node = canvasWrapRef.current;
    if (!node) return undefined;

    const updateWidth = () => {
      const nextWidth = Math.max(0, node.clientWidth || 0);
      setCanvasWrapWidth((prev) => (Math.abs(prev - nextWidth) < 1 ? prev : nextWidth));
    };

    updateWidth();
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => updateWidth());
      resizeObserver.observe(node);
    } else {
      window.addEventListener('resize', updateWidth);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
        return;
      }
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  useEffect(() => {
    if (!overviewOpen || !pdfDoc || !totalPages) return;
    let cancelled = false;

    const renderThumbnail = async (num) => {
      const page = await pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale: THUMB_SCALE });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return '';

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);

      await page.render({
        canvasContext: context,
        viewport,
        transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
      }).promise;

      return canvas.toDataURL('image/jpeg', 0.74);
    };

    const renderAllThumbs = async () => {
      setThumbsLoading(true);
      for (let num = 1; num <= totalPages; num += 1) {
        if (cancelled) return;
        if (thumbnails[num]) continue;
        try {
          const dataUrl = await renderThumbnail(num);
          if (cancelled) return;
          if (!dataUrl) continue;
          setThumbnails((prev) => {
            if (prev[num]) return prev;
            return { ...prev, [num]: dataUrl };
          });
        } catch (err) {
          if (!cancelled) console.error(`Thumbnail render failed for page ${num}:`, err);
        }
      }
      if (!cancelled) setThumbsLoading(false);
    };

    renderAllThumbs();

    return () => {
      cancelled = true;
    };
  }, [overviewOpen, pdfDoc, totalPages]);

  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;

    const renderPage = async () => {
      setLoadingPage(true);
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(
          220,
          (canvasWrapWidth || canvasWrapRef.current?.clientWidth || baseViewport.width) - 28
        );
        const nextScale = fitWidth
          ? clamp(availableWidth / Math.max(baseViewport.width, 1), MIN_SCALE, MAX_SCALE)
          : scale;
        setRenderScale(nextScale);

        const viewport = page.getViewport({ scale: nextScale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setCanvasSize({ width: viewport.width, height: viewport.height });

        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
      } catch (err) {
        if (err?.name === 'RenderingCancelledException') return;
        if (!cancelled) {
          console.error('PDF render failed:', err);
          setError('PDF rendering failed. Please try again.');
        }
      } finally {
        if (!cancelled) setLoadingPage(false);
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pdfDoc, pageNum, scale, fitWidth, canvasWrapWidth]);

  const canPrev = pageNum > 1;
  const canNext = pageNum < totalPages;
  const thumbReadyCount = Object.keys(thumbnails).length;
  const hasPendingAnnotations = annotations.length > 0;
  const uploadedLabel = uploadedAt ? new Date(uploadedAt).toLocaleString() : '';
  const tagsLabel = Array.isArray(tags) && tags.length ? tags.join(', ') : 'None';
  const zoomLabel = fitWidth ? `Fit · ${Math.round(renderScale * 100)}%` : `${Math.round(renderScale * 100)}%`;

  const applyManualScale = (delta) => {
    const baseScale = fitWidth ? renderScale : scale;
    setFitWidth(false);
    setScale(clamp(baseScale + delta, MIN_SCALE, MAX_SCALE));
  };

  const toggleFitWidth = () => {
    if (fitWidth) {
      setFitWidth(false);
      setScale(clamp(renderScale || scale, MIN_SCALE, MAX_SCALE));
      return;
    }
    setFitWidth(true);
  };

  useEffect(() => {
    if (!pdfDoc) return undefined;

    const isTypingTarget = (target) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;

      if (event.key === 'ArrowLeft' && canPrev) {
        event.preventDefault();
        setPageNum((prev) => Math.max(1, prev - 1));
        return;
      }
      if (event.key === 'ArrowRight' && canNext) {
        event.preventDefault();
        setPageNum((prev) => Math.min(totalPages, prev + 1));
        return;
      }
      if ((event.key === '+' || event.key === '=') && !loadingDoc) {
        event.preventDefault();
        applyManualScale(SCALE_STEP);
        return;
      }
      if ((event.key === '-' || event.key === '_') && !loadingDoc) {
        event.preventDefault();
        applyManualScale(-SCALE_STEP);
        return;
      }
      if ((event.key === 'f' || event.key === 'F') && !loadingDoc) {
        event.preventDefault();
        toggleFitWidth();
        return;
      }
      if (event.key === 'Escape') {
        if (overviewOpen) {
          event.preventDefault();
          setOverviewOpen(false);
          return;
        }
        if (editMode) {
          event.preventDefault();
          setEditMode(false);
          setEditorError('');
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pdfDoc, canPrev, canNext, totalPages, loadingDoc, fitWidth, overviewOpen, editMode, renderScale, scale]);

  const handleLayerClick = async (event) => {
    if (!editable || !editMode || loadingDoc || loadingPage || saveLoading) return;
    if (!canvasSize.width || !canvasSize.height) return;

    if (typeof requestTextInput !== 'function') {
      setEditorError('Text input dialog is unavailable.');
      return;
    }
    const textInput = await requestTextInput({
      title: 'Add PDF Annotation',
      description: 'Enter text to insert at the clicked position.',
      placeholder: 'Type annotation text',
      initialValue: '',
      confirmLabel: 'Insert',
      cancelLabel: 'Cancel',
      trimResult: false,
      required: true,
    });
    if (textInput === null) return;

    const text = textInput.trimEnd();
    if (!text.trim()) return;

    onClearSaveError?.();
    setEditorError('');

    const rect = event.currentTarget.getBoundingClientRect();
    const normalizedX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const normalizedY = clamp((event.clientY - rect.top) / rect.height, 0, 1);

    setAnnotations((prev) => [
      ...prev,
      {
        id: makeAnnotationId(),
        page: pageNum,
        x: normalizedX,
        y: normalizedY,
        text,
        color: annotationColor,
        size: clamp(Number(annotationSize) || 14, MIN_FONT_SIZE, MAX_FONT_SIZE),
      },
    ]);
  };

  const removeAnnotation = (annotationId) => {
    setAnnotations((prev) => prev.filter((item) => item.id !== annotationId));
  };

  const confirmRemoveAnnotation = async (annotationId) => {
    const requestDialog = typeof requestConfirmation === 'function'
      ? requestConfirmation
      : requestInlineConfirmation;
    const confirmed = await requestDialog({
      title: 'Delete this annotation?',
      description: 'This annotation will be removed from pending edits.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;
    removeAnnotation(annotationId);
  };

  const removeLastAnnotationOnPage = () => {
    setAnnotations((prev) => {
      let removeIndex = -1;
      for (let idx = prev.length - 1; idx >= 0; idx -= 1) {
        if (prev[idx].page === pageNum) {
          removeIndex = idx;
          break;
        }
      }
      if (removeIndex < 0) return prev;
      return prev.filter((_, idx) => idx !== removeIndex);
    });
  };

  const saveEditedPdf = async () => {
    if (!editable || !onSaveEditedPdf) return;
    if (!annotations.length) {
      setEditorError('Add at least one text annotation first.');
      return;
    }

    onClearSaveError?.();
    setEditorError('');

    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error('Unable to read the current PDF file.');
      const sourceBytes = await response.arrayBuffer();

      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
      const pdfDocForEdit = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      const font = await pdfDocForEdit.embedFont(StandardFonts.Helvetica);
      const pages = pdfDocForEdit.getPages();

      annotations.forEach((annotation) => {
        const page = pages[annotation.page - 1];
        if (!page) return;

        const { width, height } = page.getSize();
        const baseX = clamp(annotation.x, 0, 1) * width;
        const baseY = height - clamp(annotation.y, 0, 1) * height;
        const colorChannels = toRgbChannels(annotation.color);
        const drawColor = rgb(colorChannels.r, colorChannels.g, colorChannels.b);
        const drawSize = clamp(Number(annotation.size) || 14, MIN_FONT_SIZE, MAX_FONT_SIZE);
        const lineHeight = drawSize + 2;

        String(annotation.text || '')
          .split('\n')
          .forEach((line, lineIndex) => {
            const y = baseY - lineIndex * lineHeight;
            if (y < 0) return;
            page.drawText(line || ' ', {
              x: baseX,
              y,
              size: drawSize,
              font,
              color: drawColor,
            });
          });
      });

      const editedBytes = await pdfDocForEdit.save();
      await onSaveEditedPdf(editedBytes);
      setAnnotations([]);
      setEditMode(false);
    } catch (err) {
      console.error('Save edited PDF failed:', err);
      setEditorError(err?.message || 'Failed to save PDF.');
    }
  };

  return (
    <div className="notion-pdf-inline">
      <div className="notion-pdf-toolbar">
        <div className="notion-pdf-doc-meta">
          <strong className="notion-pdf-title" title={title}>
            {title}
          </strong>
          <span className="notion-pdf-doc-sub">Uploaded: {uploadedLabel}</span>
          <span className="notion-pdf-doc-sub">Tags: {tagsLabel}</span>
        </div>
        <div className="notion-pdf-toolbar-actions">
          {downloadUrl && (
            <a
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
              className="notion-pdf-btn notion-pdf-btn-link"
            >
              Download File
            </a>
          )}
          {typeof onSummarizeDocument === 'function' && (
            <button
              type="button"
              className="notion-pdf-btn notion-pdf-btn-primary"
              onClick={() => onSummarizeDocument()}
              disabled={!canSummarize || isSummarizing}
              title={!canSummarize ? summarizeDisabledHint || 'Summarize is not available right now.' : undefined}
            >
              {isSummarizing ? 'Summarizing...' : 'Summarize'}
            </button>
          )}
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setPageNum((prev) => Math.max(1, prev - 1))}
            disabled={!canPrev || loadingDoc}
          >
            Previous
          </button>
          <span className="notion-pdf-page-indicator">
            {totalPages ? `${pageNum} / ${totalPages}` : '-- / --'}
          </span>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setPageNum((prev) => Math.min(totalPages, prev + 1))}
            disabled={!canNext || loadingDoc}
          >
            Next
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => applyManualScale(-SCALE_STEP)}
            disabled={(!fitWidth && scale <= MIN_SCALE) || loadingDoc}
          >
            Zoom Out
          </button>
          <span className="notion-pdf-zoom-indicator">{zoomLabel}</span>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => applyManualScale(SCALE_STEP)}
            disabled={(!fitWidth && scale >= MAX_SCALE) || loadingDoc}
          >
            Zoom In
          </button>
          <button
            type="button"
            className={`notion-pdf-btn${fitWidth ? ' active' : ''}`}
            onClick={toggleFitWidth}
            disabled={loadingDoc}
            aria-pressed={fitWidth}
          >
            Fit Width
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setOverviewOpen((prev) => !prev)}
            disabled={loadingDoc || !totalPages}
          >
            {overviewOpen ? 'Hide Overview' : 'Overview'}
          </button>
        </div>
      </div>

      <p className="notion-pdf-shortcuts muted tiny">
        Shortcuts: left/right arrows switch pages, +/- adjust zoom, F toggles fit width, Esc closes overview or annotation mode.
      </p>

      {editable && (
        <div className="notion-pdf-editbar">
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => {
              setEditMode((prev) => !prev);
              onClearSaveError?.();
              setEditorError('');
            }}
            disabled={loadingDoc || saveLoading}
          >
            {editMode ? 'Exit Annotation Mode' : 'Add Annotation'}
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={removeLastAnnotationOnPage}
            disabled={!pageAnnotations.length || saveLoading}
          >
            Undo on This Page
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setAnnotations([])}
            disabled={!hasPendingAnnotations || saveLoading}
          >
            Clear Annotations
          </button>
          <label className="notion-pdf-config">
            Font size
            <input
              type="number"
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              value={annotationSize}
              onChange={(event) =>
                setAnnotationSize(clamp(Number(event.target.value) || 14, MIN_FONT_SIZE, MAX_FONT_SIZE))
              }
              disabled={saveLoading}
            />
          </label>
          <label className="notion-pdf-config">
            Color
            <input
              type="color"
              value={annotationColor}
              onChange={(event) => setAnnotationColor(event.target.value)}
              disabled={saveLoading}
            />
          </label>
          <span className="notion-pdf-edit-meta">
            {hasPendingAnnotations ? `${annotations.length} annotations pending save` : 'No pending annotations'}
          </span>
          <button
            type="button"
            className="notion-pdf-btn notion-pdf-btn-primary"
            onClick={saveEditedPdf}
            disabled={!hasPendingAnnotations || saveLoading}
          >
            {saveLoading ? 'Saving...' : 'Save to Original PDF'}
          </button>
        </div>
      )}

      {overviewOpen && (
        <div className="notion-pdf-overview">
          <div className="notion-pdf-overview-head">
            <strong>Page Overview</strong>
            <span className="muted tiny">
              {thumbsLoading ? `Generating thumbnails ${thumbReadyCount}/${totalPages}` : `${totalPages} pages`}
            </span>
          </div>

          <div className="notion-pdf-thumb-grid">
            {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((num) => (
              <button
                key={num}
                type="button"
                className={`notion-pdf-thumb ${num === pageNum ? 'active' : ''}`}
                onClick={() => {
                  setPageNum(num);
                }}
              >
                <div className="notion-pdf-thumb-canvas-wrap">
                  {thumbnails[num] ? (
                    <img src={thumbnails[num]} alt={`Page ${num} thumbnail`} />
                  ) : (
                    <span className="notion-pdf-thumb-placeholder">Page {num}</span>
                  )}
                </div>
                <span className="notion-pdf-thumb-index">{num}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={canvasWrapRef} className="notion-pdf-canvas-wrap">
        {(loadingDoc || loadingPage) && (
          <p className="notion-pdf-status" aria-live="polite">
            Rendering PDF...
          </p>
        )}
        {error && !loadingDoc && (
          <p className="notion-pdf-status notion-pdf-status-error" role="alert">
            {error}
          </p>
        )}

        <div
          className={`notion-pdf-stage ${editMode ? 'edit-mode' : ''}`}
          style={
            canvasSize.width && canvasSize.height
              ? { width: `${canvasSize.width}px`, height: `${canvasSize.height}px` }
              : undefined
          }
        >
          <canvas ref={canvasRef} className="notion-pdf-canvas" />
          <div
            className={`notion-pdf-annotation-layer ${editMode ? 'editable' : ''}`}
            onClick={handleLayerClick}
            aria-label={editMode ? 'Click on the PDF page to add annotation text' : undefined}
          >
            {pageAnnotations.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`notion-pdf-annotation ${editMode ? 'editable' : ''}`}
                style={{
                  left: `${item.x * 100}%`,
                  top: `${item.y * 100}%`,
                  color: item.color,
                  fontSize: `${item.size}px`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!editMode) return;
                  void confirmRemoveAnnotation(item.id);
                }}
                title={editMode ? 'Click to delete this annotation' : item.text}
              >
                {item.text}
              </button>
            ))}
          </div>
        </div>
      </div>

      {editable && editMode && (
        <p className="muted tiny notion-pdf-edit-hint">
          Click a blank area to add text annotations; click existing annotations to remove them. Free plan editing appends annotations only.
        </p>
      )}
      {(saveError || editorError) && (
        <p className="notion-pdf-edit-error" role="alert">
          Save failed: {saveError || editorError}
        </p>
      )}
      {typeof requestConfirmation !== 'function' && (
        <UiFeedbackLayer
          toastState={toastState}
          confirmDialogState={confirmDialogState}
          onDismissToast={dismissToast}
          onCloseConfirmDialog={closeConfirmDialog}
        />
      )}
    </div>
  );
}
