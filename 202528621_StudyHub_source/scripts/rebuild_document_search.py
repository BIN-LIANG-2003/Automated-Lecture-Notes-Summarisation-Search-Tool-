from backend.db import get_db_connection, init_db
from backend.document_search import rebuild_document_search_index


def main():
    init_db()
    conn = get_db_connection()
    if not conn:
        raise SystemExit('Database connection failed')

    try:
        result = rebuild_document_search_index(conn)
        conn.commit()
        print(result)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
