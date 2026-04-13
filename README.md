# StudyHub

StudyHub is a full-stack coursework project for managing study documents in one place. It combines account-based access control, document upload/editing, workspace collaboration, share links, OCR-assisted extraction, AI summaries, and indexed search behind a React frontend and Flask backend.

## Project Overview

- Students can upload PDF, DOCX, TXT, and image files, organise them into workspaces, and keep lightweight notes alongside the source files.
- Workspace owners can invite collaborators, control editing/AI permissions, and manage document share links.
- The app supports OCR extraction for images and scanned PDFs, then lets users save OCR output back into the document system as notes.
- Logged-in users can submit private feedback, track their own feedback history, and receive email updates when admins respond or resolve items.
- `/api/documents` provides filtered, paginated document browsing with facets and improved ranked search while keeping the existing frontend contract unchanged.

## Coursework Requirements Coverage

| Requirement Area | StudyHub Implementation |
| --- | --- |
| User accounts and authentication | Email/password registration with email verification, Google login, session verification, logout, Bearer token auth for protected API routes |
| Persistent data management | Users, documents, workspaces, invitations, share links, and summary cache stored in SQLite or PostgreSQL |
| CRUD and file handling | Upload, list, read, edit, trash/restore, permanent delete, file preview, and download |
| Search and filtering | Keyword search, category/tag/file-type/date/workspace filters, facets, pagination, stable sorting |
| Collaboration features | Workspace membership, invitation links, access review, share-link generation and revocation |
| AI / intelligent features | OCR extraction, PDF OCR fallback, summarisation, keyword extraction, saved OCR note creation |
| Feedback/support workflow | Private in-app feedback widget, user feedback history, admin inbox, and Resend email notifications |
| Frontend SPA | React + Vite interface with document detail views, workspace settings, invite flow, and shared-document routes |
| Deployment readiness | Docker multi-stage build, Flask serving built frontend assets, environment-variable driven configuration |

## Feature List

- Email/password authentication with required email verification, plus optional Google sign-in.
- Document upload for `pdf`, `docx`, `txt`, `png`, `jpg`, `jpeg`, `gif`, and `webp`.
- Workspace-based organisation with configurable permissions and defaults.
- Soft delete / trash retention with restore and permanent delete.
- Public share links for document access without exposing the rest of the account.
- Invitation-based workspace join flow with review and resend support.
- Private feedback center for logged-in users, with admin-only triage and user-visible public updates.
- OCR for images and scanned PDFs, plus AI summaries and keyword extraction.
- Search result facets for tags, categories, and file types.
- SQLite and PostgreSQL support from the same codebase.

## Tech Stack

- Frontend: React 18, React Router, Vite, TipTap, pdf.js, pdf-lib
- Backend: Flask, Flask-CORS, gunicorn
- Database: SQLite for local development, PostgreSQL via `DATABASE_URL` in deployment
- Storage: local `uploads/` by default, optional S3 object storage
- AI / OCR integrations: Hugging Face inference APIs, optional external OCR service, optional `ocrmypdf`
- Build / deploy: npm, Python venv, Docker multi-stage image

## Repository Structure

- `src/`: React frontend source
- `backend/`: Flask routes, services, database setup, search/auth logic
- `dist/`: built frontend assets served by Flask at runtime
- `public/`: static frontend assets used during Vite build
- `scripts/`: maintenance helpers such as search-index rebuild
- `uploads/`: local file storage when S3 is not configured

## Setup

### 1. Clone and install dependencies

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
npm ci
```

### 2. Configure environment

```bash
cp .env.example .env
```

Set the variables you actually need for your environment. Local development can run with SQLite and local uploads; production should set a real `AUTH_TOKEN_SECRET` and, if needed, `DATABASE_URL`.

### 3. Start locally

Backend:

```bash
source venv/bin/activate
python app.py
```

Frontend dev server:

```bash
npm run dev
```

The Vite dev server runs on `http://127.0.0.1:5173` and proxies `/api` and `/uploads` to the Flask backend on `http://127.0.0.1:5001`.

## Environment Variables

See [.env.example](.env.example) for the documented template. The main variables are:

- `APP_ENV` / `FLASK_ENV`: production detection for auth-secret guard
- `AUTH_TOKEN_SECRET`: required strong token secret in production
- `AUTH_TOKEN_TTL_SECONDS`: token lifetime
- `DATABASE_URL`: enables PostgreSQL; if unset, the app uses local SQLite `database.db`
- `APP_BASE_URL`: public app origin used in invite/share link generation and email-verification links
- `EMAIL_VERIFICATION_TTL_HOURS`: verification-link lifetime for newly registered accounts
- `S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`: optional object storage
- `HF_API_TOKEN`, `HF_MODEL_BASE_URL`, `HF_OCR_MODEL`, `HF_SUMMARIZER_MODEL`: optional Hugging Face OCR/summarisation
- `EXTERNAL_OCR_SERVICE_URL`, `EXTERNAL_OCR_TIMEOUT_SECONDS`: optional external OCR service
- `OCRMYPDF_BINARY`, `OCRMYPDF_LANGUAGE`, `ENABLE_PDF_OCR_FALLBACK`, `OCRMYPDF_TIMEOUT_SECONDS`: optional PDF OCR fallback
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`: email delivery for workspace invitations and account verification
- `SUPPORT_EMAIL`: support inbox shown in the feedback modal and used for new-feedback admin notifications
- `FEEDBACK_ADMIN_USERNAMES`: comma-separated usernames allowed to access `/#/admin/feedback` and admin feedback APIs
- `TRASH_RETENTION_DAYS`: trash expiry window

## Feedback Center Notes

- The floating `Feedback` button is shown on authenticated StudyHub pages.
- Normal users can submit feedback and read only their own history via `/api/feedback`, `/api/feedback/mine`, and `/api/feedback/:id`.
- Admin access is controlled only by backend env var `FEEDBACK_ADMIN_USERNAMES`; non-admin users receive `403` from `/api/admin/feedback*`.
- Public admin replies and status changes are visible in the user's timeline and trigger Resend email notifications to the submitting user's email snapshot.
- Internal notes are admin-only, never returned by normal user APIs, and do not trigger user emails.
- Email update links use HashRouter-compatible URLs, for example `APP_BASE_URL/#/?feedback=<id>` for users and `APP_BASE_URL/#/admin/feedback?feedback=<id>` for admins.
- Feedback tables are created idempotently during `backend.db.init_db()` for both SQLite and PostgreSQL.

## Local Development Notes

- The backend serves the built frontend from `dist/` when you are not using the Vite dev server.
- After frontend changes, rebuild the bundle if you want Flask-only local runs to reflect the latest UI:

```bash
npm run build
```

- Local uploads are written to `uploads/` unless S3 is configured.
- PDF uploads are saved and listed immediately, then text extraction is completed asynchronously so large PDFs do not block the upload HTTP request. The optional `ocrmypdf` fallback is still available for explicit PDF rebuild/summary paths, but it is skipped during upload background processing to avoid Render/Gunicorn request timeouts.
- Local SQLite data is stored in `database.db` and is ignored by Git.

## Build and Deploy Notes

- `backend/__init__.py` points Flask’s `static_folder` at `dist/`, so built frontend assets are part of the runtime contract.
- For local or coursework submission runs that use Flask directly, keep `dist/` present and up to date.
- The Docker image uses a multi-stage build:
  - stage 1 runs `npm ci` and `npm run build`
  - stage 2 installs Python/backend dependencies and copies the built `dist/`
- The container starts Gunicorn with a 120 second timeout as a safety margin; long PDF extraction is kept out of the request path rather than relying on this timeout.
- `.dockerignore` excludes local `dist/` because Docker rebuilds it internally; this reduces build context without changing runtime behavior.

## Search and Index Notes

- `/api/documents` keeps the same request parameters and response structure:
  - request: `q`, `start_date`, `end_date`, `tag`, `category`, `file_type`, `include_meta`, `include_facets`, `limit`, `offset`, `sort`
  - response: existing `items`, `total`, and `facets` structure remains unchanged
- Search strategy:
  - SQLite uses FTS5 when available
  - PostgreSQL uses native full-text search with a GIN expression index
  - fallback is weighted `LIKE` matching if FTS is unavailable
- Ranking is applied before the requested sort, and the requested sort remains the deterministic secondary order for stable pagination.
- Filters and facets are computed from the same filtered result set.
- Startup bootstrap in `backend.db.init_db()`:
  - ensures supporting B-tree indexes for filtered document listing
  - ensures SQLite FTS table/triggers when SQLite is active
  - ensures PostgreSQL full-text index when PostgreSQL is active
- Manual rebuild command:

```bash
python scripts/rebuild_document_search.py
```

- On SQLite, the rebuild script repopulates the `documents_search` FTS table from `documents`.
- On PostgreSQL, search stays in sync through the indexed `documents` rows directly, so the script is effectively a safe no-op after init.

## Auth and Security Notes

- Normal auth transport for protected API requests is `Authorization: Bearer <token>`.
- Public flows intentionally left available:
  - register/login
  - Google auth
  - email verification and verification resend
  - public share-link reads
  - invitation-token read page
  - OCR health check
- Password-based login is blocked until the registered email address has been verified.
- Existing users are backfilled as verified during schema migration so current accounts are not locked out on deploy.
- Protected routes derive the authenticated user from the token instead of trusting request usernames.
- If `username` is still supplied by older callers, it is treated as a compatibility claim and must match the authenticated user.
- Query-string auth is retained only for `/api/documents/:id/file?auth_token=...` as transitional compatibility for inline preview.
- That compatibility response is returned with `Cache-Control: no-store` headers.
- In production, startup fails closed if `APP_ENV=production` or `FLASK_ENV=production` and `AUTH_TOKEN_SECRET` is empty, default, or weak.

## Generated Assets and Repository Hygiene

- Kept:
  - `dist/`: required for Flask static serving outside the Vite dev server
  - `package-lock.json`: required for reproducible frontend installs/builds
  - `scripts/rebuild_document_search.py`: maintenance helper for SQLite search rebuilds
- Removed or confirmed removable clutter:
  - `clear_db.py`: unsafe local-only helper that directly deleted user rows from SQLite and was not referenced anywhere
  - `tmp.txt`: temporary upload/debug text file
  - `noteskit-react@1.0.0`: empty stray root-level placeholder
  - `vite`: empty stray root-level placeholder
- Kept locally but not part of the submission payload:
  - `database.db`, `studyhub.db`: local development databases
  - `uploads/`: local uploaded files
  - `venv/`, `node_modules/`, `__pycache__/`, `.DS_Store`: local environment/build clutter ignored by Git

## Manual Demo Script For Lecturer Marking

Use this sequence for a full walkthrough:

1. Open the app and register a new account, then verify the email link before signing in.
2. Show the Home page listing documents and workspaces.
3. Upload a sample PDF or TXT file.
4. Open the document detail page and show inline preview / content editing.
5. Run a keyword search in the document list and apply category/tag/file-type/date filters.
6. Show that facets update with the filtered result set.
7. Open workspace settings, show invite/share controls, and create an invite or share link.
8. Open a public share link in a logged-out browser window and show document access still works.
9. Run OCR or summary on a suitable document, then save OCR output as a note if available.
10. Log out and show protected routes no longer work without sign-in.

## What To Demo In 5 Minutes

If time is limited, demo these five things:

1. Login and open the document dashboard.
2. Upload one document and show preview/edit support.
3. Search for a keyword and apply one or two filters to show ranked results and facets.
4. Create a share link or invitation and open the public/shared flow.
5. Run OCR or summary on a document, then log out to show access control.

## Manual Verification Checklist

- `npm run build` completes successfully and refreshes `dist/`
- Flask starts and serves the built frontend from `dist/`
- Login/register still work
- Protected `/api/documents` listing still returns the existing shape
- Upload, preview, edit, delete/restore, share-link, and logout flows behave as before
- Search returns relevant results with stable pagination
- Search filters and facets still match the visible result set
- SQLite runs with automatic search bootstrap
- PostgreSQL remains compatible through `DATABASE_URL`
