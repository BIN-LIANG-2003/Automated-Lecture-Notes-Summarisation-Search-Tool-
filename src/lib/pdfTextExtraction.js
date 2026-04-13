import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const PDF_TEXT_FAILED_STATUS = 'client_failed';
const PDF_TEXT_READY_STATUS = 'processed';
const PDF_TEXT_NEEDS_OCR_STATUS = 'needs_ocr';

const normalizePdfText = (value) =>
  String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, ' ')
    .replace(/-\n(?=[A-Za-z])/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const isPdfUploadFile = (file) => {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  return type === 'application/pdf' || name.endsWith('.pdf');
};

export const extractSelectableTextFromPdfFile = async (file) => {
  if (!isPdfUploadFile(file)) {
    return { status: '', text: '', pageCount: 0, error: '' };
  }

  let loadingTask = null;
  let pdfDoc = null;
  try {
    const sourceBuffer = await file.arrayBuffer();
    loadingTask = pdfjsLib.getDocument({ data: sourceBuffer });
    pdfDoc = await loadingTask.promise;
    const pageTexts = [];

    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
      const page = await pdfDoc.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const pageText = (textContent.items || [])
          .map((item) => String(item?.str || '').trim())
          .filter(Boolean)
          .join(' ');
        if (pageText) pageTexts.push(pageText);
      } finally {
        page.cleanup?.();
      }
    }

    const text = normalizePdfText(pageTexts.join('\n\n'));
    return {
      status: text ? PDF_TEXT_READY_STATUS : PDF_TEXT_NEEDS_OCR_STATUS,
      text,
      pageCount: pdfDoc.numPages,
      error: '',
    };
  } catch (error) {
    return {
      status: PDF_TEXT_FAILED_STATUS,
      text: '',
      pageCount: 0,
      error: String(error?.message || error || 'PDF text extraction failed').slice(0, 300),
    };
  } finally {
    try {
      await pdfDoc?.destroy?.();
    } catch {
      // Ignore pdf.js cleanup failures.
    }
    try {
      await loadingTask?.destroy?.();
    } catch {
      // Ignore pdf.js cleanup failures.
    }
  }
};
