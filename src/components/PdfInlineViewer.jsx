import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const MIN_SCALE = 0.8;
const MAX_SCALE = 2.4;
const SCALE_STEP = 0.2;
const THUMB_SCALE = 0.2;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 48;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const makeAnnotationId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const toRgbColor = (hex) => {
  const raw = String(hex || '')
    .trim()
    .replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return rgb(0.78, 0.16, 0.16);
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
};

export default function PdfInlineViewer({
  src,
  title,
  uploadedAt = '',
  tags = [],
  downloadUrl = '',
  editable = false,
  onSaveEditedPdf,
  saveLoading = false,
  saveError = '',
  onClearSaveError,
}) {
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState({});
  const [thumbsLoading, setThumbsLoading] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [error, setError] = useState('');
  const [editorError, setEditorError] = useState('');
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

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
    setScale(1.2);
    setOverviewOpen(false);
    setThumbnails({});
    setThumbsLoading(false);
    setError('');
    setLoadingDoc(true);
    setCanvasSize({ width: 0, height: 0 });
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
          setError('无法在页面内加载 PDF，稍后再试。');
          setLoadingDoc(false);
        });
    } catch (err) {
      console.error('PDF open failed:', err);
      setError('无法在页面内加载 PDF，稍后再试。');
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

        const viewport = page.getViewport({ scale });
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
          setError('PDF 渲染失败，请稍后重试。');
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
  }, [pdfDoc, pageNum, scale]);

  const canPrev = pageNum > 1;
  const canNext = pageNum < totalPages;
  const thumbReadyCount = Object.keys(thumbnails).length;
  const hasPendingAnnotations = annotations.length > 0;
  const uploadedLabel = uploadedAt ? new Date(uploadedAt).toLocaleString() : '';
  const tagsLabel = Array.isArray(tags) && tags.length ? tags.join(', ') : 'None';

  const handleLayerClick = (event) => {
    if (!editable || !editMode || loadingDoc || loadingPage || saveLoading) return;
    if (!canvasSize.width || !canvasSize.height) return;

    const textInput = window.prompt('输入要写入 PDF 的文本：');
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
      setEditorError('请先在页面上添加至少一个文本标注。');
      return;
    }

    onClearSaveError?.();
    setEditorError('');

    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error('无法读取当前 PDF 文件。');
      const sourceBytes = await response.arrayBuffer();

      const pdfDocForEdit = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      const font = await pdfDocForEdit.embedFont(StandardFonts.Helvetica);
      const pages = pdfDocForEdit.getPages();

      annotations.forEach((annotation) => {
        const page = pages[annotation.page - 1];
        if (!page) return;

        const { width, height } = page.getSize();
        const baseX = clamp(annotation.x, 0, 1) * width;
        const baseY = height - clamp(annotation.y, 0, 1) * height;
        const drawColor = toRgbColor(annotation.color);
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
      setEditorError(err?.message || '保存 PDF 失败。');
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
              下载文件
            </a>
          )}
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setPageNum((prev) => Math.max(1, prev - 1))}
            disabled={!canPrev || loadingDoc}
          >
            上一页
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
            下一页
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setScale((prev) => Math.max(MIN_SCALE, prev - SCALE_STEP))}
            disabled={scale <= MIN_SCALE || loadingDoc}
          >
            缩小
          </button>
          <span className="notion-pdf-zoom-indicator">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setScale((prev) => Math.min(MAX_SCALE, prev + SCALE_STEP))}
            disabled={scale >= MAX_SCALE || loadingDoc}
          >
            放大
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setOverviewOpen((prev) => !prev)}
            disabled={loadingDoc || !totalPages}
          >
            {overviewOpen ? '收起总览' : '总览'}
          </button>
        </div>
      </div>

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
            {editMode ? '退出标注' : '添加标注'}
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={removeLastAnnotationOnPage}
            disabled={!pageAnnotations.length || saveLoading}
          >
            撤销本页
          </button>
          <button
            type="button"
            className="notion-pdf-btn"
            onClick={() => setAnnotations([])}
            disabled={!hasPendingAnnotations || saveLoading}
          >
            清空标注
          </button>
          <label className="notion-pdf-config">
            字号
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
            颜色
            <input
              type="color"
              value={annotationColor}
              onChange={(event) => setAnnotationColor(event.target.value)}
              disabled={saveLoading}
            />
          </label>
          <span className="notion-pdf-edit-meta">
            {hasPendingAnnotations ? `待保存 ${annotations.length} 条标注` : '暂无待保存标注'}
          </span>
          <button
            type="button"
            className="notion-pdf-btn notion-pdf-btn-primary"
            onClick={saveEditedPdf}
            disabled={!hasPendingAnnotations || saveLoading}
          >
            {saveLoading ? '保存中...' : '保存到原PDF'}
          </button>
        </div>
      )}

      {overviewOpen && (
        <div className="notion-pdf-overview">
          <div className="notion-pdf-overview-head">
            <strong>页面总览</strong>
            <span className="muted tiny">
              {thumbsLoading ? `生成缩略图 ${thumbReadyCount}/${totalPages}` : `共 ${totalPages} 页`}
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
                    <img src={thumbnails[num]} alt={`第 ${num} 页缩略图`} />
                  ) : (
                    <span className="notion-pdf-thumb-placeholder">第 {num} 页</span>
                  )}
                </div>
                <span className="notion-pdf-thumb-index">{num}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="notion-pdf-canvas-wrap">
        {(loadingDoc || loadingPage) && (
          <p className="notion-pdf-status" aria-live="polite">
            正在渲染 PDF...
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
            aria-label={editMode ? '点击 PDF 页面添加标注文本' : undefined}
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
                  if (window.confirm('删除这条标注？')) removeAnnotation(item.id);
                }}
                title={editMode ? '点击删除此标注' : item.text}
              >
                {item.text}
              </button>
            ))}
          </div>
        </div>
      </div>

      {editable && editMode && (
        <p className="muted tiny notion-pdf-edit-hint">
          点击页面空白处可添加文字标注；点击已有标注可删除。免费版为追加标注，不做原对象精修。
        </p>
      )}
      {(saveError || editorError) && (
        <p className="notion-pdf-edit-error" role="alert">
          保存失败: {saveError || editorError}
        </p>
      )}
    </div>
  );
}
