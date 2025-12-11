import { fmtDate } from './dates.js';

export const DOCUMENTS_KEY = 'documentsData';

export const DEFAULT_DOCUMENTS = [
  {
    id: 1,
    title: 'Linear Algebra – Lecture 1',
    uploadedAt: '2025-09-05T10:00:00Z',
    tags: ['algebra', 'core'],
    content: 'Linear Algebra lecture notes covering vector spaces, linear independence, and matrix transformations.'
  },
  {
    id: 2,
    title: 'Operating Systems – Revision Outline',
    uploadedAt: '2025-10-12T09:12:00Z',
    tags: ['revision', 'os'],
    content: 'Operating Systems revision outline including processes, threading models, scheduling algorithms, and memory management.'
  },
  {
    id: 3,
    title: 'Computer Networks – Lab Guide',
    uploadedAt: '2025-10-01T14:30:00Z',
    tags: ['lab', 'networking'],
    content: 'Lab guide detailing Ethernet setup, TCP handshake tracing, and Wireshark packet analysis exercises.'
  }
];

export const loadDocuments = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCUMENTS_KEY) || 'null');
    if (Array.isArray(raw)) return raw;
  } catch (err) {
    console.warn('Failed to parse documents from localStorage', err);
  }
  return DEFAULT_DOCUMENTS;
};

export const persistDocuments = (docs) => {
  localStorage.setItem(DOCUMENTS_KEY, JSON.stringify(docs));
};

export const allowedExtensions = ['pdf', 'docx', 'txt', 'png', 'jpg', 'jpeg', 'webp'];

export const isDuplicateUploadToday = (docs, fileName) => {
  const today = fmtDate(new Date());
  const baseTitle = fileName.replace(/\.(pdf|docx|txt|png|jpg|jpeg|webp)$/i, '');
  return docs.some((doc) => doc.title === baseTitle && fmtDate(doc.uploadedAt) === today);
};
