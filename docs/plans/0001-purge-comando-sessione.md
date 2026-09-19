# Piano 0001 — Comando `/purge`: compattare fisicamente il file di sessione

> Stato: **IMPLEMENTATO** (v0.1.0, non ancora pubblicato).
> Ambito: un solo comando, `/purge`, che riscrive il file JSONL della sessione
> corrente eliminando tutto ciò che precede l'ultima compaction.
> Riferimenti: `pi` 0.85.1 (`packages/coding-agent/src/core/session-manager.ts`,
> `docs/session-format.md`, `docs/compaction.md`), `pi-webview` per tooling di
> release/publish.

## Problema

Pi mantiene i file di sessione in `~/.pi/agent/sessions/--<cwd>--/*.jsonl`. Il
file è **append-only**: la compaction non cancella nulla, accoda una entry
`compaction` con un riassunto e lascia su disco tutta la storia precedente.
Con sessioni lunghe il file cresce a decine o centinaia di MB, anche se al
modello viene inviato solo `riassunto + coda mantenuta`.

Non esiste (né nel core né nella gallery di `pi.dev`) un modo per riscrivere il
file tenendo **solo** il checkpoint dell'ultima compaction. Questo piano
implementa quell'operazione come comando di una piccola estensione pi.

## Comportamento richiesto

1. `/purge` su una sessione **mai compattata** non produce effetti: avvisa che
   il comando è utilizzabile solo su sessioni che hanno subito almeno una
   compaction.
2. Se esiste almeno una compaction, chiede conferma spiegando che il file verrà
   **modificato e ristrutturato fisicamente**, eliminando i messaggi precedenti
   l'ultima compaction e mantenendo invariato l'header originale.
3. La conferma avverte che è preferibile **chiudere le altre sessioni pi** che
   hanno quel file aperto.
4. Alla conferma il file viene riscritto con **backup** accanto al file
   originale, rimosso solo dopo il buon fine della transazione.
5. Al termine viene indicata la riduzione del file (**byte risparmiati e
   percentuale**).
6. Viene notificato di **riavviare pi** se la sessione era rimasta aperta.

## Semantica del purge

Il file purgato è composto, nell'ordine di file:

```
header originale (riga verbatim)
spine: entry di stato portate avanti  (thinking_level_change, model_change,
       session_info, ultima `custom` per customType)
       + range mantenuto dalla compaction (`firstKeptEntryId`)
       + entry `compaction` (verbatim)
resto: tutte le entry accodate dopo la compaction (rami compresi)
```

Dettagli e motivazioni:

- **Header invariato**: la prima riga `{"type":"session",...}` viene riscritta
  byte per byte, quindi id, cwd, timestamp e `parentSession` restano quelli
  originali.
- **`compaction` verbatim**: `summary`, `details`, `usage`, `fromHook` e i campi
  delle versioni più nuove (`systemMessage`, `retainedTail`) non vengono toccati.
- **Range mantenuto** (`firstKeptEntryId`): pi ricostruisce la coda mantenuta
  pescando le entry **precedenti** alla compaction a partire da
  `firstKeptEntryId` (comportamento di pi 0.85.1, `buildContextEntries`). Le
  versioni più nuove possono incorporare la coda in `retainedTail` e ignorare
  l'id; mantenere comunque il range quando l'id è risolvibile sul ramo attivo
  resta corretto in entrambe le interpretazioni (al più conserva qualche KB in
  più) e garantisce che il contesto ricostruito non si restringa. Il range viene
  omesso solo quando `firstKeptEntryId` non esiste più, con un warning esplicito.
- **Entry di stato**: `buildSessionContext` ricava modello e thinking level dal
  percorso completo (`getSessionContextSettings`). Senza portare avanti le
  ultime `model_change` / `thinking_level_change`, dopo il purge la sessione
  ricadrebbe sui default (`thinkingLevel: "off"`). Stessa cosa per il nome
  (`session_info`) e per lo stato delle estensioni (ultima `custom` per
  `customType`), che altrimenti andrebbe perso.
- **Tutto ciò che segue la compaction resta**, anche se appartiene a rami
  abbandonati: il criterio è "elimina solo ciò che precede l'ultima compaction",
  quindi i rami creati dopo vengono preservati (le `/tree` successive li
  ritrovano).
- **Rincatenamento**: la parentela è ricostruita solo dove serve. Lo _spine_
  (stato → range mantenuto → compaction) viene concatenato in sequenza a partire
  da `parentId: null`; le altre entry conservano il `parentId` originale e lo
  azzerano solo se il padre è stato eliminato (diventano radici, caso già
  supportato da pi). Le entry non toccate sono riscritte **verbatim**, per non
  introdurre differenze di serializzazione.
- **Label**: le entry `label` che puntano a un target eliminato vengono rimosse.
  Per i `branch_summary` il `fromId` può restare pendente: viene usato solo per
  il rendering del messaggio di riepilogo del ramo e non per ricostruire il
  contesto.

### Rifiuti espliciti

| Condizione                               | Motivo                    | Messaggio                               |
| ---------------------------------------- | ------------------------- | --------------------------------------- |
| file non di sessione                     | `not-a-session`           | il file non è una sessione pi           |
| righe non parsabili / header duplicato   | `unsupported-format`      | purge annullato per non perdere dati    |
| `getLeafId()` nullo                      | `no-active-path`          | nessuna posizione attiva                |
| nessuna compaction nel file              | `no-compaction`           | solo sessioni con almeno una compaction |
| compaction esistente ma su un altro ramo | `no-compaction-on-branch` | il ramo corrente non è compattato       |
| nulla da rimuovere                       | `nothing-to-remove`       | il file parte già dalla compaction      |

## Transazione

1. snapshot del file (`readFileSync` + `statSync`: testo, byte, `mtimeMs`, mode);
2. verifica che l'agente sia fermo (`ctx.isIdle()`), altrimenti il comando
   rifiuta: una append concorrente invaliderebbe la riscrittura;
3. pianificazione pura (`planPurge`) e conferma utente;
4. **backup** `<file>.purge-backup` con `copyFileSync`;
5. controllo anti-concorrenza (dimensione + `mtimeMs` invariati);
6. scrittura **atomica**: file temporaneo nella stessa directory, `fsync`,
   `rename` sopra l'originale (pi legge/appende per path con `appendFileSync`,
   quindi non ci sono file descriptor che puntano all'inode vecchio);
7. **verifica**: header identico, ogni riga JSON valida, nessuna entry persa,
   nessun `parentId` pendente, `compaction` e `firstKeptEntryId` presenti;
8. successo → rimozione del backup; errore → **ripristino** dal backup e
   notifica dell'errore;
9. notifica finale con byte e percentuale risparmiati + invito a riavviare pi.

## Perché l'avviso di riavvio è reale

`SessionManager` tiene in memoria `fileEntries`. Le append usano
`appendFileSync(path)` (nessun fd persistente), quindi la riscrittura non
"stacca" la sessione; ma `_rewriteFile()` rigenera il file **da memoria** (al
load con migrazione di versione e in `createBranchedSession`). Una `/fork` o
`/clone` fatta dopo il purge riporterebbe quindi in vita la storia eliminata nel
nuovo file. Da qui l'avviso di chiudere/riavviare pi e di riaprire la sessione,
che la ricarica dal file purgato.

## UX

- `/purge` con argomenti → avvisa `Usage: /purge` e non fa nulla.
- Conferma (`ctx.ui.confirm`) con: nome file, entry rimosse su totale, dimensione
  prima → dopo e percentuale stimata, elenco di cosa viene eliminato, nota su
  backup e ripristino, avviso di chiudere le altre sessioni pi.
- Esito: `notify` info con riepilogo, poi `notify` warning con l'invito a
  riavviare pi.

## Test

`pnpm test` (`node --test`, TypeScript nativo, nessun transpiler):

- parsing (header, righe vuote, righe corrotte, header duplicato);
- `no-compaction`, `no-compaction-on-branch`, `nothing-to-remove`,
  `no-active-path`, `unsupported-format`;
- formato nuovo (`retainedTail`) e formato vecchio (`firstKeptEntryId`): il range
  mantenuto sopravvive;
- lo _spine_ di stato sopravvive e i rami creati dopo la compaction restano;
- nessun `parentId` pendente dopo il rincatenamento;
- **equivalenza di contesto**: un riferimento in test che rispecchia
  `buildSessionPath` + `buildContextEntries` di pi verifica che la sequenza di
  entry usata per ricostruire il contesto sia identica prima e dopo il purge;
- **verifica end-to-end con il vero pi**: script usa e getta che crea la sessione
  con `SessionManager` reale, esegue il purge e riapre il file con
  `SessionManager.open` + `buildSessionContext`: contesto, modello, thinking
  level e foglia identici, append successivi validi e secondo `/purge` rifiutato.
- helper di formato (`formatBytes`, `savingsPercent`);
- I/O: scrittura atomica, backup/ripristino, `verifyPurgedFile` che fallisce su
  header manomesso, riga non valida e `parentId` pendente.

## Packaging e pubblicazione

Struttura minimale, un solo pacchetto: nessun monorepo, nessun bundle (pi carica
le estensioni `.ts`), nessuna dipendenza runtime.

- `package.json` con `keywords: ["pi-package", ...]`, manifesto
  `pi.extensions: ["./index.ts"]`, `files` limitato a `index.ts`, `src/`,
  `README.md`, `CHANGELOG.md`, `LICENSE`;
- tooling di release ripreso da `pi-webview` e ridotto all'osso:
  `tools/npm-publish.mjs` (login browser npm, 2FA via browser, verifica
  dell'integrità sul registry), `tools/changelog.mjs`,
  `tools/check-package-manager.mjs`, `tools/release.mjs` (preparazione →
  commit → pubblicazione, con manifest degli artefatti e tag verificati);
- `pnpm release -- --version X.Y.Z` prepara (bump + note + typecheck + test +
  tarball hashato + manifest), `pnpm release -- --publish` pubblica dopo il
  commit, `--publish-only` è il retry idempotente;
- git/gh sempre via `direnv exec .` (l'account GitHub globale non è quello di
  pubblicazione).
- `.pi/` è interamente ignorata da git.

## Non obiettivi

- Non toccare la compaction di pi né il contesto in memoria della sessione
  corrente: il comando agisce solo sul file.
- Nessun purge di sessioni diverse da quella corrente (niente selettore).
- Nessuna compressione/re-serializzazione delle entry mantenute.
- Nessuna pubblicazione automatica: `release` prepari sempre, `--publish` è
  esplicito.
