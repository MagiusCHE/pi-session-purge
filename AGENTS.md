# AGENTS.md

## Cos'è

`pi-session-purge` — estensione pi con **un solo comando**: `/purge` riscrive il
file JSONL della sessione corrente eliminando tutto ciò che è stato accodato
prima dell'ultima compaction, mantenendo header, checkpoint della compaction, la
coda mantenuta e tutto ciò che segue. Nessun effetto sulle sessioni mai
compattate.

## Stack

- TypeScript caricato direttamente da pi (nessun bundler, nessuna dipendenza
  runtime)
- Test: `node --test` con TypeScript nativo
- Package manager: **pnpm** — il blocco è nel campo `scripts.preinstall` di
  `package.json` (in linea, così non dipende da file non pubblicati: nel repo
  blocca npm, nel pacchetto installato è un no-op) più `devEngines`
- Tooling di release ripreso da `pi-webview` e ridotto al minimo

## Comandi

- `pnpm install` — solo pnpm
- `pnpm test` / `pnpm test:watch` — suite (`node --test`)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm format` / `pnpm format:check` — prettier
- `pi -e .` — prova l'estensione senza installarla
- `pnpm release -- --version X.Y.Z` — prepara: bump in `package.json`, sposta le
  note da `[Unreleased]` a `[X.Y.Z]`, typecheck + test, tarball hashato,
  manifest in `dist/`. **Non pubblica mai.**
- `pnpm release -- --publish [--tag <dist-tag>]` — dopo il commit: richiede
  worktree pulito, pubblica il tarball verificato, verifica l'integrità sul
  registry, crea/verifica tag `vX.Y.Z` e GitHub release
- `pnpm release -- --publish --publish-only` — retry idempotente della sola
  pubblicazione (richiede manifest, commit e hash identici alla build completa)
- Prima release pubblicata: `pnpm release -- --version 0.1.0` (le note sono già
  in `[Unreleased]`)

## Struttura

- `index.ts` — estensione pi: registra `/purge`, dialogo di conferma,
  transazione, notifiche
- `src/purge.ts` — pianificazione e serializzazione pure (nessun I/O)
- `src/session-file.ts` — snapshot, backup, scrittura atomica, verifica
- `tests/` — test unitari, incluso un riferimento a `buildContextEntries` di pi
  per dimostrare che il contesto ricostruito non cambia
- `docs/plans/0001-purge-comando-sessione.md` — decisioni di progetto
- `tools/` — `release.mjs`, `npm-publish.mjs`, `changelog.mjs`,
  `check-package-manager.mjs`
- `dist/` — artefatti di release (tarball npm + `release-manifest.json`),
  gitignorata; l'estensione pubblicata spedisce solo `index.ts`, `src/`,
  `README.md`, `CHANGELOG.md`, `LICENSE`

## Convenzioni

- **Commenti nel codice: solo in inglese.** Messaggi utente: solo in inglese
  (convenzione delle estensioni pi), nessun file di localizzazione.
- Nome progetto: `pi-session-purge`; package npm: `@magiusche/pi-session-purge`
- Nessun secret/dato personale committato; `.pi/` è interamente ignorata
- git/gh sempre via `direnv exec .` (l'account GitHub globale non è quello di
  pubblicazione)
- Commit message in inglese, nessuna firma AI, nessun push senza richiesta
  esplicita
- Il file di sessione è di pi: qualunque modifica deve restare compatibile con
  `session-manager.ts` (formato v3, header come prima riga, `parentId`
  risolvibile). Verificare con i test di equivalenza del contesto.

> **Aggiornamento automatico**: aggiorna questo file solo quando introduci
> modifiche importanti, strutturali e durevoli, come nuove librerie, cambi
> architetturali, nuove convenzioni, comandi/tooling, contratti API o procedure di
> deploy. Non aggiornarlo per fix ordinari, ritocchi UI, implementazioni banali,
> dettagli temporanei o cronologia delle attività. Mantieni il file snello e utile
> alle sessioni future.
