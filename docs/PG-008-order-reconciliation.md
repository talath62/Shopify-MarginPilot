# PG-008 — Réconciliation incrémentale Shopify V1

| | |
|---|---|
| Date | 2026-10-19 |
| Code | `app/services/shopify-order-reconciliation.server.ts` |
| Tests | `app/services/__tests__/shopify-order-reconciliation.test.ts` (faux GraphQL + PostgreSQL réel) |

## Objectif

Retrouver les commandes Shopify modifiées dans une fenêtre `[updatedSince, updatedUntil)`, puis synchroniser chacune avec PG-007 (`syncShopifyOrderByGid`).

PG-008 n'écrit jamais directement dans `Order` ni dans ses enfants, et ne contient aucune logique d'import propre.

## Fonction publique

```ts
reconcileShopifyOrders({ shopId, admin, updatedSince, updatedUntil }): Promise<ReconciliationResult>
// { discovered, synced, skippedStale, snapshotsCreated }
```

- `discovered` : nombre de GID **uniques** trouvés dans la fenêtre, pas le nombre brut de nodes.
- La fenêtre est toujours fournie par l'appelant : pas de valeur par défaut, pas de « maintenant » implicite.
- `updatedSince` et `updatedUntil` doivent être des `Date` valides, avec `updatedSince < updatedUntil`. Sinon `INVALID_WINDOW`, avant tout appel.
- Erreurs propres (`ReconciliationError.code`) : `INVALID_WINDOW`, `SHOP_NOT_FOUND`, `SHOPIFY_GRAPHQL_ERROR`, `INVALID_SHOPIFY_DATA`.
- Les erreurs de PG-007 (`OrderSyncError`) sont propagées telles quelles.

## Requête Shopify (Admin GraphQL 2026-10, `read_orders`)

```graphql
orders(first: 100, after: $cursor, query: $query, sortKey: UPDATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes { id updatedAt }
}
```

`$query = updated_at:>='<since ISO 8601 UTC>' updated_at:<'<until ISO 8601 UTC>'`, par exemple `updated_at:>='2026-10-19T09:00:00.000Z' updated_at:<'2026-10-19T10:00:00.000Z'`.

Vérifié sur la boutique de dev : la syntaxe est acceptée. Mais les bornes de recherche Shopify **ne sont pas exactes à la seconde** : une commande à `16:07:25Z` ressort aussi pour `< 16:07:25Z`. Une commande légèrement hors fenêtre peut donc être retournée. C'est sans conséquence, car PG-007 est idempotent et protégé contre les versions anciennes. Aucun filtrage local n'est ajouté.

Pas de `read_all_orders` : la recherche reste limitée par l'accès historique de `read_orders` (60 jours).

## Pagination et déduplication

1. Toutes les pages sont lues **avant** la première synchronisation.
2. La validation est stricte, comme en PG-005/006 :
   - `nodes` doit être un tableau et chaque `id` un GID `Order` ;
   - `pageInfo` doit être un objet et `hasNextPage` un booléen ;
   - si `hasNextPage = true`, `endCursor` doit être une chaîne non vide.
   Une réponse invalide n'est jamais traitée comme une fin de pagination.
3. Les GID sont dédupliqués : un GID vu sur plusieurs pages n'est synchronisé qu'une fois.

## Synchronisation, erreurs et retry

- Les GID uniques sont traités **séquentiellement** avec `syncShopifyOrderByGid` (pas de `Promise.all`, de pool ni de queue). On compte `synced` et `skippedStale`, et on additionne `snapshotsCreated`.
- Une recherche Shopify en échec arrête l'exécution, sans résultat et sans aucune synchronisation.
- Une erreur PG-007, `ORDER_NOT_FOUND` comprise, est propagée et arrête l'exécution.
- Les commandes déjà synchronisées restent écrites : chacune a sa propre transaction PG-007, sans rollback global.
- Aucune commande locale n'est supprimée.
- Rejouer la même fenêtre est sûr : pas de doublon, les snapshots COGS ne sont jamais réécrits, et une version ancienne donne `skipped_stale`.

## Fiabilité des fenêtres (à respecter par le futur planificateur)

- PG-008 ne stocke **aucun** checkpoint ni statut « réconciliation terminée ».
- Une fenêtre en échec doit être **retraitée entièrement** par l'appelant.
- Les exécutions successives doivent se **chevaucher légèrement** (par exemple quelques minutes). Cela couvre les modifications concurrentes, le délai d'indexation de la recherche Shopify et l'imprécision des bornes ci-dessus.
- PG-007 rend ce chevauchement sans risque : idempotence et protection contre les versions anciennes.

## Tests

12 tests :
- fenêtre vide ;
- une commande, avec les bornes `updated_at` exactes, `sortKey: UPDATED_AT` et `first: 100` ;
- plusieurs commandes sur 3 pages avec GID répétés (6 nodes, 4 GID uniques, 4 synchronisations) ;
- fenêtres invalides rejetées avant tout appel ;
- rejeu idempotent, snapshot inchangé malgré un coût passé à 50 ;
- `skippedStale` ;
- erreur Shopify sur une page ;
- erreur PG-007 (`ORDER_NOT_FOUND`, `INVALID_MONEY`) qui arrête l'exécution ;
- isolation entre shops A et B ;
- pagination malformée ;
- shop inconnu.

## Hors scope

Webhooks, cron, queue, job, worker, table `SyncState`, checkpoint persistant, migration, `orders/delete`, profit, dashboard, LTV, Ads.
