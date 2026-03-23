import { useEffect, useMemo, useRef, useState } from 'react';

const MAX_UPLOAD_QUEUE_ITEMS = 30;

const createUploadQueueId = () =>
  `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const describeFiles = (fileList) =>
  fileList.length
    ? `Selected: ${fileList
        .map((file) => {
          const mb = (file.size / (1024 * 1024)).toFixed(2);
          return `${file.name} (${mb} MB)`;
        })
        .join(', ')}`
    : '';

export default function useUploadQueue({
  isLoggedIn,
  activeWorkspaceId,
  allowUploads,
  uploadCategory,
  autoCategorize,
  defaultCategory,
  showToast,
  showWorkspaceToast,
  onUploadsCompleted,
  resetKey,
}) {
  const [dragUploadActive, setDragUploadActive] = useState(false);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [uploadQueueRunning, setUploadQueueRunning] = useState(false);
  const [uploadQueueExpanded, setUploadQueueExpanded] = useState(true);
  const [fileHint, setFileHint] = useState('');
  const fileInputRef = useRef(null);
  const uploadDragDepthRef = useRef(0);

  const uploadQueueSummary = useMemo(() => {
    const total = uploadQueue.length;
    let queued = 0;
    let uploading = 0;
    let success = 0;
    let failed = 0;
    uploadQueue.forEach((item) => {
      if (item.status === 'uploading') uploading += 1;
      else if (item.status === 'success') success += 1;
      else if (item.status === 'failed') failed += 1;
      else queued += 1;
    });
    const done = success + failed;
    const progress = total ? Math.round((done / total) * 100) : 0;
    return { total, queued, uploading, success, failed, progress };
  }, [uploadQueue]);

  const canRetryFailedUploads = uploadQueueSummary.failed > 0 && !uploadQueueRunning;
  const canClearUploadQueue =
    !uploadQueueRunning && (uploadQueueSummary.success > 0 || uploadQueueSummary.failed > 0);

  useEffect(() => {
    if (!uploadQueue.length) {
      setUploadQueueExpanded(true);
      return;
    }
    if (uploadQueueRunning || uploadQueueSummary.failed > 0) {
      setUploadQueueExpanded(true);
    }
  }, [uploadQueue.length, uploadQueueRunning, uploadQueueSummary.failed]);

  useEffect(() => {
    setDragUploadActive(false);
    setUploadQueue([]);
    setUploadQueueRunning(false);
    setUploadQueueExpanded(true);
    setFileHint('');
    uploadDragDepthRef.current = 0;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [resetKey]);

  const clearDragUploadState = () => {
    setDragUploadActive(false);
    uploadDragDepthRef.current = 0;
  };

  const resetUploadState = () => {
    clearDragUploadState();
    setUploadQueue([]);
    setUploadQueueRunning(false);
    setUploadQueueExpanded(true);
    setFileHint('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const uploadSingleFile = async (file, activeUser) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('username', activeUser);
    if (activeWorkspaceId) {
      formData.append('workspace_id', activeWorkspaceId);
    }
    const preferredCategory = String(uploadCategory || '').trim() || (!autoCategorize ? defaultCategory : '');
    if (preferredCategory) {
      formData.append('category', preferredCategory);
    }
    try {
      const response = await fetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          ok: false,
          message: String(errorData?.error || 'Upload failed'),
        };
      }
      return { ok: true, message: '' };
    } catch {
      return {
        ok: false,
        message: 'Network error. Is backend running?',
      };
    }
  };

  const processUploadQueueItems = async (items) => {
    if (!items.length) return { successCount: 0, totalCount: 0, failedCount: 0 };
    const activeUser = sessionStorage.getItem('username');
    let successCount = 0;

    setUploadQueueRunning(true);
    try {
      for (const item of items) {
        setUploadQueue((prev) =>
          prev.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: 'uploading',
                  progress: 20,
                  message: '',
                }
              : row
          )
        );
        const result = await uploadSingleFile(item.file, activeUser);
        if (result.ok) successCount += 1;
        setUploadQueue((prev) =>
          prev.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: result.ok ? 'success' : 'failed',
                  progress: result.ok ? 100 : 0,
                  message: result.ok ? 'Uploaded' : result.message,
                }
              : row
          )
        );
      }
    } finally {
      setUploadQueueRunning(false);
    }

    const totalCount = items.length;
    const failedCount = Math.max(0, totalCount - successCount);
    return { successCount, totalCount, failedCount };
  };

  const uploadFiles = async (candidateFiles) => {
    if (!isLoggedIn) {
      showToast('Please sign in before uploading.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    if (!allowUploads) {
      showToast('Uploads are disabled in this workspace settings.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    if (!activeWorkspaceId) {
      showToast('Please select a workspace first.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    const files = Array.from(candidateFiles || []).filter((file) => file instanceof File);
    if (!files.length) {
      showToast('Please choose at least one file first.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    if (uploadQueueRunning) {
      showToast('Uploads are in progress. Please wait for current queue.', 'warning');
      return { successCount: 0, totalCount: files.length };
    }

    const availableSlots = Math.max(0, MAX_UPLOAD_QUEUE_ITEMS - uploadQueue.length);
    if (availableSlots <= 0) {
      showToast(
        `Upload queue is full (max ${MAX_UPLOAD_QUEUE_ITEMS}). Clear finished items before adding more.`,
        'warning'
      );
      return { successCount: 0, totalCount: files.length };
    }

    const acceptedFiles = files.slice(0, availableSlots);
    if (acceptedFiles.length < files.length) {
      showToast(
        `Queue accepts up to ${MAX_UPLOAD_QUEUE_ITEMS} items. Added first ${acceptedFiles.length} file(s).`,
        'warning'
      );
    }

    const queueItems = acceptedFiles.map((file) => ({
      id: createUploadQueueId(),
      file,
      name: file.name,
      size: file.size,
      status: 'queued',
      progress: 0,
      message: '',
    }));
    setUploadQueue((prev) => [...queueItems, ...prev]);

    const result = await processUploadQueueItems(queueItems);
    if (result.successCount > 0) {
      await onUploadsCompleted?.(result);
    }
    if (result.failedCount > 0) {
      showToast(
        `Upload finished: ${result.successCount}/${result.totalCount} success, ${result.failedCount} failed.`,
        'warning'
      );
    } else {
      showWorkspaceToast('upload', `Upload complete! (${result.successCount}/${result.totalCount} success)`, 'success');
    }
    return { successCount: result.successCount, totalCount: result.totalCount };
  };

  const handleRetryFailedUploads = async () => {
    if (uploadQueueRunning) return;
    const failedItems = uploadQueue.filter((item) => item.status === 'failed' && item.file instanceof File);
    if (!failedItems.length) {
      showToast('No failed uploads to retry.', 'info');
      return;
    }
    setUploadQueue((prev) =>
      prev.map((item) =>
        item.status === 'failed'
          ? {
              ...item,
              status: 'queued',
              progress: 0,
              message: '',
            }
          : item
      )
    );
    const result = await processUploadQueueItems(failedItems);
    if (result.successCount > 0) {
      await onUploadsCompleted?.(result);
    }
    if (result.failedCount > 0) {
      showToast(`Retry finished: ${result.successCount}/${result.totalCount} succeeded.`, 'warning');
    } else {
      showWorkspaceToast('upload', 'All failed uploads retried successfully.', 'success');
    }
  };

  const handleClearCompletedUploads = () => {
    if (uploadQueueRunning) return;
    setUploadQueue((prev) => prev.filter((item) => item.status === 'queued' || item.status === 'uploading'));
  };

  const handleFileChange = (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      setFileHint('');
      return;
    }
    setFileHint(describeFiles(files));
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    const files = Array.from(fileInputRef.current?.files || []);
    const { successCount } = await uploadFiles(files);
    if (successCount > 0 && fileInputRef.current) {
      fileInputRef.current.value = '';
      setFileHint('');
    }
  };

  const handleUploadDragEnter = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!allowUploads) return;
    uploadDragDepthRef.current += 1;
    setDragUploadActive(true);
  };

  const handleUploadDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!allowUploads) return;
    if (!dragUploadActive) setDragUploadActive(true);
  };

  const handleUploadDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!allowUploads) return;
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);
    if (uploadDragDepthRef.current === 0) {
      setDragUploadActive(false);
    }
  };

  const handleUploadDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!allowUploads) return;
    uploadDragDepthRef.current = 0;
    setDragUploadActive(false);
    const droppedFiles = Array.from(event.dataTransfer?.files || []).filter((file) => file instanceof File);
    if (!droppedFiles.length) return;
    setFileHint(describeFiles(droppedFiles));
    const { successCount } = await uploadFiles(droppedFiles);
    if (successCount > 0 && fileInputRef.current) {
      fileInputRef.current.value = '';
      setFileHint('');
    }
  };

  return {
    dragUploadActive,
    uploadQueue,
    uploadQueueRunning,
    uploadQueueExpanded,
    setUploadQueueExpanded,
    fileHint,
    fileInputRef,
    uploadQueueSummary,
    canRetryFailedUploads,
    canClearUploadQueue,
    handleFileChange,
    handleUpload,
    handleUploadDragEnter,
    handleUploadDragOver,
    handleUploadDragLeave,
    handleUploadDrop,
    handleRetryFailedUploads,
    handleClearCompletedUploads,
    clearDragUploadState,
    resetUploadState,
  };
}
