# Architecture

## Application

React and TypeScript frontend with CSS Modules, React Router, TanStack Query and Floot's Radix-based UI kit. Floot maps page filenames to routes and endpoint filenames to GET/POST handlers. Endpoint schema files contain validation and typed client wrappers.

PostgreSQL access uses Kysely and postgres-js. The generated `helpers/schema.tsx` describes tables and types; it is not database content or a migration/backup. This export excludes all live records and executable import/fixture SQL.

## Workflows

- Host identity is explicitly designated. Guest invitation tokens are hashed; permanent invitations remain revocable. Guest sessions expire after 12 hours.
- Catalog exposes wine attributes, stock totals and physical fridge/shelf locations to authorized users.
- Cart state persists in browser storage and is cleared or separated across authorization boundaries. Adding to a cart does not reserve stock.
- Checkout revalidates availability, allocates pickup locations, locks rows and updates stock plus audit records in a database transaction. Idempotency keys support safe retry after uncertain responses.
- Host reversal restores original quantities once, retaining the checkout history.
- Uploads use presigned transport and server-side receipt validation before attachment to wines.
- Telegram delivery uses durable outbox records and explicit retry state. Recorded backend checks do not prove a real message was delivered.

## External requirements

The existing Floot environment supplies database connectivity, secret values, storage and endpoint execution. Source contains environment variable references, not their values. Image URLs are runtime references; corresponding hosted assets are excluded. Standalone deployment requires replacing platform-specific services, configuring a schema separately and supplying an application build/runtime. No credentials should be committed.

## Export boundaries

Only current remote source and sanitized project notes are included. Historical agent transcripts, raw verification output, setup artifacts, temporary identities, workbook data and photos remain outside this repository. No automatic GitHub-to-Floot integration has been configured.
