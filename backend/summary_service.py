import hashlib
import re
import threading

import requests

from .config import (
    HF_MODEL_BASE_URL,
    HF_SUMMARIZER_TIMEOUT_SECONDS,
    HF_TOKEN,
    SUMMARY_CHUNK_OVERLAP,
    SUMMARY_CHUNK_WORDS,
    SUMMARY_FALLBACK_ENABLED,
    SUMMARY_MIN_WORDS_FOR_BART,
    SUMMARY_PRIMARY_STRATEGY,
    SUMMARY_TARGET_MAX_WORDS,
    SUMMARIZER_MODEL_ID,
    TEXTRANK_SENTENCE_COUNT,
)
from .document_domain import normalize_newlines
from .utils import parse_int


SUMMARY_LENGTH_PRESETS = {
    'short': {'target_max_words': 90, 'textrank_sentence_count': 3},
    'medium': {'target_max_words': 140, 'textrank_sentence_count': 5},
    'long': {'target_max_words': 220, 'textrank_sentence_count': 7},
}

SUMMARY_STOPWORDS = {
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'is',
    'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'were', 'will',
    'with', 'we', 'you', 'your', 'our', 'they', 'them', 'these', 'those', 'can', 'could', 'may',
    'might', 'must', 'should', 'would', 'not', 'but', 'if', 'then', 'than', 'into', 'about',
}

_SUMMARY_IN_PROGRESS = set()
_SUMMARY_IN_PROGRESS_LOCK = threading.Lock()


def get_summary_length_targets(summary_length='medium'):
    safe_length = str(summary_length or '').strip().lower()
    preset = SUMMARY_LENGTH_PRESETS.get(safe_length)
    if not preset:
        safe_length = 'medium'
        preset = SUMMARY_LENGTH_PRESETS['medium']
    target_max_words = parse_int(preset.get('target_max_words'), SUMMARY_TARGET_MAX_WORDS, 40, 320)
    textrank_sentence_count = parse_int(
        preset.get('textrank_sentence_count'),
        TEXTRANK_SENTENCE_COUNT,
        1,
        20,
    )
    max_new_tokens = max(60, min(320, int(target_max_words * 1.35)))
    min_new_tokens = max(18, min(max_new_tokens - 10, int(max_new_tokens * 0.25)))
    return {
        'summary_length': safe_length,
        'target_max_words': target_max_words,
        'textrank_sentence_count': textrank_sentence_count,
        'sentence_limit': textrank_sentence_count,
        'max_new_tokens': max_new_tokens,
        'min_new_tokens': min_new_tokens,
    }


def clean_summary_input(text):
    normalized = normalize_newlines(text or '')
    normalized = re.sub(r'(?im)^\s*part\s+\d+\s*:\s*', '', normalized)
    normalized = re.sub(r'https?://\S+', ' ', normalized)
    normalized = re.sub(r'[ \t]+', ' ', normalized)
    normalized = re.sub(r'\n{3,}', '\n\n', normalized)
    return normalized.strip()


def build_summary_input_hash(text):
    cleaned = clean_summary_input(text)
    normalized = re.sub(r'\s+', ' ', cleaned).strip()
    if not normalized:
        return ''
    return hashlib.sha256(normalized.encode('utf-8')).hexdigest()


def summary_generation_key(document_id, input_hash):
    safe_doc_id = parse_int(document_id, 0, 0)
    safe_hash = str(input_hash or '').strip()
    if safe_doc_id <= 0 or not safe_hash:
        return None
    return safe_doc_id, safe_hash


def try_begin_summary_generation(document_id, input_hash):
    key = summary_generation_key(document_id, input_hash)
    if not key:
        return True
    with _SUMMARY_IN_PROGRESS_LOCK:
        if key in _SUMMARY_IN_PROGRESS:
            return False
        _SUMMARY_IN_PROGRESS.add(key)
        return True


def finish_summary_generation(document_id, input_hash):
    key = summary_generation_key(document_id, input_hash)
    if not key:
        return
    with _SUMMARY_IN_PROGRESS_LOCK:
        _SUMMARY_IN_PROGRESS.discard(key)


def clear_document_summary_cache(conn, document_id):
    safe_doc_id = parse_int(document_id, 0, 0)
    if safe_doc_id <= 0 or conn is None:
        return
    conn.execute('DELETE FROM document_summary_cache WHERE document_id = ?', (safe_doc_id,))
    conn.execute(
        '''
        UPDATE documents
        SET summary_text = NULL,
            summary_source = NULL,
            summary_model = NULL,
            extractive_summary = NULL,
            ai_summary = NULL,
            key_sentences_json = NULL,
            summary_generated_at = NULL,
            summary_error = NULL,
            summary_input_hash = NULL
        WHERE id = ?
        ''',
        (safe_doc_id,),
    )


def _summary_word_tokens(text):
    return re.findall(r"[A-Za-z0-9][A-Za-z0-9'-]*", str(text or '').lower())


def _split_summary_sentences(text):
    cleaned = clean_summary_input(text)
    if not cleaned:
        return []
    fragments = [
        re.sub(r'\s+', ' ', part).strip()
        for part in re.split(r'(?<=[.!?。！？])\s+|\n+', cleaned)
        if part and part.strip()
    ]
    return fragments or [cleaned]


def split_summary_chunks(text, chunk_words=None, overlap_words=None):
    cleaned = clean_summary_input(text)
    words = re.findall(r'\S+', cleaned)
    if not words:
        return []
    safe_chunk_words = max(80, int(chunk_words or SUMMARY_CHUNK_WORDS))
    safe_overlap_words = max(0, min(int(overlap_words or SUMMARY_CHUNK_OVERLAP), safe_chunk_words // 2))
    if len(words) <= safe_chunk_words:
        return [' '.join(words)]

    chunks = []
    start = 0
    while start < len(words):
        end = min(len(words), start + safe_chunk_words)
        chunk = ' '.join(words[start:end]).strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(words):
            break
        next_start = max(0, end - safe_overlap_words)
        if next_start <= start:
            next_start = end
        start = next_start
    return chunks


def _sentence_terms(sentence):
    return [
        token
        for token in _summary_word_tokens(sentence)
        if len(token) > 2 and token not in SUMMARY_STOPWORDS
    ]


def _cosine_counter_similarity(left, right):
    if not left or not right:
        return 0.0
    numerator = 0.0
    for token, count in left.items():
        numerator += count * right.get(token, 0)
    if numerator <= 0:
        return 0.0
    left_norm = sum(count * count for count in left.values()) ** 0.5
    right_norm = sum(count * count for count in right.values()) ** 0.5
    if left_norm <= 0 or right_norm <= 0:
        return 0.0
    return numerator / (left_norm * right_norm)


def _textrank_sentences(text, sentence_count=None):
    sentences = _split_summary_sentences(text)
    safe_count = max(1, int(sentence_count or TEXTRANK_SENTENCE_COUNT))
    if len(sentences) <= safe_count:
        return sentences

    vectors = []
    for sentence in sentences[:120]:
        counts = {}
        for token in _sentence_terms(sentence):
            counts[token] = counts.get(token, 0) + 1
        vectors.append(counts)

    total = len(vectors)
    graph = [[] for _ in range(total)]
    for i in range(total):
        for j in range(i + 1, total):
            weight = _cosine_counter_similarity(vectors[i], vectors[j])
            if weight > 0:
                graph[i].append((j, weight))
                graph[j].append((i, weight))

    scores = [1.0 for _ in range(total)]
    damping = 0.85
    for _ in range(24):
        next_scores = [(1.0 - damping) for _ in range(total)]
        for i, edges in enumerate(graph):
            edge_total = sum(weight for _, weight in edges)
            if edge_total <= 0:
                continue
            for j, weight in edges:
                next_scores[j] += damping * scores[i] * (weight / edge_total)
        scores = next_scores

    ranked_indexes = sorted(range(total), key=lambda idx: (scores[idx], -idx), reverse=True)[:safe_count]
    ranked_indexes.sort()
    return [sentences[idx] for idx in ranked_indexes]


def generate_extractive_summary(text, sentence_count=3):
    return ' '.join(_textrank_sentences(text, sentence_count)).strip()


def extract_key_sentences(text_content, keywords=None, limit=3, sentence_count=None):
    if isinstance(keywords, int) and sentence_count is None:
        sentence_count = keywords
        keywords = None
    safe_limit = max(1, int(sentence_count or limit or TEXTRANK_SENTENCE_COUNT))
    if not keywords:
        return _textrank_sentences(text_content, safe_limit)

    normalized = normalize_newlines(text_content or '')
    fragments = [part.strip() for part in re.split(r'(?<=[.!?。！？])\s+', normalized) if part.strip()]
    if not fragments:
        return []

    keyword_list = [
        str(item).strip().lower()
        for item in (keywords or [])
        if str(item).strip()
    ]
    keyword_list = [item for item in keyword_list if item != 'not enough text']

    scored = []
    for idx, sentence in enumerate(fragments[:150]):
        lower_sentence = sentence.lower()
        score = 0
        for keyword in keyword_list:
            score += lower_sentence.count(keyword) * 2
        score += min(len(sentence.split()) / 8.0, 1.5)
        scored.append((score, -idx, sentence))

    scored.sort(reverse=True)
    top = []
    for _, _, sentence in scored:
        if sentence in top:
            continue
        top.append(sentence)
        if len(top) >= safe_limit:
            break

    if not top:
        top = fragments[:safe_limit]
    return top


def _build_fallback_summary(text_content, sentence_limit=3, max_chars=560):
    raw_text = normalize_newlines(text_content or '')
    raw_text = re.sub(r'(?im)^\s*part\s+\d+\s*:\s*', '', raw_text)
    raw_text = re.sub(r'[ \t]+', ' ', raw_text).strip()
    if not raw_text:
        return ''

    safe_limit = max(1, int(sentence_limit or 3))
    fragments = [
        part.strip()
        for part in re.split(r'(?<=[.!?。！？])\s+|\n+', raw_text)
        if part.strip()
    ]

    if len(fragments) < safe_limit:
        compact_lines = [
            part.strip()
            for part in re.split(r'\n+', normalize_newlines(text_content or ''))
            if part.strip()
        ]
        for item in compact_lines:
            candidate = re.sub(r'\s+', ' ', item)
            if candidate and candidate not in fragments:
                fragments.append(candidate)

    if fragments:
        if len(fragments) <= safe_limit:
            picked = fragments
        else:
            picked = []
            key_indexes = [0, len(fragments) // 2, len(fragments) - 1]
            for idx in key_indexes:
                sentence = fragments[idx]
                if sentence not in picked:
                    picked.append(sentence)
                if len(picked) >= safe_limit:
                    break
            if len(picked) < safe_limit:
                for sentence in fragments:
                    if sentence in picked:
                        continue
                    picked.append(sentence)
                    if len(picked) >= safe_limit:
                        break
        summary = ' '.join(picked[:safe_limit]).strip()
    else:
        summary = raw_text

    if len(summary) > max_chars:
        text_len = len(summary)
        slice_len = max(90, max_chars // max(1, safe_limit))
        points = [0, text_len // 2, max(0, text_len - slice_len)]
        excerpts = []
        for point in points:
            start = max(0, min(point, max(0, text_len - slice_len)))
            end = min(text_len, start + slice_len)
            snippet = summary[start:end].strip()
            if snippet and snippet not in excerpts:
                excerpts.append(snippet)
        summary = ' ... '.join(excerpts).strip() or summary[:max_chars]
        if len(summary) > max_chars:
            clipped = summary[:max_chars]
            summary = clipped.rsplit(' ', 1)[0].strip() or clipped

    return summary


def _get_hf_headers(content_type=None):
    if not HF_TOKEN:
        return None
    result = {'Authorization': f'Bearer {HF_TOKEN}'}
    if content_type:
        result['Content-Type'] = content_type
    return result


def _hf_model_url(model_id):
    return f"{HF_MODEL_BASE_URL}/{model_id}"


def _is_t5_family_summarizer_model(model_id=None):
    safe_model_id = str(model_id or SUMMARIZER_MODEL_ID or '').strip().lower()
    if not safe_model_id:
        return False
    return bool(re.search(r'(^|[/-])(flan-?t5|t5|mt5|byt5)([-/]|$)', safe_model_id))


def _build_hf_summarizer_input(text_content, model_id=None):
    safe_text = str(text_content or '').strip()
    if not safe_text:
        return ''
    if not _is_t5_family_summarizer_model(model_id):
        return safe_text
    if safe_text.lower().startswith('summarize:'):
        return safe_text
    return f'summarize: {safe_text}'


def _looks_like_html_error(text):
    value = str(text or '').strip().lower()
    if not value:
        return False
    return value.startswith('<!doctype html') or value.startswith('<html') or '<html' in value[:240]


def _hf_error_message(response):
    try:
        body = response.json()
        if isinstance(body, dict):
            if body.get('error'):
                return str(body['error'])
            if body.get('message'):
                return str(body['message'])
    except Exception:
        pass
    raw_text = (response.text or '').strip()
    if _looks_like_html_error(raw_text):
        status_code = getattr(response, 'status_code', 0) or 0
        if status_code == 410:
            return (
                'Hugging Face summarizer endpoint returned 410 Gone. '
                'The configured summarizer model or inference endpoint is no longer available.'
            )
        return 'Hugging Face summarizer endpoint returned an HTML error page instead of JSON.'
    return raw_text[:240] or 'Unknown error'


def call_hf_summarizer(text, enforce_min_words=True, target_max_words=None):
    safe_text = clean_summary_input(text)
    if not safe_text:
        return {'ok': False, 'summary': '', 'error': 'Empty input text'}

    word_count = len(re.findall(r'\S+', safe_text))
    if enforce_min_words and word_count < SUMMARY_MIN_WORDS_FOR_BART:
        return {
            'ok': False,
            'summary': '',
            'error': f'Text has {word_count} words; BART requires at least {SUMMARY_MIN_WORDS_FOR_BART}.',
            'skipped': True,
        }

    hf_headers = _get_hf_headers('application/json')
    if not hf_headers:
        return {'ok': False, 'summary': '', 'error': 'HF_API_TOKEN is not configured on server.', 'skipped': True}

    safe_target_words = parse_int(target_max_words, SUMMARY_TARGET_MAX_WORDS, 40, 320)
    max_tokens = max(60, min(320, int(safe_target_words * 1.35)))
    min_tokens = max(18, min(max_tokens - 10, int(max_tokens * 0.25)))
    payload = {
        'inputs': _build_hf_summarizer_input(safe_text, SUMMARIZER_MODEL_ID),
        'parameters': {
            'max_new_tokens': max_tokens,
            'min_new_tokens': min_tokens,
            'do_sample': False,
        },
        'options': {'wait_for_model': True},
    }

    try:
        response = requests.post(
            _hf_model_url(SUMMARIZER_MODEL_ID),
            headers=hf_headers,
            json=payload,
            timeout=HF_SUMMARIZER_TIMEOUT_SECONDS,
        )
    except requests.exceptions.Timeout:
        return {
            'ok': False,
            'summary': '',
            'error': f'HF summarizer timed out after {HF_SUMMARIZER_TIMEOUT_SECONDS}s',
        }
    except Exception as exc:
        return {'ok': False, 'summary': '', 'error': str(exc) or 'AI summarizer request failed.'}

    if response.status_code >= 400:
        return {
            'ok': False,
            'summary': '',
            'error': f'HF summarizer failed ({response.status_code}): {_hf_error_message(response)}',
        }

    try:
        summary_res = response.json()
    except Exception:
        return {'ok': False, 'summary': '', 'error': f'HF summarizer returned non-JSON response: {_hf_error_message(response)}'}

    summary = ''
    if isinstance(summary_res, list) and summary_res and isinstance(summary_res[0], dict):
        summary = str(summary_res[0].get('summary_text') or summary_res[0].get('generated_text') or '').strip()
    elif isinstance(summary_res, dict):
        summary = str(summary_res.get('summary_text') or summary_res.get('generated_text') or '').strip()
    if summary:
        return {'ok': True, 'summary': summary, 'error': ''}
    return {'ok': False, 'summary': '', 'error': 'HF summarizer returned empty output.'}


def generate_abstractive_summary(text, target_max_words=None):
    cleaned = clean_summary_input(text)
    if not cleaned:
        return {'ok': False, 'summary': '', 'error': 'Empty input text', 'chunk_count': 0, 'merge_rounds': 0}

    if SUMMARY_PRIMARY_STRATEGY not in ('auto', 'bart_hf', 'hf', 'huggingface'):
        return {
            'ok': False,
            'summary': '',
            'error': f'SUMMARY_PRIMARY_STRATEGY={SUMMARY_PRIMARY_STRATEGY} disables Hugging Face summarization.',
            'chunk_count': 0,
            'merge_rounds': 0,
            'skipped': True,
        }

    chunks = split_summary_chunks(cleaned, SUMMARY_CHUNK_WORDS, SUMMARY_CHUNK_OVERLAP)
    if not chunks:
        return {'ok': False, 'summary': '', 'error': 'Empty input text', 'chunk_count': 0, 'merge_rounds': 0}

    if len(chunks) == 1:
        result = call_hf_summarizer(chunks[0], target_max_words=target_max_words)
        result['chunk_count'] = 1
        result['merge_rounds'] = 0
        return result

    chunk_summaries = []
    errors = []
    for chunk in chunks:
        result = call_hf_summarizer(chunk, enforce_min_words=False, target_max_words=target_max_words)
        if not result.get('ok'):
            error = str(result.get('error') or '').strip()
            if error and error not in errors:
                errors.append(error)
            return {
                'ok': False,
                'summary': '',
                'error': '; '.join(errors) or 'Chunk summarization failed.',
                'chunk_count': len(chunks),
                'merge_rounds': 0,
            }
        chunk_summaries.append(str(result.get('summary') or '').strip())

    merged_input = clean_summary_input('\n\n'.join(chunk_summaries))
    merged = call_hf_summarizer(merged_input, enforce_min_words=False, target_max_words=target_max_words)
    merged['chunk_count'] = len(chunks)
    merged['merge_rounds'] = 1
    return merged


def build_summary_bundle(text, summary_length='medium', target_max_words=None, textrank_sentence_count=None):
    cleaned = clean_summary_input(text)
    targets = get_summary_length_targets(summary_length)
    safe_target_words = parse_int(target_max_words, targets['target_max_words'], 40, 320)
    sentence_count = parse_int(textrank_sentence_count, targets['textrank_sentence_count'], 1, 20)

    key_sentences = _textrank_sentences(cleaned, sentence_count)
    extractive_summary = generate_extractive_summary(cleaned, sentence_count)
    if not extractive_summary and cleaned:
        extractive_summary = _build_fallback_summary(
            cleaned,
            sentence_limit=sentence_count,
            max_chars=safe_target_words * 8,
        )

    ai_result = generate_abstractive_summary(cleaned, target_max_words=safe_target_words)
    ai_summary = str(ai_result.get('summary') or '').strip() if ai_result.get('ok') else ''
    error = str(ai_result.get('error') or '').strip()

    if ai_summary:
        summary_text = ai_summary
        summary_source = 'bart_hf'
        used_fallback = False
    elif SUMMARY_FALLBACK_ENABLED:
        summary_text = extractive_summary
        summary_source = 'textrank_only' if ai_result.get('skipped') else 'textrank_fallback'
        used_fallback = summary_source == 'textrank_fallback'
    else:
        summary_text = ''
        summary_source = 'bart_hf'
        used_fallback = False

    return {
        'summary_text': summary_text,
        'summary_source': summary_source,
        'ai_summary': ai_summary,
        'extractive_summary': extractive_summary,
        'key_sentences': key_sentences,
        'summary_model': SUMMARIZER_MODEL_ID,
        'used_fallback': used_fallback,
        'error': error if used_fallback else '',
        'chunk_count': parse_int(ai_result.get('chunk_count'), 0, 0),
        'merge_rounds': parse_int(ai_result.get('merge_rounds'), 0, 0),
        'target_max_words': safe_target_words,
        'textrank_sentence_count': sentence_count,
    }
