# PG-007 — Single Order Sync V1

| | |
|---|---|
| Date | 2026-10-19 |
| Code | `app/services/shopify-order-sync.server.ts` |
| Tests | `app/services/__tests__/shopify-order-sync.test.ts` (faux GraphQL + PostgreSQL réel) |

## Objectif

Refetch et synchroniser **une** commande Shopify complète à partir de son GID.

C'est la brique que réutiliseront plus tard `orders/create`, `orders/updated`, `refunds/create` et la réconciliation. PG-007 n'ajoute lui-même aucun webhook, job ni cron.

## Fonction publique

```ts
syncShopifyOrderByGid({ shopId, admin, orderGid }): Promise<OrderSyncResult>
// { status: "synced" | "skipped_stale", orderId, orderGid, orderLines, snapshotsCreated }
```

- `orderGid` doit respecter le format `gid://shopify/Order/<chiffres>`. Sinon : `INVALID_ORDER_GID`, avant tout appel.
- Erreurs (`OrderSyncError.code`) : `SHOP_NOT_FOUND`, `ORDER_NOT_FOUND`, `INVALID_ORDER_GID`, `SHOPIFY_GRAPHQL_ERROR`, `INVALID_SHOPIFY_DATA`, `INVALID_MONEY`.
- Les erreurs PG-006 sont converties en `OrderSyncError`, avec le même code.
- `order: null` chez Shopify donne `ORDER_NOT_FOUND`. La commande locale n'est **pas** supprimée : `orders/delete` est hors scope.
- `orderLines` vaut le nombre de lignes écrites, donc 0 si `skipped_stale`.

## Réutilisation de PG-006

`shopify-order-import.server.ts` exporte maintenant deux fonctions, sans dupliquer la logique :
- `fetchOrder(admin, gid)` : même requête 2026-10, même pagination stricte, même validation monétaire (ajustements négatifs compris). Elle renvoie `null` si la commande est introuvable.
- `persistOrder(shopId, order, { historicalApproximation, skipIfStale })` : même écriture transactionnelle.

`importShopifyOrders()` les appelle avec `historicalApproximation: true` et `skipIfStale: false`, ce qui donne exactement le comportement d'avant (ses 18 tests sont inchangés). PG-007 les appelle avec `false` et `true`.

## Protection contre les données anciennes

Concurrence : `persistOrder` prend d'abord, dans la transaction, un verrou PostgreSQL transactionnel :

```sql
pg_advisory_xact_lock(hashtextextended('order:<shopId>:<orderGid>', 0))
```

- Deux écritures de la même commande s'exécutent l'une après l'autre, y compris quand la commande n'existe pas encore.
- Le verrou est libéré au commit ou au rollback.
- Il s'applique aussi à l'import PG-006, sans changer son résultat.

Ensuite seulement, toujours avant toute écriture, on compare la date de mise à jour Shopify à celle stockée pour `(shopId, shopifyGid)` :
- si `Shopify.updatedAt < Order.shopifyUpdatedAt` : `skipped_stale`, aucune écriture (commande, enfants, snapshots) ;
- si elle est égale ou plus récente : synchronisation normale.

## Snapshot COGS

- Il n'est créé **que** pour une ligne qui n'en a pas : nouvelle commande, ou nouvelle ligne d'une commande existante.
- `SHOPIFY_UNIT_COST` avec le coût courant si la variante active liée a un coût connu, sinon `MISSING`.
- `historicalApproximation = false`, puisqu'il s'agit d'une synchronisation courante.
- Un snapshot existant n'est **jamais** modifié. Testé : il reste à 40 quand le catalogue passe à 50.

## Transaction

La commande est entièrement récupérée et validée hors transaction, puis écrite dans **une** transaction Prisma. Aucune transaction n'est ouverte pendant les appels Shopify. Une erreur pendant l'écriture annule tout.

Upserts par `(shopId, shopifyGid)` pour `Order`, `OrderLine` (jamais supprimée), `OrderTransaction` et `Refund`. Les enfants sans identité stable sont remplacés comme en PG-006. Aucune purge supplémentaire.

## Tests

12 tests :
- nouvelle commande ;
- mise à jour sans doublon, enfants financiers actualisés, nouvelle ligne et son snapshot, ancien snapshot inchangé ;
- snapshots `SHOPIFY_UNIT_COST` et `MISSING` avec `historicalApproximation = false` ;
- `skipped_stale` sans aucune écriture, et date égale autorisée ;
- GID invalide, `ORDER_NOT_FOUND`, shop inconnu, montant invalide ;
- isolation entre shops A et B ;
- rollback complet ;
- syncs concurrentes 09:00 / 10:00 : l'état final est toujours 10:00, sans doublon, avec des snapshots inchangés (ce test échoue si on retire le verrou).

## Hors scope

Import des 60 jours (PG-006), recherche `updated_at`, curseur de réconciliation, webhooks, `orders/delete`, jobs, queue, cron, profit, UI.
