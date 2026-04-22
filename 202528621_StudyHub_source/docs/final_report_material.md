# Final Report Material For StudyHub

This file is source material gathered from the local StudyHub repository and the local Codex conversation history. It should be rewritten in the student's own formal report style before submission. The Canvas brief says the final report should be written in third person/passive voice, not as a diary.

## Project Identity

Suggested project title:

StudyHub: A Smart Lecture Notes Organisation, Search, OCR, Summarisation and Sharing System

Short description:

StudyHub is a full-stack web application designed to help students store, organise, search, edit, summarise and share lecture notes. The system supports PDF, DOCX, TXT and image uploads, workspace-based collaboration, public and private sharing workflows, OCR-assisted text extraction, AI-assisted summarisation, indexed document search, and a private feedback workflow. The implementation uses a React and Vite single-page frontend with a Flask backend, SQLite or PostgreSQL persistence, optional S3 file storage, and optional external OCR and summarisation services.

## Abstract Notes

StudyHub was developed to address the difficulty students face when lecture notes are spread across different files, formats and sharing channels. The project produced a web-based study document management tool where users can upload notes, categorise and tag them, search across extracted content, edit supported document types, and generate summaries for revision. A React frontend was combined with a Flask backend and a relational database. The system stores metadata for users, documents, workspaces, invitations, share links, feedback, summary caches and friend/file-sharing notifications.

The project evolved from a basic notes organiser into a more complete coursework system. Authentication was hardened with email verification, bearer-token validation, HTTP-only cookie sessions and protected API routes. Document handling was extended to include upload validation, text extraction for TXT, DOCX and PDFs, PDF preview, PDF text finalisation, OCR-needed states for scanned documents, and optional OCR fallback. Search was improved with filtered document listing, facets, pagination and database-specific full-text search support. Summarisation was implemented through a hybrid approach using an external FLAN-T5 LoRA Modal service where configured, Hugging Face BART where available, and TextRank-style extractive fallback when external services fail.

The final artefact demonstrates document management, collaboration, sharing, AI-supported study workflows and software engineering practices such as modular backend services, environment-based configuration, security headers, deployment documentation and automated backend/e2e testing.

## Introduction Material

### Background

Students often receive course material in multiple formats, including PDFs, Word documents, text notes, screenshots and scanned handwritten notes. These materials are normally stored in folders or cloud drives, but retrieval during revision can become slow when files are not consistently named, tagged or searchable. The original project aim was to build a desktop or web-based tool that helps students upload, categorise, tag and search lecture notes, with an optional NLP component for summaries and key terms.

StudyHub addresses this by combining document storage, search, summarisation and sharing in one web application. The application is intended for students who need to revise from many course files and for classmates who need to exchange notes safely. The system also supports workspace collaboration, so notes can be organised by course, module or group.

### Aim

The aim of the project was to design, implement and evaluate a secure web-based study note organiser that enables students to upload, structure, search, summarise and share lecture notes efficiently.

### Objectives

1. Implement user authentication so documents are associated with individual accounts and protected from unauthorised access.
2. Provide document upload and storage for common study file types, including PDF, DOCX, TXT and images.
3. Extract and store searchable text from uploaded files where possible.
4. Allow students to categorise, tag, rename, edit, delete, restore and permanently remove documents.
5. Implement keyword search, filters, facets and stable pagination for document retrieval.
6. Add optional AI-supported workflows, including OCR for image/scanned notes and summarisation for revision.
7. Support collaboration through workspaces, invitations, share links, email sharing and friend file-sharing.
8. Improve security and deployment readiness through protected API routes, environment configuration, upload validation, security headers and automated tests.

### Possible Research Question

How can a web-based study document management system combine secure storage, full-text retrieval and AI-assisted summarisation/OCR to reduce the time students spend organising and revising lecture notes?

## Requirements Material

### Functional Requirements

The system should allow users to register, verify email addresses, log in, log out and restore sessions securely. Registered users should be able to upload PDF, DOCX, TXT and image files. The system should extract text from supported files, store metadata in a database, and make documents visible in a dashboard. Users should be able to search documents by keyword, filter by category, tag, file type and date, and sort or paginate results. Documents should support renaming, content editing where technically possible, tag/category updates, file preview, download, soft deletion, restoration and permanent deletion.

The system should support workspaces so students can separate personal notes from shared notes. Workspace owners should be able to invite members by email, manage members, configure permissions, control share-link behaviour and set defaults such as summary length. Public share links should allow controlled document access without exposing a user's whole account. Logged-in recipients should be able to save a shared document to their own workspace.

The system should support OCR and summarisation as optional intelligent features. OCR should extract text from image files or scanned notes where configured. Summarisation should generate short, medium or long summaries, extract keywords, cache results and fall back gracefully when external AI services are unavailable.

The system should include a feedback workflow so users can submit issues or usability suggestions privately. Administrators should be able to review feedback, add public replies, add internal notes and update status.

### Non-Functional Requirements

Security: protected API routes must require authentication; tokens should not be exposed in normal URLs; uploaded files should be validated by extension and content; public routes must be deliberately limited.

Reliability: document upload, search, sharing and summary generation should handle missing files, scanned PDFs, expired links, invalid tokens and external AI failures with clear error states.

Maintainability: the backend should be modular, with separate route and service modules for auth, documents, workspaces, sharing, feedback, friends, OCR and summarisation.

Performance: document listing should support pagination and indexed search. Summary generation should use caching and generation locks to avoid repeated expensive work.

Portability: the app should support SQLite for local development and PostgreSQL for deployment. Storage should support local uploads by default and S3 when configured.

Usability: the frontend should provide a clear dashboard, workspace navigation, file preview, mobile responsiveness, no horizontal overflow on major routes, and understandable action-required states such as "OCR Needed".

## Design Material

### Architecture

StudyHub uses a client-server architecture. The frontend is a React single-page application built with Vite and served by Flask from the built `dist/` directory. The backend is a Flask application that registers blueprints for authentication, workspaces, documents, share links, feedback, friends, OCR, summarisation and frontend static routes. The database layer supports SQLite locally and PostgreSQL through `DATABASE_URL` in deployment.

The main data entities are users, documents, workspaces, workspace members, workspace invitations, document share links, friend relationships/messages/notifications, feedback items/events, summary cache records and summary generation locks. File bytes are stored either in local `uploads/` or S3, while document metadata and extracted text are stored in the database.

### Main Components

Frontend:

1. `Home.jsx` provides the main dashboard, workspace navigation, document listing, upload flow, filters, summary center, share controls, account flow and settings.
2. `DocumentDetail.jsx` provides document preview, OCR, summarisation, share link management, export/download and public shared-document views.
3. `Auth.jsx` provides registration, login, Google login, email verification handling and session setup.
4. `InviteJoin.jsx` handles workspace invitation links.
5. `AdminFeedback.jsx` provides the feedback inbox for configured admins.

Backend:

1. `backend/security.py` enforces rate limiting and authentication middleware.
2. `backend/document_service.py` handles upload, listing, document CRUD, file retrieval, PDF finalisation and editable document saving.
3. `backend/document_search.py` handles filtering, facets and full-text search.
4. `backend/summary_service.py` handles summary caching, chunking, TextRank fallback, Hugging Face calls and external Modal service calls.
5. `backend/share_link_service.py` handles public links, email sharing, link revocation and saving shared documents into workspaces.
6. `backend/workspace_service.py` and `backend/workspace_domain.py` handle workspace settings, invitations, member access and permissions.
7. `backend/feedback_service.py` handles private feedback submission, admin triage and notification events.

### AI And OCR Design

The OCR design changed during development. An early version directly called Hugging Face OCR from `app.py`. When deployment problems appeared, especially differences between local OCR dependencies and cloud environments, the implementation was made more diagnosable. OCR now supports an optional external OCR service, a Hugging Face fallback, runtime health checks and redaction of private OCR endpoint details in errors. Scanned PDFs are not treated as silently processed; they are saved with a clear `needs_ocr` style state when selectable text is not available.

The summarisation design also evolved. The final version supports a separate Modal FastAPI service running a fine-tuned FLAN-T5-large LoRA adapter. The Flask backend calls this service first when `EXTERNAL_SUMMARY_SERVICE_URL` is configured. If it fails or is not configured, the backend falls back to the existing BART/Hugging Face and TextRank workflow. Summary cache keys include summary length, model identity, configuration version, keyword limit and input hash, preventing stale or cross-model summaries from being reused incorrectly.

## Implementation Material

The project was implemented iteratively. Early work focused on user interface structure, document upload, settings menus, document preview and tag editing. The frontend was later redesigned into a Notion-style workspace interface with a sidebar, file cards, recent items, settings modal, inline PDF preview, summary center and embedded document reader.

Document editing was extended with a rich text editor for editable formats. Local image insertion was added to the editor with type and size validation. DOCX/TXT content can be edited and saved back to the source file. PDF support was treated separately because PDF editing is more complex; the application supports preview, text extraction, conversion to editable draft, and replacement or copying of converted content.

The backend was progressively modularised. Large shared logic was separated into domain and service modules, including document domain helpers, workspace domain helpers, share link logic, document search and summary service logic. This made the implementation more maintainable and easier to test.

Authentication was strengthened late in the project. The previous middleware only enforced token validation in cases where a username could be extracted. This was refactored so protected `/api` routes require valid authentication even when no username is supplied. The authenticated username is now derived from the token, and any supplied username must match it. Normal app requests use bearer headers or HTTP-only cookies rather than query-string tokens. Production startup also fails if `AUTH_TOKEN_SECRET` is missing or weak.

Search was improved using a database-aware approach. SQLite uses FTS5 where available, PostgreSQL uses native full-text search with a GIN expression index, and a weighted `LIKE` fallback is available when full-text search is unavailable. Search ranking is applied before deterministic sorting, and facets are computed from the same filtered result set.

Sharing and collaboration were expanded from simple local invite targets to real workspace invitations, member management, public share links, email sharing, share-link revocation, friend requests, direct messages and file-share notifications. A later fix ensured that when a shared document is opened from a public link, a logged-in user can add it to their own workspace rather than only downloading it.

## Testing Material

Testing was performed through backend unit/smoke tests, Playwright end-to-end tests, build checks and manual workflows. The backend test suite covers authentication, HTTP-only cookies, workspace invitations, member removal, friend requests, file sharing, OCR fallback, OCR health redaction, security policy, CORS, security headers, rate limiting, email share links, email verification, ranked search, rich text sanitisation, PDF conversion, public share access, access-control enforcement, upload validation, summary caching, summary fallback, summary generation locking, PDF OCR-needed states and feedback workflows.

The Playwright tests cover guest login warnings, remember-me session restoration, invitation sign-in flow, workspace selection, workspace removal/deletion, invitation refresh, workspace access settings, member removal, messages and friend file-sharing, public share links, summary export/email actions, OCR-needed document display, share-link management, mobile responsiveness, no horizontal overflow on major routes, feedback submission/admin response and document search/open flows.

CI instability was investigated when GitHub Actions failed during frontend smoke tests. The failure was traced to Playwright tests running in parallel against a shared seeded Flask/SQLite backend. The configuration was updated to use one worker in CI, making the e2e suite deterministic.

Useful evidence to include in the report:

1. Screenshot of dashboard with uploaded notes and workspace sidebar.
2. Screenshot of file upload and document preview.
3. Screenshot of search/filter facets.
4. Screenshot of summary result modal and export buttons.
5. Screenshot of OCR-needed state for scanned PDF/image notes.
6. Screenshot of workspace invitation/member settings.
7. Screenshot of public share page with Add to Workspace.
8. Screenshot of feedback submission and admin reply.
9. Test output from `npm run test:backend`.
10. Test output from `npm run test:e2e`.

## Evaluation Material

Against the original requirements, StudyHub satisfies the core goal of storing and retrieving student notes. It supports account-based access, file upload, categorisation, tags, search, filtering and note retrieval. It goes beyond the original brief by adding workspaces, invitations, friend/file sharing, public share links, feedback triage, email verification, stronger access control and deployment-ready configuration.

The main technical strengths are the breadth of integrated features, the hybrid search design, the external-service fallback strategy for AI features, and the security improvements made to authentication and upload handling. The project also demonstrates maintainability because the backend was split into focused modules instead of leaving all functionality in one `app.py` file.

The main limitation is that OCR and summarisation quality depend on external providers and deployment configuration. If Hugging Face, Modal or the external OCR service is not configured, the system must fall back to extractive methods or clear error states. Another limitation is that PDF editing remains more constrained than DOCX/TXT editing because preserving arbitrary PDF layout is technically difficult. A third limitation is that some evaluation evidence still needs to be collected manually, such as OCR accuracy examples, summary-quality comparisons and user-testing/SUS-style feedback.

## Project Management Material

The development process was iterative and problem-driven. Early iterations built the document dashboard, account menu, upload flow, document preview and basic AI buttons. Later iterations focused on stability, deployment and maintainability. Several implementation choices changed after problems were observed: cloud OCR failures led to better runtime diagnostics and optional external OCR; insecure token transport led to stronger authentication middleware and HTTP-only cookies; GitHub CI failures led to Playwright worker configuration changes; summary quality and deployment requirements led to the external Modal FLAN-T5 service.

The Codex conversation history shows the project evolved through several major phases:

1. UI layout and menu fixes in November and December 2025.
2. Code cleanup, document preview, tag editing and rich text editing in February 2026.
3. OCR and summarisation integration in February and March 2026.
4. Full project feature expansion, workspace settings and backend modularisation in March 2026.
5. Invitation/email sharing and share-page layout fixes in March 2026.
6. Authentication hardening, dependency upgrades, CI fixes and final test stabilisation in April 2026.
7. External OCR/summary service architecture and shared-document save-to-workspace fixes in April 2026.

## Risks And Mitigations

External AI services may fail, time out or return poor-quality output. This was mitigated through health checks, fallback summarisation, OCR-needed states, provider diagnostics, redacted errors and cache separation by model/configuration.

Authentication and authorisation bugs could expose private notes. This was mitigated by enforcing authentication on protected API routes, deriving the user from the token, rejecting username/token mismatches, reducing query-token use, setting HTTP-only cookies and adding tests for wrong-user access.

Upload handling could allow invalid or unsafe files. This was mitigated by validating extensions, checking lightweight content signatures, rejecting mismatches, checking DOCX zip structure and limiting oversized images.

Search could become slow or inconsistent as documents grow. This was mitigated through pagination, facets, deterministic sorting, SQLite FTS5 support, PostgreSQL full-text search support and rebuild helpers.

Deployment environments may differ from local development. This was mitigated through Docker support, environment variable documentation, external service configuration, health endpoint metadata and CI/e2e testing.

## Legal, Social And Ethical Material

StudyHub stores user documents and could contain private course notes, emails or personal study material. Privacy and access control are therefore important. The system restricts document access to authenticated users, workspace members or holders of valid share links. Share links can expire or be revoked, and admin-only feedback notes are not exposed to normal users.

AI features raise quality and transparency concerns. OCR and summarisation may produce inaccurate or incomplete text, so results should be treated as study aids rather than authoritative replacements for source notes. The interface should make failure states visible, and the report should acknowledge that summaries should be checked against original material.

Email invitations and notifications require responsible handling of email addresses. The implementation uses configurable email delivery and user notification preferences. Environment variables are used for secrets, and diagnostics are designed not to expose private external service URLs or tokens.

## Conclusion Material

StudyHub delivered a functioning study notes platform that meets the original project aim and extends it with additional collaboration, sharing, security and feedback features. The project demonstrates practical software engineering across frontend design, backend API design, file handling, search indexing, authentication, testing, deployment and AI service integration.

Future work could include a formal user study, improved OCR accuracy evaluation, ROUGE or human evaluation of summaries, richer PDF annotation, better real-time collaboration, accessibility auditing, storage quota management, and a more detailed analytics dashboard for revision activity.

## Source Evidence In Repository

Useful files to inspect while writing:

1. `README.md` for feature coverage, tech stack, setup, search, auth, security and demo checklist.
2. `docs/summary_modal_deployment.md` for external FLAN-T5 Modal summary service design.
3. `backend/security.py` for authentication middleware and rate limiting.
4. `backend/document_service.py` for document upload/list/detail/edit/delete workflows.
5. `backend/document_search.py` for search implementation.
6. `backend/summary_service.py` for summary chunking, fallback and cache design.
7. `backend/share_link_service.py` for document sharing and save-to-workspace workflow.
8. `backend/workspace_service.py` and `backend/workspace_domain.py` for collaboration and invitations.
9. `backend/feedback_service.py` for feedback workflow.
10. `tests/backend/test_smoke.py` for backend verification evidence.
11. `tests/e2e/*.spec.js` for end-to-end and responsive UI verification.

