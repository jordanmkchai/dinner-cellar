# Dinner Cellar

Private wine inventory and dinner checkout application, built with Floot and AI-assisted development.

Guests browse and filter wines, choose bottle quantities and confirm checkout. Hosts manage stock, review fridge/shelf pickup information, reverse mistaken checkouts and configure Telegram notifications.

## Repository contents

- `pages/`, `components/`, `helpers/`, `endpoints/`, `base.css`: current Floot application source and tests.
- `helpers/schema.tsx`: generated TypeScript database structure only; no database rows.
- `static/__dev/dependencies.json`: Floot dependency reference.
- `docs/CV-project-notes.md`: project evidence, CV wording and verification limitations.
- `docs/ARCHITECTURE.md`: system overview and runtime requirements.
- `EXPORT-MANIFEST.json`: source version and file checksums.

No live database, database dump, inventory workbook, wine photos, user/contact records, guest invitations, credentials, setup codes or operational test fixtures are included. UI kit example/demo files are omitted; application dependencies remain included.

## Runtime

This is a source snapshot of a Floot-hosted app, not a standalone npm application. Floot supplies routing, bundling, endpoint execution, environment configuration and built-in services. The repository does not include a local development server, a runnable package.json or a database restore. Do not assume `npm start` works.

To continue development, use the existing Floot project or adapt its runtime explicitly. Configure secrets through the platform's secure resource settings. GitHub changes do not automatically synchronize to Floot or publish the website.

## Verification

Exported 29 September 2026 from Floot source version `1790392241234`. Last recorded application verification on 26 September: TypeScript checks clean; eight default spec files passed, zero failed; two hook specs excluded by default. This export did not rerun application tests. Latest production publication is not established by this source archive.

The initial spreadsheet migration contained 36 wine records, 58 bottles and 36 photos across six storage locations. These are historical project metrics, not included records or current inventory counts.

## Attribution

Product requirements and iteration were directed by the project owner. Implementation and technical verification used Codex agents. Floot provides the platform and seeded UI components. No additional open-source license is assigned by this export.
