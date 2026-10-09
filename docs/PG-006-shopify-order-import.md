# PG-006 — Shopify Order Import V1

| | |
|---|---|
| Date | 2026-10-09 |
| Code | `app/services/shopify-order-import.server.ts` |
| Tests | `app/services/__tests__/shopify-order-import.test.ts` (faux GraphQL + PostgreSQL réel) |

## Objectif

Importer les commandes Shopify des **60 derniers jours** dans les tables PG-001, et créer le snapshot COGS immuable de chaque nouvelle ligne.

Il n'y a aucun calcul de profit et aucune règle métier : statuts, crédit en boutique, `restockType` et `REFUND_DISCREPANCY` sont stockés tels quels. Leur interprétation appartient à PG-003.

## Fonction publique

```ts
importShopifyOrders({ shopId, admin }): Promise<OrderImportResult>
// OrderImportResult = { orders, orderLines, snapshotsCreated }
```

- `admin` reprend le contrat minimal `admin.graphql` de PG-005.
- Erreurs (`OrderImportError.code`) : `SHOP_NOT_FOUND`, `SHOPIFY_GRAPHQL_ERROR`, `INVALID_SHOPIFY_DATA`, `INVALID_MONEY`.

## GraphQL (2026-10, scopes `read_orders`, `read_products`, `read_customers`)

1. `OrderImportPage` : `orders(first: 50, query: "created_at:>=<J-60>", sortKey: CREATED_AT)`, avec les GID seulement. Pas de `read_all_orders`, pas de Bulk Operations.
2. `OrderImportDetail(id)` : une requête par commande, qui reprend les champs du contrat PG-000 (annexe A) nécessaires à PG-001, dont `customer { id }`.
   - Validée en conditions réelles sur la boutique de dev : coût accepté, et `customer.id` lisible avec `read_customers`.
3. `OrderImportLineItems(id, cursor)` : pages suivantes de `lineItems` (100 par page).
4. `OrderImportRefundLines(id, cursor)` : pages suivantes de `refundLineItems` d'un `Refund`.

Pagination stricte, avec la même règle que PG-005 : `hasNextPage = true` sans `endCursor` valide donne `INVALID_SHOPIFY_DATA`.

- `shippingLines`, `refundShippingLines`, `orderAdjustments` et `Refund.transactions` doivent tenir dans une page de 50. Sinon `INVALID_SHOPIFY_DATA` : jamais de troncature silencieuse.
- `Order.transactions` (limite 100) et `Order.refunds` (limite 50) sont des **listes**, pas des connexions. Une liste qui atteint sa limite est rejetée, car elle peut être tronquée.

Seul `shopMoney` est lu. Une chaîne Shopify devient un `Prisma.Decimal`, sans `number`. Sont rejetés :
- plus de 6 décimales, plus de 14 chiffres entiers ou une valeur négative (`INVALID_MONEY`) ;
- une devise différente au sein d'une même ligne ;
- un montant de commande dans une autre devise que `Order.currencyCode`.

## Écriture : une transaction DB par commande

La commande est entièrement récupérée et validée **avant** d'ouvrir la transaction. Aucune transaction n'est ouverte pendant un appel Shopify. Si une commande échoue, rien d'elle n'est écrit ; les commandes précédentes restent.

| Ressource | Stratégie |
|---|---|
| `Order`, `OrderLine`, `OrderTransaction`, `Refund` | Upsert par `(shopId, shopifyGid)`. `OrderLine` n'est **jamais** supprimée ni recréée. |
| `RefundLine` | Upsert par GID s'il existe, sinon par `(refundId, position)`. Les lignes qui ne viennent plus de Shopify sont retirées. |
| Allocations, taxes de ligne, frais, lignes de livraison remboursées, ajustements | Remplacés en bloc pour leur parent. |
| `ShippingLine` et ses taxes | Remplacées en bloc pour la commande (aucun historique n'en dépend). |
| `refundId` | UUID interne du `Refund` qui liste la transaction dans `Refund.transactions`. |
| `parentTransactionId` | UUID interne de la transaction parente, qui doit appartenir à la même commande. |

Lien au catalogue : `productId` et `variantId` pointent vers les `Product` et `ProductVariant` **actifs** (`deletedAt = null`) de ce shop, trouvés par GID. S'ils sont absents ou supprimés, les FK restent `null`. Les GID sont toujours conservés et aucun produit n'est créé.

## Snapshot COGS (créé une seule fois)

- Il est créé **uniquement** si la ligne n'en a pas encore : jamais d'update, d'upsert ni de recréation.
- Variante liée dont l'`InventoryItem.unitCost` est connu :
  `SHOPIFY_UNIT_COST`, coût et devise courants, `inventoryItemShopifyGid` de l'item. Un coût de 0 reste `Decimal(0)`.
- Sinon : `MISSING`, `unitCost` et `currencyCode` à `null`, avec `inventoryItemShopifyGid` de Shopify s'il est connu.
- `historicalApproximation = true` dans tous les cas, puisqu'il s'agit de l'import initial de commandes passées. `capturedAt` vaut l'instant de création.
- Testé : un snapshot à 40 reste à 40 après un passage du catalogue à 50 et un réimport.

## Tests

18 tests `node:test`, avec un faux `admin.graphql` et le PostgreSQL local :
- commande complète (lignes, remises, taxes, livraison, transactions, frais, remboursement, ajustement, liens) ;
- catalogue lié ou absent ;
- snapshots `SHOPIFY_UNIT_COST`, `MISSING` et coût à 0 ;
- réimport idempotent avec snapshot inchangé ;
- isolation entre shops A et B ;
- plus de 6 décimales ;
- erreur Shopify, et rollback complet d'une commande invalide ;
- pagination des commandes et des lignes ;
- curseur manquant ;
- shop inconnu.

Aucun appel à la vraie boutique dans `npm test`.

## Hors scope

Profit, PG-002/003/004, `ProfitSnapshot`, webhooks (`orders/*`, `refunds/create`), jobs, queue, cron, réconciliation, suppression de commandes, coûts externes, UI.
