# PG-009 — Infrastructure de jobs V1

| | |
|---|---|
| Date | 2026-10-19 |
| Code | `app/services/job-queue.server.ts` |
| Migration | `prisma/migrations/20261019120000_pg_009_job_queue` (modèle `Job`, enums `JobType` et `JobStatus`) |
| Tests | `app/services/__tests__/job-queue.test.ts` (PostgreSQL réel, executor simulé) |

## Objectif

File de jobs persistante dans PostgreSQL : fiabilité, reprise après crash, retries, isolation par shop.

PG-009 ne fournit que l'infrastructure et les contrats :
- aucun handler métier branché ;
- aucun worker démarré ni cron ;
- aucun appel Shopify.

Les webhooks arrivent en PG-010, l'exécution périodique en PG-011.

## Modèle `Job`

| Champ | Rôle |
|---|---|
| `id` (UUID), `shopId` (FK `Shop`, cascade) | Un job appartient à un seul shop, jamais réaffecté. |
| `type` | `ORDER_SYNC`, `ORDER_RECONCILIATION` ou `CATALOG_SYNC`. |
| `payload` (JSONB) | Validé par type, à l'enqueue **et** avant l'exécution. |
| `dedupeKey` | Optionnel. Au plus un job `PENDING` par `(shopId, type, dedupeKey)`. |
| `status` | `PENDING`, `RUNNING`, `SUCCEEDED` ou `FAILED`. |
| `attempts`, `maxAttempts` (5) | Tentatives consommées, et maximum. |
| `runAt` | Pas d'exécution avant cet instant. |
| `lockToken`, `lockedUntil` | Lease d'un job `RUNNING`. |
| `lastError` | Message court et expurgé. |
| `createdAt`, `updatedAt`, `finishedAt` | Horodatage. |

Contraintes CHECK écrites à la main :
- `attempts ≥ 0` et `maxAttempts ≥ 1` ;
- un lease existe **si et seulement si** le statut est `RUNNING`.

Index :
- `(status, runAt)` pour la réclamation ;
- `(shopId, type, dedupeKey, status)` pour la déduplication ;
- **index unique partiel** `Job_pending_dedupeKey_key` sur `(shopId, type, dedupeKey)` `WHERE status = 'PENDING' AND dedupeKey IS NOT NULL`. PostgreSQL garantit ainsi qu'il n'existe jamais deux jobs `PENDING` de même clé, que la tentative vienne d'un enqueue ou d'un retry. Cet index est écrit à la main, car Prisma ne modélise pas les index partiels ; `prisma migrate diff` ne détecte aucune dérive.

## Payloads (clés exactes, aucun champ libre, donc aucun token)

| Type | Payload |
|---|---|
| `ORDER_SYNC` | `{ orderGid: "gid://shopify/Order/<id>" }` |
| `ORDER_RECONCILIATION` | `{ updatedSince, updatedUntil }` : chaînes ISO 8601 UTC, avec `since < until` |
| `CATALOG_SYNC` | `{}` |

## API publique

```ts
enqueueJob({ shopId, type, payload, dedupeKey? }): Promise<{ job, deduplicated }>
processJobsOnce({ execute, limit, leaseMs? }): Promise<{ claimed, succeeded, retried, failed, leaseLost }>
findJobForShop(shopId, jobId)           // lecture limitée au shop
renewLease(id, lockToken, leaseMs?)     // aussi exposé à l'executor : job.renewLease()
class PermanentJobError                 // échec immédiat, sans retry
class JobQueueError                     // SHOP_NOT_FOUND, INVALID_JOB_TYPE, INVALID_JOB_PAYLOAD
```

- L'executor reçoit `{ id, shopId, type, payload, attempts, maxAttempts, lockToken, renewLease }`.
- `shopId` vient **toujours** du job persisté.

## Enqueue et déduplication

- Le shop doit exister, sinon `SHOP_NOT_FOUND`. Le payload est validé.
- Avec un `dedupeKey`, un verrou consultatif transactionnel (`pg_advisory_xact_lock` sur `job:<shopId>:<type>:<key>`) rend atomiques la recherche d'un `PENDING` identique et l'insertion. Testé avec 10 enqueues concurrents : un seul job créé.
- Un job `SUCCEEDED`, `FAILED` ou `RUNNING` ne bloque jamais une nouvelle demande : un nouveau `PENDING` est créé.
- **Retry d'un job avec clé** : le retry prend le même verrou consultatif que l'enqueue.
  - Si aucun `PENDING` de même clé n'existe, le job repart en `PENDING` normalement.
  - Si un `PENDING` de même clé a été créé entre-temps, ce job porte déjà le travail demandé. La tentative courante est clôturée `FAILED`, avec `lastError` = « … (retry superseded by pending job <id>) », et le job `PENDING` reste exécutable. Aucun travail n'est perdu, et l'index unique partiel empêche tout doublon.

## Exécution et verrouillage

- `processJobsOnce` traite au plus `limit` jobs, **séquentiellement**.
- Chaque réclamation est **une** instruction SQL atomique, qui utilise l'horloge PostgreSQL :
  ```sql
  UPDATE "Job" SET status='RUNNING', attempts=attempts+1, "lockToken"=gen_random_uuid(),
                   "lockedUntil"=now()+lease
  WHERE id = (SELECT id FROM "Job"
              WHERE (status='PENDING' AND "runAt"<=now()) OR (status='RUNNING' AND "lockedUntil"<now())
              ORDER BY "runAt", "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING *
  ```
- Deux workers ne réclament jamais le même job (testé).
- Aucune transaction n'est ouverte pendant l'executor. Les finalisations sont des `UPDATE` courts.

## Reprise après crash

- Un job `RUNNING` dont le lease a expiré est réclamé à nouveau au passage suivant (`attempts + 1`).
- Si le crash a eu lieu pendant la dernière tentative autorisée, le job passe `FAILED` sans être réexécuté.
- Toute finalisation exige le `lockToken` courant. Un worker dont le lease a été repris n'écrit rien : il est compté en `leaseLost`.
- Lease par défaut : 5 minutes. Pour un traitement long, le handler appelle lui-même `renewLease()` : PG-009 ne lance aucun timer.
- **Les handlers doivent être idempotents** : une exécution peut être rejouée après un crash ou après l'expiration d'un lease. PG-007 et PG-008 le sont déjà.

## Retries

- Erreur temporaire : retour en `PENDING`, `runAt = now() + backoff`, et `lastError` conservé.
- Backoff selon la tentative échouée : 1, 2, 4, 8 puis 16 minutes (plafond).
- Dernier échec (`attempts = maxAttempts`), `PermanentJobError` ou payload stocké invalide : `FAILED`, avec `finishedAt`.
- `lastError` est limité à 1000 caractères. Les motifs `shpat_…`, `shpss_…` et apparentés, `Bearer …` et `access_token=…` sont masqués.

## Tests

21 tests :
- création ;
- validation des payloads (refus d'un champ en plus, comme un token) ;
- shop inconnu ;
- déduplication concurrente ;
- nouvelle demande après `SUCCEEDED` ou pendant `RUNNING` ;
- deux workers (8 jobs, aucun exécuté deux fois) ;
- succès ;
- retry différé ;
- backoff `[1, 2, 4, 8]` puis `FAILED` ;
- erreur permanente ;
- lease expiré repris ;
- ancien `lockToken` incapable de finaliser ;
- renouvellement du lease ;
- isolation entre shops ;
- `runAt` futur ;
- `limit` ;
- expurgation de `lastError` ;
- déduplication au retry : job A `RUNNING` et job B `PENDING` de même clé, A échoue, B est le seul `PENDING` et s'exécute ; retry normal sans conflit ; retry et enqueue concurrents ; index unique partiel vérifié directement dans PostgreSQL.

Prérequis : `processJobsOnce` réclame **tout** job dû de la base. Les tests vérifient donc d'abord que la base ne contient aucun job étranger.

## Hors scope

Webhooks Shopify, handlers métier, cron ou scheduler, worker automatique, processus permanent, supervision, nouvelle dépendance, calcul financier.
