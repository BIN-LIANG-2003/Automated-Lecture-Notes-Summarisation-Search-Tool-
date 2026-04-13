import re


DOCUMENT_RESULT_COLUMNS = (
    'id',
    'filename',
    'title',
    'uploaded_at',
    'file_type',
    'content',
    'content_html',
    'tags',
    'category',
    'workspace_id',
    'username',
    'last_access_at',
    'deleted_at',
    'processing_status',
    'processing_error',
    'processed_at',
)

DOCUMENT_RESULT_COLUMNS_SQL = ', '.join(DOCUMENT_RESULT_COLUMNS)

IMAGE_FILE_TYPES = ('png', 'jpg', 'jpeg', 'webp', 'gif')
EDITABLE_FILE_TYPES = ('txt', 'docx')

SQLITE_SEARCH_TABLE = 'documents_search'
SQLITE_INSERT_TRIGGER = 'documents_search_ai'
SQLITE_UPDATE_TRIGGER = 'documents_search_au'
SQLITE_DELETE_TRIGGER = 'documents_search_ad'
POSTGRES_SEARCH_INDEX = 'idx_documents_search_vector'

_SEARCH_TOKEN_RE = re.compile(r'[^\W_]+', re.UNICODE)


def _active_deleted_sql(table_alias='d'):
    return f"COALESCE(TRIM(CAST({table_alias}.deleted_at AS TEXT)), '') = ''"


def _trashed_deleted_sql(table_alias='d'):
    return f"COALESCE(TRIM(CAST({table_alias}.deleted_at AS TEXT)), '') <> ''"


def _uploaded_at_text_sql(table_alias='d'):
    return f"REPLACE(COALESCE(CAST({table_alias}.uploaded_at AS TEXT), ''), ' ', 'T')"


def _normalized_search_text(value):
    return re.sub(r'\s+', ' ', str(value or '').strip().lower())


def _search_tokens(value):
    tokens = []
    for match in _SEARCH_TOKEN_RE.findall(str(value or '').lower()):
        token = match.strip()
        if not token:
            continue
        if token not in tokens:
            tokens.append(token[:48])
        if len(tokens) >= 8:
            break
    return tokens


def _build_sqlite_match_query(query_text):
    tokens = _search_tokens(query_text)
    if not tokens:
        return ''
    return ' AND '.join(f'{token}*' for token in tokens)


def _build_postgres_tsquery(query_text):
    tokens = _search_tokens(query_text)
    if not tokens:
        return ''
    return ' & '.join(f'{token}:*' for token in tokens)


def _postgres_search_vector_sql(table_alias='d'):
    prefix = f'{table_alias}.' if table_alias else ''
    return (
        f"setweight(to_tsvector('simple', COALESCE({prefix}title, '')), 'A') || "
        f"setweight(to_tsvector('simple', COALESCE({prefix}category, '')), 'B') || "
        f"setweight(to_tsvector('simple', REPLACE(COALESCE({prefix}tags, ''), ',', ' ')), 'B') || "
        f"setweight(to_tsvector('simple', COALESCE({prefix}content, '')), 'D')"
    )


def _file_type_filter_sql(table_alias, file_type_filter):
    safe_filter = str(file_type_filter or '').strip().lower().lstrip('.')
    if not safe_filter:
        return '', []
    column_sql = f"LOWER(COALESCE({table_alias}.file_type, ''))"
    if safe_filter in ('image', 'images'):
        placeholders = ','.join('?' for _ in IMAGE_FILE_TYPES)
        return f'{column_sql} IN ({placeholders})', list(IMAGE_FILE_TYPES)
    if safe_filter in ('editable', 'editables'):
        placeholders = ','.join('?' for _ in EDITABLE_FILE_TYPES)
        return f'{column_sql} IN ({placeholders})', list(EDITABLE_FILE_TYPES)
    if safe_filter.isalnum() and len(safe_filter) <= 12:
        return f'{column_sql} = ?', [safe_filter]
    return '', []


def build_document_filter_clauses(
    username,
    workspace_id='',
    category_filter='',
    tag_filter='',
    start_date='',
    end_date='',
    file_type_filter='',
    table_alias='d',
    include_deleted=False,
):
    where_parts = [
        f'{table_alias}.username = ?',
        _trashed_deleted_sql(table_alias) if include_deleted else _active_deleted_sql(table_alias),
    ]
    params = [str(username or '').strip()]

    safe_workspace_id = str(workspace_id or '').strip()
    if safe_workspace_id:
        where_parts.append(f'{table_alias}.workspace_id = ?')
        params.append(safe_workspace_id)

    safe_category_filter = str(category_filter or '').strip().lower()
    if safe_category_filter:
        where_parts.append(f"LOWER(COALESCE({table_alias}.category, '')) = ?")
        params.append(safe_category_filter)

    safe_tag_filter = str(tag_filter or '').strip().lower()
    if safe_tag_filter:
        where_parts.append(f"(',' || LOWER(COALESCE({table_alias}.tags, '')) || ',') LIKE ?")
        params.append(f'%,{safe_tag_filter},%')

    safe_start_date = str(start_date or '').strip()
    if safe_start_date:
        where_parts.append(f'{_uploaded_at_text_sql(table_alias)} >= ?')
        params.append(f'{safe_start_date}T00:00:00')

    safe_end_date = str(end_date or '').strip()
    if safe_end_date:
        where_parts.append(f'{_uploaded_at_text_sql(table_alias)} <= ?')
        params.append(f'{safe_end_date}T23:59:59')

    file_type_sql, file_type_params = _file_type_filter_sql(table_alias, file_type_filter)
    if file_type_sql:
        where_parts.append(file_type_sql)
        params.extend(file_type_params)

    return where_parts, params


def _build_like_patterns(query_text):
    safe_query = _normalized_search_text(query_text)
    return {
        'exact': safe_query,
        'prefix': f'{safe_query}%',
        'contains': f'%{safe_query}%',
        'tag_exact': f'%,{safe_query},%',
    }


def _build_search_boost_sql(table_alias='d'):
    return (
        "CASE "
        f"WHEN LOWER(COALESCE({table_alias}.title, '')) = ? THEN 500 "
        f"WHEN LOWER(COALESCE({table_alias}.title, '')) LIKE ? THEN 320 "
        f"WHEN (',' || LOWER(COALESCE({table_alias}.tags, '')) || ',') LIKE ? THEN 220 "
        f"WHEN LOWER(COALESCE({table_alias}.category, '')) LIKE ? THEN 160 "
        f"WHEN LOWER(COALESCE({table_alias}.content, '')) LIKE ? THEN 80 "
        "ELSE 0 END"
    )


def _build_search_boost_params(query_text):
    patterns = _build_like_patterns(query_text)
    return [
        patterns['exact'],
        patterns['prefix'],
        patterns['tag_exact'],
        patterns['contains'],
        patterns['contains'],
    ]


def _sqlite_search_available(conn):
    if getattr(conn, 'db_type', '') != 'sqlite':
        return False
    try:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            (SQLITE_SEARCH_TABLE,),
        )
        return cursor.fetchone() is not None
    except Exception:
        return False


def _build_sqlite_search_sql(query_text):
    match_query = _build_sqlite_match_query(query_text)
    if not match_query:
        return None

    boost_sql = _build_search_boost_sql('d')
    select_sql = f'''
        d.*,
        {boost_sql} AS search_boost,
        search_index.search_rank AS search_rank
    '''
    from_sql = f'''
        documents d
        JOIN (
            SELECT rowid AS doc_id, bm25({SQLITE_SEARCH_TABLE}, 10.0, 4.0, 2.5, 1.0) AS search_rank
            FROM {SQLITE_SEARCH_TABLE}
            WHERE {SQLITE_SEARCH_TABLE} MATCH ?
        ) search_index ON search_index.doc_id = d.id
    '''
    params = [*_build_search_boost_params(query_text), match_query]
    return {
        'mode': 'sqlite_fts',
        'select_sql': select_sql,
        'from_sql': from_sql,
        'params': params,
        'order_sql': 'search_boost DESC, search_rank ASC',
    }


def _build_postgres_search_sql(query_text):
    tsquery = _build_postgres_tsquery(query_text)
    if not tsquery:
        return None

    vector_sql = _postgres_search_vector_sql('d')
    boost_sql = _build_search_boost_sql('d')
    select_sql = f'''
        d.*,
        {boost_sql} AS search_boost,
        ts_rank_cd({vector_sql}, to_tsquery('simple', ?)) AS search_rank
    '''
    params = [*_build_search_boost_params(query_text), tsquery]
    where_parts = [f'{vector_sql} @@ to_tsquery(\'simple\', ?)']
    where_params = [tsquery]
    return {
        'mode': 'postgres_fts',
        'select_sql': select_sql,
        'from_sql': 'documents d',
        'where_parts': where_parts,
        'where_params': where_params,
        'params': params,
        'order_sql': 'search_boost DESC, search_rank DESC',
    }


def _build_like_search_sql(query_text):
    patterns = _build_like_patterns(query_text)
    if not patterns['exact']:
        return None

    boost_sql = _build_search_boost_sql('d')
    rank_sql = (
        "CASE "
        "WHEN LOWER(COALESCE(d.title, '')) = ? THEN 1000 "
        "WHEN LOWER(COALESCE(d.title, '')) LIKE ? THEN 700 "
        "WHEN (',' || LOWER(COALESCE(d.tags, '')) || ',') LIKE ? THEN 520 "
        "WHEN LOWER(COALESCE(d.category, '')) LIKE ? THEN 360 "
        "WHEN LOWER(COALESCE(d.content, '')) LIKE ? THEN 140 "
        "ELSE 0 END"
    )
    match_sql = (
        "("
        "LOWER(COALESCE(d.title, '')) LIKE ? OR "
        "LOWER(COALESCE(d.category, '')) LIKE ? OR "
        "LOWER(COALESCE(d.content, '')) LIKE ? OR "
        "LOWER(COALESCE(d.tags, '')) LIKE ?"
        ")"
    )
    select_sql = f'''
        d.*,
        {boost_sql} AS search_boost,
        {rank_sql} AS search_rank
    '''
    params = [
        *_build_search_boost_params(query_text),
        patterns['exact'],
        patterns['prefix'],
        patterns['tag_exact'],
        patterns['contains'],
        patterns['contains'],
    ]
    where_parts = [match_sql]
    where_params = [
        patterns['contains'],
        patterns['contains'],
        patterns['contains'],
        patterns['contains'],
    ]
    return {
        'mode': 'like',
        'select_sql': select_sql,
        'from_sql': 'documents d',
        'where_parts': where_parts,
        'where_params': where_params,
        'params': params,
        'order_sql': 'search_boost DESC, search_rank DESC',
    }


def build_document_listing_base_query(
    conn,
    username,
    query='',
    workspace_id='',
    category_filter='',
    tag_filter='',
    start_date='',
    end_date='',
    file_type_filter='',
):
    filter_where_parts, filter_params = build_document_filter_clauses(
        username=username,
        workspace_id=workspace_id,
        category_filter=category_filter,
        tag_filter=tag_filter,
        start_date=start_date,
        end_date=end_date,
        file_type_filter=file_type_filter,
        table_alias='d',
    )
    safe_query = str(query or '').strip()
    search_plan = None
    if safe_query:
        if getattr(conn, 'db_type', '') == 'sqlite' and _sqlite_search_available(conn):
            search_plan = _build_sqlite_search_sql(safe_query)
        elif getattr(conn, 'db_type', '') == 'postgres':
            search_plan = _build_postgres_search_sql(safe_query)
        if search_plan is None:
            search_plan = _build_like_search_sql(safe_query)

    if search_plan:
        select_sql = search_plan['select_sql']
        from_sql = search_plan['from_sql']
        where_parts = [*filter_where_parts, *(search_plan.get('where_parts') or [])]
        params = [*(search_plan.get('params') or []), *filter_params, *(search_plan.get('where_params') or [])]
        mode = search_plan.get('mode') or 'like'
        search_order_sql = search_plan.get('order_sql') or ''
    else:
        select_sql = 'd.*'
        from_sql = 'documents d'
        where_parts = filter_where_parts
        params = filter_params
        mode = 'none'
        search_order_sql = ''

    where_sql = ' AND '.join(where_parts)
    base_sql = f'''
        SELECT {select_sql}
        FROM {from_sql}
        WHERE {where_sql}
    '''
    return {
        'base_sql': base_sql,
        'params': params,
        'mode': mode,
        'search_order_sql': search_order_sql,
    }


def ensure_document_search_support(conn):
    if not conn:
        return {'mode': 'disabled', 'available': False, 'rebuilt': False}

    result = {
        'mode': 'disabled',
        'available': False,
        'rebuilt': False,
    }
    if getattr(conn, 'db_type', '') == 'sqlite':
        try:
            conn.execute(
                f'''
                CREATE VIRTUAL TABLE IF NOT EXISTS {SQLITE_SEARCH_TABLE}
                USING fts5(title, category, tags, content);
                '''
            )
            conn.execute(
                f'''
                CREATE TRIGGER IF NOT EXISTS {SQLITE_INSERT_TRIGGER}
                AFTER INSERT ON documents
                BEGIN
                    INSERT INTO {SQLITE_SEARCH_TABLE}(rowid, title, category, tags, content)
                    VALUES (NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.category, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.content, ''));
                END;
                '''
            )
            conn.execute(
                f'''
                CREATE TRIGGER IF NOT EXISTS {SQLITE_UPDATE_TRIGGER}
                AFTER UPDATE OF title, category, tags, content ON documents
                BEGIN
                    DELETE FROM {SQLITE_SEARCH_TABLE} WHERE rowid = OLD.id;
                    INSERT INTO {SQLITE_SEARCH_TABLE}(rowid, title, category, tags, content)
                    VALUES (NEW.id, COALESCE(NEW.title, ''), COALESCE(NEW.category, ''), COALESCE(NEW.tags, ''), COALESCE(NEW.content, ''));
                END;
                '''
            )
            conn.execute(
                f'''
                CREATE TRIGGER IF NOT EXISTS {SQLITE_DELETE_TRIGGER}
                AFTER DELETE ON documents
                BEGIN
                    DELETE FROM {SQLITE_SEARCH_TABLE} WHERE rowid = OLD.id;
                END;
                '''
            )
            if sqlite_document_search_needs_rebuild(conn):
                _rebuild_sqlite_document_search_index(conn)
                result['rebuilt'] = True
            result['mode'] = 'sqlite_fts'
            result['available'] = True
            return result
        except Exception as exc:
            print(f'⚠️ SQLite full-text search unavailable, falling back to LIKE search: {exc}')
            return result

    if getattr(conn, 'db_type', '') == 'postgres':
        savepoint_name = 'studyhub_document_search_bootstrap'
        try:
            conn.execute(f'SAVEPOINT {savepoint_name}')
            conn.execute(
                f'''
                CREATE INDEX IF NOT EXISTS {POSTGRES_SEARCH_INDEX}
                ON documents
                USING GIN (
                    (
                        {_postgres_search_vector_sql('')}
                    )
                );
                '''
            )
            conn.execute(f'RELEASE SAVEPOINT {savepoint_name}')
            result['mode'] = 'postgres_fts'
            result['available'] = True
            return result
        except Exception as exc:
            try:
                conn.execute(f'ROLLBACK TO SAVEPOINT {savepoint_name}')
                conn.execute(f'RELEASE SAVEPOINT {savepoint_name}')
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
            print(f'⚠️ PostgreSQL full-text search unavailable, falling back to LIKE search: {exc}')
            return result

    return result


def sqlite_document_search_needs_rebuild(conn):
    if not _sqlite_search_available(conn):
        return False
    try:
        missing_cursor = conn.execute(
            f'''
            SELECT COUNT(1) AS total
            FROM documents d
            LEFT JOIN {SQLITE_SEARCH_TABLE} ds ON ds.rowid = d.id
            WHERE ds.rowid IS NULL
            '''
        )
        missing_row = missing_cursor.fetchone()
        missing_count = int((missing_row.get('total') if hasattr(missing_row, 'get') else missing_row[0]) or 0)
        if missing_count:
            return True

        extra_cursor = conn.execute(
            f'''
            SELECT COUNT(1) AS total
            FROM {SQLITE_SEARCH_TABLE} ds
            LEFT JOIN documents d ON d.id = ds.rowid
            WHERE d.id IS NULL
            '''
        )
        extra_row = extra_cursor.fetchone()
        extra_count = int((extra_row.get('total') if hasattr(extra_row, 'get') else extra_row[0]) or 0)
        return extra_count > 0
    except Exception:
        return True


def rebuild_document_search_index(conn):
    if not conn:
        return {'mode': 'disabled', 'rebuilt': False}

    support = ensure_document_search_support(conn)
    if support.get('mode') != 'sqlite_fts' or not support.get('available'):
        return {
            'mode': support.get('mode') or 'disabled',
            'rebuilt': False,
            'reason': 'No SQLite FTS index to rebuild',
        }

    _rebuild_sqlite_document_search_index(conn)
    return {
        'mode': 'sqlite_fts',
        'rebuilt': True,
    }


def _rebuild_sqlite_document_search_index(conn):
    conn.execute(f'DELETE FROM {SQLITE_SEARCH_TABLE}')
    conn.execute(
        f'''
        INSERT INTO {SQLITE_SEARCH_TABLE}(rowid, title, category, tags, content)
        SELECT
            id,
            COALESCE(title, ''),
            COALESCE(category, ''),
            COALESCE(tags, ''),
            COALESCE(content, '')
        FROM documents
        '''
    )
