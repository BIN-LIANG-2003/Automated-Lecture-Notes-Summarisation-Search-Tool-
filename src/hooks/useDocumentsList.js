import { useEffect, useMemo, useRef, useState } from 'react';

export default function useDocumentsList({
  username,
  authToken,
  activeWorkspaceId,
  defaultFilters,
  defaultDocumentsPageSize,
  defaultDocumentsSort,
  defaultDocumentsLayout,
  defaultNoteCategory,
  suggestedCategories,
  fileTypeFilterOptions,
  filterDateRangeOptions,
  loadViewPreferences,
  persistViewPreferences,
  normalizeDocumentsPageSize,
  normalizeDocumentsSort,
  normalizeDocumentsLayout,
  normalizeFileTypeFilter,
  normalizeFacetFileTypeCounts,
  buildFileTypeCountsFromDocuments,
  normalizeDocument,
  normalizeCategory,
  getQuickDateRange,
  formatDisplayDateValue,
  getFileTypeFilterLabel,
}) {
  const [documents, setDocuments] = useState([]);
  const [documentsTotal, setDocumentsTotal] = useState(0);
  const [documentsPage, setDocumentsPage] = useState(1);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsLoadError, setDocumentsLoadError] = useState('');
  const [documentsPageSize, setDocumentsPageSize] = useState(
    () => loadViewPreferences().pageSize
  );
  const [documentsSort, setDocumentsSort] = useState(
    () => loadViewPreferences().sort
  );
  const [documentsLayout, setDocumentsLayout] = useState(
    () => loadViewPreferences().layout
  );
  const [filters, setFilters] = useState(defaultFilters);
  const [searchDraft, setSearchDraft] = useState('');
  const [availableTags, setAvailableTags] = useState([]);
  const [availableCategories, setAvailableCategories] = useState([]);
  const [availableFileTypeCounts, setAvailableFileTypeCounts] = useState({});
  const documentsRequestSeqRef = useRef(0);

  const buildDocumentsQueryParams = ({
    limit,
    offset,
    sort,
    includeMeta = false,
    includeFacets = false,
  } = {}) => {
    const params = new URLSearchParams({ username });
    if (activeWorkspaceId) params.set('workspace_id', activeWorkspaceId);
    if (includeMeta) params.set('include_meta', '1');
    if (includeFacets) params.set('include_facets', '1');
    if (Number.isFinite(Number(limit)) && Number(limit) > 0) params.set('limit', String(Number(limit)));
    if (Number.isFinite(Number(offset)) && Number(offset) >= 0) params.set('offset', String(Number(offset)));
    const sortKey = normalizeDocumentsSort(sort || documentsSort);
    if (sortKey) params.set('sort', sortKey);
    if (filters.query) params.set('q', filters.query);
    if (filters.start) params.set('start_date', filters.start);
    if (filters.end) params.set('end_date', filters.end);
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.category) params.set('category', filters.category);
    if (filters.fileType) params.set('file_type', normalizeFileTypeFilter(filters.fileType));
    return params;
  };

  const fetchDocuments = async (targetPage = documentsPage) => {
    const requestSeq = documentsRequestSeqRef.current + 1;
    documentsRequestSeqRef.current = requestSeq;
    const commitIfLatest = (callback) => {
      if (requestSeq !== documentsRequestSeqRef.current) return;
      callback();
    };

    if (!username || !authToken || !activeWorkspaceId) {
      commitIfLatest(() => {
        setDocuments([]);
        setDocumentsTotal(0);
        setDocumentsLoading(false);
        setDocumentsLoadError('');
        setAvailableTags([]);
        setAvailableCategories([]);
        setAvailableFileTypeCounts({});
      });
      return;
    }

    const safePage = Math.max(1, Number(targetPage) || 1);
    const pageSize = normalizeDocumentsPageSize(documentsPageSize);
    const offset = (safePage - 1) * pageSize;
    const params = buildDocumentsQueryParams({
      limit: pageSize,
      offset,
      sort: documentsSort,
      includeMeta: true,
      includeFacets: true,
    });

    commitIfLatest(() => {
      setDocumentsLoading(true);
      setDocumentsLoadError('');
    });

    try {
      const res = await fetch(`/api/documents?${params.toString()}`);
      if (res.ok) {
        const payload = await res.json().catch(() => ({}));
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const total = Number(payload?.total);
        const facetTags = Array.isArray(payload?.facets?.tags) ? payload.facets.tags : [];
        const facetCategories = Array.isArray(payload?.facets?.categories) ? payload.facets.categories : [];
        const facetFileTypeCounts = normalizeFacetFileTypeCounts(payload?.facets?.file_types);
        const normalized = items.map(normalizeDocument);
        const normalizedFacetTags = Array.from(
          new Set(
            facetTags
              .map((tag) => String(tag || '').trim())
              .filter(Boolean)
          )
        ).sort((a, b) => a.localeCompare(b));
        const normalizedFacetCategories = Array.from(
          new Set(
            facetCategories
              .map((category) => normalizeCategory(category))
              .filter(Boolean)
          )
        ).sort((a, b) => a.localeCompare(b));
        const hasFacetPayload =
          normalizedFacetTags.length ||
          normalizedFacetCategories.length ||
          Object.keys(facetFileTypeCounts).length;
        const fallbackTags = new Set();
        const fallbackCategories = new Set();
        const fallbackFileTypeCounts = buildFileTypeCountsFromDocuments(normalized);
        if (!hasFacetPayload) {
          normalized.forEach((doc) => {
            (doc.tags || []).forEach((tag) => fallbackTags.add(tag));
            fallbackCategories.add(normalizeCategory(doc.category));
          });
        }
        commitIfLatest(() => {
          setDocuments(normalized);
          setDocumentsTotal(Number.isFinite(total) ? Math.max(0, total) : normalized.length);
          if (hasFacetPayload) {
            setAvailableTags(normalizedFacetTags);
            setAvailableCategories(normalizedFacetCategories);
            setAvailableFileTypeCounts(
              Object.keys(facetFileTypeCounts).length ? facetFileTypeCounts : fallbackFileTypeCounts
            );
          } else {
            setAvailableTags(Array.from(fallbackTags).sort((a, b) => a.localeCompare(b)));
            setAvailableCategories(Array.from(fallbackCategories).sort((a, b) => a.localeCompare(b)));
            setAvailableFileTypeCounts(fallbackFileTypeCounts);
          }
        });
      } else {
        const payload = await res.json().catch(() => ({}));
        commitIfLatest(() => {
          setDocuments([]);
          setDocumentsTotal(0);
          setAvailableTags([]);
          setAvailableCategories([]);
          setAvailableFileTypeCounts({});
          setDocumentsLoadError(payload.error || 'Failed to load documents');
        });
      }
    } catch (err) {
      console.error('Failed to fetch documents', err);
      commitIfLatest(() => {
        setDocuments([]);
        setDocumentsTotal(0);
        setAvailableTags([]);
        setAvailableCategories([]);
        setAvailableFileTypeCounts({});
        setDocumentsLoadError('Failed to load documents');
      });
    } finally {
      commitIfLatest(() => {
        setDocumentsLoading(false);
      });
    }
  };

  useEffect(() => {
    fetchDocuments(documentsPage);
  }, [
    username,
    authToken,
    activeWorkspaceId,
    documentsPage,
    documentsPageSize,
    documentsSort,
    filters.query,
    filters.start,
    filters.end,
    filters.tag,
    filters.category,
    filters.fileType,
  ]);

  useEffect(() => {
    persistViewPreferences({
      pageSize: documentsPageSize,
      sort: documentsSort,
      layout: documentsLayout,
    });
  }, [documentsPageSize, documentsSort, documentsLayout, persistViewPreferences]);

  const filteredDocuments = documents;
  const documentsPageCount = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil((Number(documentsTotal) || 0) / normalizeDocumentsPageSize(documentsPageSize))
      ),
    [documentsTotal, documentsPageSize, normalizeDocumentsPageSize]
  );

  useEffect(() => {
    if (documentsPage <= documentsPageCount) return;
    setDocumentsPage(documentsPageCount);
  }, [documentsPage, documentsPageCount]);

  const pageTags = useMemo(() => {
    const bag = new Set();
    documents.forEach((doc) => (doc.tags || []).forEach((tag) => bag.add(tag)));
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [documents]);

  const tags = useMemo(() => {
    const bag = new Set([...(availableTags || []), ...pageTags]);
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [availableTags, pageTags]);

  const pageCategories = useMemo(() => {
    const bag = new Set();
    documents.forEach((doc) => {
      const category = normalizeCategory(doc.category);
      if (category) bag.add(category);
    });
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [documents, normalizeCategory]);

  const categories = useMemo(() => {
    const bag = new Set([...(availableCategories || []), ...pageCategories]);
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [availableCategories, pageCategories]);

  const categorySuggestions = useMemo(() => {
    const bag = new Set([...(suggestedCategories || []), ...categories]);
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [categories, suggestedCategories]);

  useEffect(() => {
    if (!filters.tag) return;
    if (!tags.includes(filters.tag)) {
      setFilters((prev) => ({ ...prev, tag: '' }));
    }
  }, [tags, filters.tag]);

  useEffect(() => {
    if (!filters.category) return;
    if (!categories.includes(filters.category)) {
      setFilters((prev) => ({ ...prev, category: '' }));
    }
  }, [categories, filters.category]);

  const advancedFilterCount = useMemo(() => {
    let count = 0;
    if (filters.start || filters.end) count += 1;
    if (filters.category) count += 1;
    if (filters.tag) count += 1;
    if (filters.fileType) count += 1;
    return count;
  }, [filters.start, filters.end, filters.category, filters.tag, filters.fileType]);

  const hasAdvancedFilters = advancedFilterCount > 0;

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.query) count += 1;
    if (filters.start || filters.end) count += 1;
    if (filters.category) count += 1;
    if (filters.tag) count += 1;
    if (filters.fileType) count += 1;
    return count;
  }, [filters.query, filters.start, filters.end, filters.category, filters.tag, filters.fileType]);

  const fileTypeFilterCounts = useMemo(() => {
    const source =
      availableFileTypeCounts && typeof availableFileTypeCounts === 'object' ? availableFileTypeCounts : {};
    const output = { '': Math.max(0, Number(documentsTotal) || 0) };
    fileTypeFilterOptions.forEach((option) => {
      const key = normalizeFileTypeFilter(option.value);
      if (!key) return;
      output[key] = Math.max(0, Number(source[key]) || 0);
    });
    return output;
  }, [availableFileTypeCounts, documentsTotal, fileTypeFilterOptions, normalizeFileTypeFilter]);

  const hasActiveFilters = activeFilterCount > 0;

  const activeDateRangePresetId = useMemo(() => {
    if (!filters.start && !filters.end) return 'all';
    const matched = filterDateRangeOptions.find((option) => {
      if (option.daysBack === null) return false;
      const range = getQuickDateRange(option.daysBack);
      return range.start === filters.start && range.end === filters.end;
    });
    return matched?.id || '';
  }, [filters.start, filters.end, filterDateRangeOptions, getQuickDateRange]);

  const activeQuickFilterPresetId = useMemo(() => {
    const normalized = {
      query: String(filters.query || '').trim(),
      start: String(filters.start || '').trim(),
      end: String(filters.end || '').trim(),
      tag: String(filters.tag || '').trim(),
      category: String(filters.category || '').trim(),
      fileType: normalizeFileTypeFilter(filters.fileType),
    };
    const recent7 = getQuickDateRange(6);
    if (
      !normalized.query &&
      !normalized.tag &&
      !normalized.category &&
      !normalized.fileType &&
      normalized.start === recent7.start &&
      normalized.end === recent7.end
    ) {
      return 'recent7';
    }
    if (
      !normalized.query &&
      !normalized.start &&
      !normalized.end &&
      !normalized.tag &&
      !normalized.category &&
      normalized.fileType === 'image'
    ) {
      return 'images';
    }
    if (
      !normalized.query &&
      !normalized.start &&
      !normalized.end &&
      !normalized.tag &&
      !normalized.category &&
      normalized.fileType === 'editable'
    ) {
      return 'editable';
    }
    if (
      !normalized.query &&
      !normalized.start &&
      !normalized.end &&
      !normalized.tag &&
      !normalized.fileType &&
      normalized.category === defaultNoteCategory
    ) {
      return 'uncategorized';
    }
    return '';
  }, [
    filters.query,
    filters.start,
    filters.end,
    filters.tag,
    filters.category,
    filters.fileType,
    normalizeFileTypeFilter,
    getQuickDateRange,
    defaultNoteCategory,
  ]);

  const activeFilterChips = useMemo(() => {
    const chips = [];
    const query = String(filters.query || '').trim();
    if (query) {
      chips.push({ id: 'query', label: `Keyword: ${query}` });
    }
    if (filters.start || filters.end) {
      chips.push({
        id: 'date',
        label: `Date: ${formatDisplayDateValue(filters.start)} - ${formatDisplayDateValue(filters.end)}`,
      });
    }
    if (filters.category) {
      chips.push({ id: 'category', label: `Category: ${filters.category}` });
    }
    if (filters.tag) {
      chips.push({ id: 'tag', label: `Tag: ${filters.tag}` });
    }
    if (filters.fileType) {
      chips.push({
        id: 'fileType',
        label: `Type: ${getFileTypeFilterLabel(filters.fileType)}`,
      });
    }
    return chips;
  }, [filters.query, filters.start, filters.end, filters.category, filters.tag, filters.fileType, formatDisplayDateValue, getFileTypeFilterLabel]);

  const currentViewSnapshot = useMemo(
    () => ({
      filters: {
        query: String(filters.query || '').trim(),
        start: String(filters.start || '').trim(),
        end: String(filters.end || '').trim(),
        tag: String(filters.tag || '').trim(),
        category: String(filters.category || '').trim(),
        fileType: normalizeFileTypeFilter(filters.fileType),
      },
      sort: normalizeDocumentsSort(documentsSort),
      pageSize: normalizeDocumentsPageSize(documentsPageSize),
      layout: normalizeDocumentsLayout(documentsLayout),
    }),
    [
      filters.query,
      filters.start,
      filters.end,
      filters.tag,
      filters.category,
      filters.fileType,
      documentsSort,
      documentsPageSize,
      documentsLayout,
      normalizeFileTypeFilter,
      normalizeDocumentsSort,
      normalizeDocumentsPageSize,
      normalizeDocumentsLayout,
    ]
  );

  const resetDocumentsData = () => {
    setDocuments([]);
    setDocumentsTotal(0);
    setDocumentsPage(1);
    setDocumentsLoading(false);
    setDocumentsLoadError('');
    setAvailableTags([]);
    setAvailableCategories([]);
    setAvailableFileTypeCounts({});
  };

  const resetDocumentsView = () => {
    setFilters({ ...defaultFilters });
    setSearchDraft('');
    setDocumentsSort(defaultDocumentsSort);
    setDocumentsPageSize(defaultDocumentsPageSize);
    setDocumentsLayout(defaultDocumentsLayout);
    setDocumentsPage(1);
  };

  return {
    documents,
    setDocuments,
    documentsTotal,
    setDocumentsTotal,
    documentsPage,
    setDocumentsPage,
    documentsLoading,
    setDocumentsLoading,
    documentsLoadError,
    setDocumentsLoadError,
    documentsPageSize,
    setDocumentsPageSize,
    documentsSort,
    setDocumentsSort,
    documentsLayout,
    setDocumentsLayout,
    filters,
    setFilters,
    searchDraft,
    setSearchDraft,
    availableTags,
    setAvailableTags,
    availableCategories,
    setAvailableCategories,
    availableFileTypeCounts,
    setAvailableFileTypeCounts,
    buildDocumentsQueryParams,
    fetchDocuments,
    filteredDocuments,
    documentsPageCount,
    tags,
    categories,
    categorySuggestions,
    fileTypeFilterCounts,
    activeFilterCount,
    hasActiveFilters,
    advancedFilterCount,
    hasAdvancedFilters,
    activeDateRangePresetId,
    activeQuickFilterPresetId,
    activeFilterChips,
    currentViewSnapshot,
    resetDocumentsData,
    resetDocumentsView,
  };
}
