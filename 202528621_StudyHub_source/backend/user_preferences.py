from .utils import normalize_email, parse_bool, row_to_dict


DEFAULT_USER_PREFERENCES = {
    'email_notifications_enabled': True,
}


def normalize_user_preferences(source=None):
    data = row_to_dict(source) if source is not None else {}
    return {
        'email_notifications_enabled': parse_bool(
            data.get(
                'email_notifications_enabled',
                DEFAULT_USER_PREFERENCES['email_notifications_enabled'],
            ),
            DEFAULT_USER_PREFERENCES['email_notifications_enabled'],
        ),
    }


def user_allows_email_notifications(conn, *, username='', email=''):
    safe_username = str(username or '').strip()
    safe_email = normalize_email(email)
    if not safe_username and not safe_email:
        return True

    if safe_username and safe_email:
        cursor = conn.execute(
            '''
            SELECT email_notifications_enabled
            FROM users
            WHERE username = ? OR LOWER(email) = ?
            LIMIT 1
            ''',
            (safe_username, safe_email),
        )
    elif safe_username:
        cursor = conn.execute(
            '''
            SELECT email_notifications_enabled
            FROM users
            WHERE username = ?
            LIMIT 1
            ''',
            (safe_username,),
        )
    else:
        cursor = conn.execute(
            '''
            SELECT email_notifications_enabled
            FROM users
            WHERE LOWER(email) = ?
            LIMIT 1
            ''',
            (safe_email,),
        )

    row = row_to_dict(cursor.fetchone())
    if not row:
        return True
    return normalize_user_preferences(row)['email_notifications_enabled']
