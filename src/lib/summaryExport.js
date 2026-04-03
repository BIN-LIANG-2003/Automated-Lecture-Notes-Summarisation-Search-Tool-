const SUMMARY_EXPORT_NAME_PREFIX = 'studyhub-summary';
const SUMMARY_EMAIL_SUBJECT = 'StudyHub Note Summary';
const SUMMARY_EMAIL_BODY_LIMIT = 7000;
const PDF_PAGE_WIDTH = 595.28;
const PDF_PAGE_HEIGHT = 841.89;
const PDF_MARGIN = 50;
const PDF_MAX_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;

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

export const buildSummaryExportFilename = (extension = 'txt') => {
  const safeExtension = String(extension || 'txt').trim().replace(/^\./, '').toLowerCase() || 'txt';
  return `${SUMMARY_EXPORT_NAME_PREFIX}-${new Date().toISOString().slice(0, 10)}.${safeExtension}`;
};

export const buildSummaryEmailHref = (analysisResult) => {
  const output = buildSummaryExportText(analysisResult);
  if (!output) return '';
  const subject = encodeURIComponent(SUMMARY_EMAIL_SUBJECT);
  const body = encodeURIComponent(output.slice(0, SUMMARY_EMAIL_BODY_LIMIT));
  return `mailto:?subject=${subject}&body=${body}`;
};

export const openSummaryEmailDraft = (analysisResult) => {
  const href = buildSummaryEmailHref(analysisResult);
  if (!href) return false;
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
};

const normalizePdfText = (value) =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[…]/g, '...')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[•]/g, '-')
    .replace(/[^\n\r\t\x20-\x7E\xA0-\xFF]/g, '?');

const splitLongToken = (token, font, fontSize, maxWidth) => {
  const chunks = [];
  let current = '';
  for (const char of String(token || '')) {
    const next = `${current}${char}`;
    if (!current || font.widthOfTextAtSize(next, fontSize) <= maxWidth) {
      current = next;
      continue;
    }
    chunks.push(current);
    current = char;
  }
  if (current) chunks.push(current);
  return chunks;
};

const wrapPdfParagraph = (text, font, fontSize, maxWidth, firstPrefix = '', continuationPrefix = '') => {
  const safeText = normalizePdfText(text);
  if (!safeText.trim()) return [''];

  const lines = [];
  const paragraphs = safeText.split('\n');

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const source = paragraph.trim();
    if (!source) {
      lines.push('');
      return;
    }

    const tokens = source.split(/\s+/).filter(Boolean);
    let prefix = firstPrefix;
    let current = prefix;
    let hasWords = false;

    while (tokens.length) {
      const token = tokens.shift();
      const separator = hasWords ? ' ' : '';
      const candidate = `${current}${separator}${token}`;

      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        current = candidate;
        hasWords = true;
        continue;
      }

      if (hasWords) {
        lines.push(current);
        prefix = continuationPrefix;
        current = prefix;
        hasWords = false;
        tokens.unshift(token);
        continue;
      }

      const availableWidth = Math.max(24, maxWidth - font.widthOfTextAtSize(prefix, fontSize));
      const chunks = splitLongToken(token, font, fontSize, availableWidth);
      if (!chunks.length) continue;

      current = `${prefix}${chunks[0]}`;
      if (chunks.length === 1) {
        hasWords = true;
        continue;
      }

      lines.push(current);
      prefix = continuationPrefix;
      for (let index = 1; index < chunks.length - 1; index += 1) {
        lines.push(`${continuationPrefix}${chunks[index]}`);
      }
      current = `${continuationPrefix}${chunks[chunks.length - 1]}`;
      hasWords = true;
    }

    if (hasWords) {
      lines.push(current);
    }
    if (paragraphIndex < paragraphs.length - 1) {
      lines.push('');
    }
  });

  return lines;
};

const createPdfDownload = (filename, bytes) => {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export const downloadPlainTextPdf = async (filename, title, content) => {
  const safeContent = String(content || '').trim();
  if (!safeContent) return false;

  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const headingFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  let cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
  const textColor = rgb(0.14, 0.16, 0.2);
  const mutedColor = rgb(0.37, 0.42, 0.48);
  const ensureRoom = (heightNeeded) => {
    if (cursorY - heightNeeded >= PDF_MARGIN) return;
    page = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
    cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
  };
  const drawLines = (lines, { font, fontSize, lineHeight, color = textColor }) => {
    lines.forEach((line) => {
      ensureRoom(lineHeight);
      page.drawText(line || ' ', {
        x: PDF_MARGIN,
        y: cursorY,
        size: fontSize,
        font,
        color,
      });
      cursorY -= lineHeight;
    });
  };

  drawLines([normalizePdfText(title) || 'StudyHub Export'], {
    font: headingFont,
    fontSize: 19,
    lineHeight: 24,
  });
  drawLines([`Generated ${new Date().toLocaleString()}`], {
    font: bodyFont,
    fontSize: 10,
    lineHeight: 14,
    color: mutedColor,
  });
  cursorY -= 12;

  normalizePdfText(safeContent)
    .split('\n')
    .forEach((paragraph) => {
      const wrapped = wrapPdfParagraph(paragraph, bodyFont, 11, PDF_MAX_WIDTH);
      drawLines(wrapped, {
        font: bodyFont,
        fontSize: 11,
        lineHeight: 16,
      });
    });

  createPdfDownload(filename, await pdfDoc.save());
  return true;
};

export const downloadSummaryPdf = async (filename, analysisResult) => {
  const output = buildSummaryExportText(analysisResult);
  if (!output) return false;

  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const headingFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const keywords = Array.isArray(analysisResult?.keywords) ? analysisResult.keywords : [];
  const keySentences = Array.isArray(analysisResult?.key_sentences) ? analysisResult.key_sentences : [];

  let page = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  let cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
  const textColor = rgb(0.14, 0.16, 0.2);
  const mutedColor = rgb(0.37, 0.42, 0.48);
  const ensureRoom = (heightNeeded) => {
    if (cursorY - heightNeeded >= PDF_MARGIN) return;
    page = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
    cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
  };
  const drawLines = (lines, { font, fontSize, lineHeight, color = textColor }) => {
    lines.forEach((line) => {
      ensureRoom(lineHeight);
      page.drawText(line || ' ', {
        x: PDF_MARGIN,
        y: cursorY,
        size: fontSize,
        font,
        color,
      });
      cursorY -= lineHeight;
    });
  };
  const drawGap = (size) => {
    cursorY -= size;
    if (cursorY < PDF_MARGIN) {
      page = pdfDoc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
      cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
    }
  };
  const drawSection = (label, content, options = {}) => {
    const {
      firstPrefix = '',
      continuationPrefix = '',
      color = textColor,
    } = options;
    ensureRoom(38);
    drawLines([label], {
      font: headingFont,
      fontSize: 13,
      lineHeight: 18,
      color: textColor,
    });
    const wrapped = wrapPdfParagraph(content, bodyFont, 11, PDF_MAX_WIDTH, firstPrefix, continuationPrefix);
    drawLines(wrapped, {
      font: bodyFont,
      fontSize: 11,
      lineHeight: 16,
      color,
    });
    drawGap(8);
  };

  drawLines(['StudyHub Summary'], {
    font: headingFont,
    fontSize: 19,
    lineHeight: 24,
    color: textColor,
  });
  drawLines([`Generated ${new Date().toLocaleString()}`], {
    font: bodyFont,
    fontSize: 10,
    lineHeight: 14,
    color: mutedColor,
  });
  drawGap(12);

  drawSection('Summary', analysisResult?.summary || 'N/A');
  drawSection('Keywords', keywords.length ? keywords.join(', ') : 'N/A');

  ensureRoom(38);
  drawLines(['Key Sentences'], {
    font: headingFont,
    fontSize: 13,
    lineHeight: 18,
    color: textColor,
  });
  if (keySentences.length) {
    keySentences.forEach((sentence) => {
      const wrapped = wrapPdfParagraph(sentence, bodyFont, 11, PDF_MAX_WIDTH, '- ', '  ');
      drawLines(wrapped, {
        font: bodyFont,
        fontSize: 11,
        lineHeight: 16,
        color: textColor,
      });
    });
  } else {
    drawLines(['N/A'], {
      font: bodyFont,
      fontSize: 11,
      lineHeight: 16,
      color: textColor,
    });
  }
  drawGap(8);

  drawSection('Source', analysisResult?.summary_source || 'fallback');
  if (analysisResult?.summary_note) {
    drawSection('Note', analysisResult.summary_note);
  }

  const pdfBytes = await pdfDoc.save();
  createPdfDownload(filename, pdfBytes);
  return true;
};
