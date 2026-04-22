import argparse
import time

from .config import DOCUMENT_WORKER_BATCH_SIZE, DOCUMENT_WORKER_POLL_SECONDS
from .db import init_db
from .document_processing import process_queued_documents_once
from .utils import parse_int


def _build_parser():
    parser = argparse.ArgumentParser(description='Process queued StudyHub document uploads.')
    parser.add_argument('--once', action='store_true', help='Process one batch and exit.')
    parser.add_argument('--limit', type=int, default=DOCUMENT_WORKER_BATCH_SIZE, help='Maximum documents per batch.')
    parser.add_argument(
        '--poll-seconds',
        type=int,
        default=DOCUMENT_WORKER_POLL_SECONDS,
        help='Seconds to sleep between empty batches.',
    )
    return parser


def main():
    args = _build_parser().parse_args()
    batch_limit = parse_int(args.limit, DOCUMENT_WORKER_BATCH_SIZE, 1, 100)
    poll_seconds = parse_int(args.poll_seconds, DOCUMENT_WORKER_POLL_SECONDS, 1, 300)

    init_db()

    while True:
        result = process_queued_documents_once(limit=batch_limit)
        print(
            'Document worker batch: '
            f"claimed={result.get('claimed_count', 0)} "
            f"processed={result.get('processed_count', 0)} "
            f"needs_ocr={result.get('needs_ocr_count', 0)} "
            f"failed={result.get('failed_count', 0)}"
        )
        if result.get('error'):
            print(f"Document worker warning: {result.get('error')}")
        if args.once:
            return 0
        if parse_int(result.get('claimed_count', 0), 0, 0) == 0:
            time.sleep(poll_seconds)


if __name__ == '__main__':
    raise SystemExit(main())
