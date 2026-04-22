import requests

from .config import RESEND_API_KEY, RESEND_FROM_EMAIL
from .utils import normalize_email


def send_resend_email(to_email, subject, html_body, text_body, *, reply_to=None):
    recipient = normalize_email(to_email)
    safe_subject = str(subject or '').strip()
    safe_html = str(html_body or '').strip()
    safe_text = str(text_body or '').strip()
    safe_reply_to = normalize_email(reply_to)

    if not recipient:
        return False, 'Missing recipient email'
    if not RESEND_API_KEY:
        return False, 'RESEND_API_KEY is not configured'
    if not safe_subject:
        return False, 'Missing email subject'
    if not safe_html and not safe_text:
        return False, 'Missing email body'

    payload = {
        'from': RESEND_FROM_EMAIL,
        'to': [recipient],
        'subject': safe_subject,
        'html': safe_html,
        'text': safe_text or safe_subject,
    }
    if safe_reply_to:
        payload['reply_to'] = safe_reply_to

    try:
        response = requests.post(
            'https://api.resend.com/emails',
            headers={
                'Authorization': f'Bearer {RESEND_API_KEY}',
                'Content-Type': 'application/json',
            },
            json=payload,
            timeout=15,
        )
        if response.status_code >= 400:
            return False, f'Resend failed ({response.status_code}): {response.text[:220]}'
        return True, ''
    except Exception as e:
        return False, f'Resend request error: {e}'
