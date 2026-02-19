import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const MIN_SCALE = 0.8;
const MAX_SCALE = 2.4;
const SCALE_STEP = 0.2;
const THUMB_SCALE = 0.2;

export default function PdfInlineViewer({ src, title }) {
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

  const totalPages = pdfDoc?.numPages || 0;

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

  return (
    <div className="notion-pdf-inline">
      <div className="notion-pdf-toolbar">
        <strong className="notion-pdf-title" title={title}>
          {title}
        </strong>
        <div className="notion-pdf-toolbar-actions">
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
        <canvas ref={canvasRef} className="notion-pdf-canvas" />
      </div>
    </div>
  );
}
