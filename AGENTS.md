# AGENTS.md

## Project

PM2 Hawkeye is a Node.js 22+ dashboard for local PM2 processes. The backend uses Express, WebSockets, PM2's programmatic API, and SQLite. The frontend uses React 19, JSX, Less, and esbuild. The codebase is ESM JavaScript only.

The application must run on the same host as the PM2 daemon. WebSockets are the single real-time transport for process updates, logs, metrics, and action results.

## Repository layout

- `lib/transport/`: HTTP server, routes, and WebSocket transport
- `lib/service/`: PM2 integration, monitoring, alerting, deployments, and other domain services
- `lib/storage/`: SQLite schema, migrations, and persistence modules
- `lib/security/`: authentication, sessions, CSRF, and security middleware
- `src/`: React application code
- `src/components/`: UI components
- `src/styles/`: Less styles and shared design tokens
- `test/`: Mocha tests
- `public/`: generated and static browser assets

## Commands

Use Yarn for dependency installation.

```bash
yarn install
npm run dev
npm run build
npm test
npm run lint
npm run format:check
```

Development uses two processes:

1. Run `node --inspect lib/transport/server.js` for the backend on port 3030.
2. Run `npm run dev` for the frontend server on port 3042.

Open `http://localhost:3042` during development.

## Code conventions

- Write JavaScript and JSX, not TypeScript.
- Use ESM imports and exports.
- Use single quotes.
- Use React functional components and hooks, not class components.
- Write comments, documentation, and JSDoc in English.
- Document code changes with appropriate JSDoc.
- Prefer a maintained library when a manual implementation would be unnecessarily complex.
- Check whether README or other documentation needs updating whenever behavior changes.
- Never use an em dash. Use commas, parentheses, or separate sentences.
- Use Prettier and ESLint. Run lint, formatting checks, and relevant tests before handing off changes.

## Frontend conventions

- Keep every per-process feature in exactly one of the Logs, Metrics, or Manage tabs.
- Use `ConfirmButton` for confirmations. Do not use `window.confirm` or custom confirmation markup.
- Import icons through `src/components/Icon.jsx`. Do not add hand-written SVG paths.
- Use the design tokens in `src/styles/variables.less`, including the spacing scale, radii, colors, and typography.
- Use the mono font and tabular numerals for metrics and other changing numeric values.
- Keep status colors semantic rather than decorative.

## Testing

- Add or update Mocha tests for backend behavior changes.
- Run the most focused relevant test first, then run `npm test` for changes with broader impact.
- Run `npm run lint` and `npm run format:check` before completion.
- Do not assume a running PM2 daemon is available in tests. Follow the existing stubbing and setup patterns in `test/`.

## Git and workspace safety

- Never commit unless the user specifically says `commit`.
- Never create or use Git worktrees. Work directly in the main checkout.
- Preserve unrelated user changes and untracked files.
- Do not rewrite, discard, or clean changes outside the requested scope.
- Do not edit generated files in `public/` by hand. Update their sources and run the build when generated assets must change.
