# loyalty-platform

Self-Service Multi-Tenant Loyalty Platform. Architecture source of truth:
[`docs/architecture/FINAL-ARCHITECTURE.md`](docs/architecture/FINAL-ARCHITECTURE.md). Persistent
Claude Code instructions: [`CLAUDE.md`](CLAUDE.md).

> **Status**: project bootstrap only — no domain/business logic yet. Phase 1 has not started.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the Firebase Web App config values
npm run dev
```

`.env.local` is gitignored — never commit it. See `.env.example` for the required variables and
where to find them (Firebase Console, dev project `loyalty-platform-dev-9a0c5`).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Run tests once (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run emulators` | Start Firebase Auth + Firestore emulators (no login/deploy required) |

## Firebase

Dev project: `loyalty-platform-dev-9a0c5` (`asia-southeast1`). No production project exists yet.
Firestore rules are default-deny at this stage — see `firestore.rules`.
