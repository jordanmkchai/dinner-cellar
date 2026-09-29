# Dinner Cellar — CV project evidence

Prepared: 27 September 2026. Based on recorded implementation and verification through 26 September 2026.

## Project identity

- **Project:** Dinner Cellar — private wine inventory and dinner checkout web application.
- **Suggested CV category:** Independent Projects / Personal Projects. This was not recorded as paid employment or client work.
- **Suggested role label:** Product Owner & AI-Assisted App Builder.
- **Dates:** September 2026. Use “September 2026–Present” only if actively continuing development.
- **Platform:** Floot. Published address recorded: https://ourwines.floot.app. Access is private; do not put guest invitation tokens or host credentials in a CV or portfolio.
- **Contribution framing:** Defined the problem, requirements, workflow and interface changes; directed iterative AI-assisted development. Codex agents assisted with code, migration, testing and technical review. Do not imply independently hand-coding every component.

## Problem and delivered capability

An Excel inventory held wine attributes, quantities, images and physical storage locations. The project turned this into a shared application where dinner guests can browse wines, filter by category, select bottle quantities and check out a cart. The host can track requests, locate bottles by fridge and shelf, manage inventory and reverse mistaken checkouts.

The application provides a shared operational workflow beyond a static spreadsheet. Reduced coordination time and fewer picking errors are intended benefits; neither has yet been measured.

## Verified scope and metrics

| Evidence | Defensible wording | Limit |
|---|---|---|
| Initial import | Migrated **36 wine records, 58 bottles and 36 associated images across 2 fridges and 6 storage locations** | Initial dataset, not current inventory or user adoption |
| Import integrity | Preserved source workbook; validated image-to-record mapping and source hashes | No claim of ongoing Excel synchronization |
| Backend verification | Recorded **39 API assertions**, followed by **54 additional live assertions** covering uploads, host operations, expiry and retries | Separate test batches; do not describe these as 93 unique test cases |
| Notification verification | **25 live outbox, authorization, idempotency and content checks** passed | Does not establish delivery of a real Telegram message |
| Latest regression result | **8 automated test files passed; zero failed; TypeScript checks clean** | Two hook test files excluded by default; not a coverage percentage |
| Interface regression | **6 mocked UI scenarios** covered filtering, quantity limits, checkout/retry, access changes and modal behavior | Full authenticated mobile journey was not comprehensively verified |
| Publication | A published Floot website was confirmed | Latest interface and permanent-link changes awaited a publish action at last recorded check |

## Features relevant to a CV

- **Inventory discovery:** Search, advanced category filters, wine photos/details, bottle availability and fridge/shelf locations.
- **Inventory maintenance:** Add wines, restock, upload photos and enter categories using dropdown suggestions or manual values; host stock correction and movement controls.
- **Cart and checkout:** Quantity controls, persisted cart state, stock validation, atomic deductions and recorded pickup allocations.
- **Recovery and audit:** Safe replay of uncertain requests, duplicate-submit protection, stock movement records and one-time host reversal of mistaken checkouts.
- **Access control:** Designated host account, private reusable guest invitations, host-only management and revocable guest access. Permanent-link behavior implemented; guest sessions retain a 12-hour lifetime.
- **Notifications:** Telegram host-notification integration with wine photos, quantities and pickup locations; durable delivery records and retry handling. Host can manually forward information to guests. Real delivery remained unverified in the recorded evidence.
- **UX iteration:** Collapsible advanced filters, simplified “Confirm checkout,” modal wine details, responsive lists and a right-side hamburger menu.

## Technical substance and keywords

Use these for technical applications only when comfortable explaining them in an interview.

| Area | Technologies or concepts evidenced in the project |
|---|---|
| Frontend | React, TypeScript, CSS Modules, responsive layouts, React Router, TanStack Query, Radix-based UI components |
| Backend and data | Floot-hosted endpoints, PostgreSQL, Kysely, Zod validation, relational schema design |
| Data migration | Python, Excel/XLSX extraction, image relationship mapping, data normalization, SHA-256 integrity checks |
| Transaction reliability | Database transactions, row locking, optimistic version checks, idempotency keys, atomic stock updates, retry recovery |
| Access and privacy | Role-based authorization, hashed invitation tokens, secure session cookies, same-origin mutation checks, private-cache clearing |
| Images and integrations | Presigned uploads, upload receipt validation, Telegram Bot API, durable notification outbox |
| Quality | Automated regression tests, API testing, concurrency testing, TypeScript checking, release checkpoints |
| Delivery | Requirements definition, workflow design, product iteration, AI-assisted development, acceptance criteria, release preparation |

## Ready-to-adapt CV entry

**Dinner Cellar — Product Owner & AI-Assisted App Builder**  
Independent project | September 2026 | Floot

- Led AI-assisted development of a private wine inventory and dinner checkout application, translating an Excel-based workflow into searchable inventory, guest access and host management.
- Migrated 36 wine records, 58 bottles and 36 images across 6 storage locations, preserving wine metadata and fridge/shelf references.
- Defined multiuser checkout and recovery requirements, including stock validation, duplicate-request protection and host reversal; iterated filters, quantity controls and checkout design to simplify the guest workflow.

### Optional technical bullets

Replace a general bullet with one of these when relevant to the target role. Keep AI-assisted attribution in the entry.

- Delivered a React/TypeScript and PostgreSQL application using Floot and AI coding tools, with transactional stock updates, idempotent checkout requests and auditable inventory movements.
- Coordinated security and regression verification covering concurrent stock requests, authorization, upload validation and retry recovery; latest verification passed 8 test files with clean TypeScript checks.
- Implemented a Telegram host-notification workflow with photo-based pickup information and durable retry tracking; completed 25 backend checks ahead of real-message validation.

## Interview examples

**Turning requirements into a product:** Explain the original spreadsheet workflow, different host/guest needs, how requirements became inventory/cart/checkout flows, and why extra checkout fields were later removed.

**Preventing inconsistent stock:** Explain why adding a bottle to a cart does not reserve stock, why availability must be rechecked during checkout, and how transactions and duplicate-request protection address simultaneous requests and uncertain network responses.

**Importing usable data:** Explain how wine rows and embedded images were matched through workbook relationships, how bottle sizes and location labels were normalized, and how hashes verified the source workbook stayed unchanged.

**Choosing a practical notification channel:** Describe the change from WhatsApp delivery ideas to Telegram notifications for the host, with manual forwarding to guests. Distinguish implemented backend behavior from real-world delivery validation.

## Evidence gaps to fill before strengthening claims

- Number of actual hosts/guests, dinners supported and completed checkouts.
- Before/after time to find and retrieve wines, or manage a dinner request.
- Observed inventory discrepancies or picking errors before/after adoption.
- Confirmation that latest changes were published and tested on actual phones.
- Confirmation of successful real Telegram delivery and the host's forwarding workflow.
- Your exact hands-on contribution, technologies you can explain, and target job description.

Do not claim revenue, cost savings, percentage efficiency gains, production uptime, full test coverage, native iOS/Android releases or large-scale adoption without further evidence. Avoid “built entirely from scratch” or “independently engineered” if these obscure the AI-assisted development process.

