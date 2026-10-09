# PG-005 — Shopify Catalog Sync V1

| | |
|---|---|
| Date | 2026-10-08 |
| Code | `app/services/shopify-catalog-sync.server.ts` |
| Tests | `app/services/__tests__/shopify-catalog-sync.test.ts` (faux GraphQL + PostgreSQL réel) |

## Objectif

Synchroniser en **full sync** l'état **courant** du catalogue Shopify dans `Product`, `ProductVariant` et `InventoryItem` (PG-001). Les commandes et les snapshots COGS ne sont pas concernés.

## Fonction publique

```ts
syncShopifyCatalog({ shopId, admin }): Promise<CatalogSyncResult>
// CatalogSyncResult = { products, variants, inventoryItems, productsSoftDeleted, variantsSoftDeleted }
```

- `shopId` : UUID interne du `Shop`.
- `admin` : client Admin déjà authentifié, fourni par le caller. Seul `admin.graphql(query, { variables })` est utilisé (`AdminApiContext` est compatible).
- Le service ne fait ni OAuth, ni gestion de session, ni `fetch`.

Erreurs (`CatalogSyncError.code`) : `SHOP_NOT_FOUND`, `SHOPIFY_GRAPHQL_ERROR`, `INVALID_SHOPIFY_DATA`, `INVALID_MONEY`.

## Champs Shopify lus (Admin GraphQL 2026-10, scope `read_products`)

- `shop { currencyCode }` : devise du prix des variantes. Elle est lue chez Shopify à chaque page, jamais supposée.
- `Product` : `id`, `title`, `status`, `createdAt`, `updatedAt`.
- `ProductVariant` : `id`, `title`, `sku`, `price`.
- `inventoryItem` : `id`, `updatedAt`, `unitCost { amount currencyCode }`.

`ProductVariant.createdAt` et `updatedAt` ne sont pas lus : PG-001 n'a pas de colonne pour les stocker.

## Pagination

- Produits : `products(first: 100, after: $cursor)` jusqu'à `hasNextPage = false`. Coût validé sur la boutique de dev, avec `variants(first: 100)` imbriqué.
- Variantes : si `variants.pageInfo.hasNextPage`, `loadRemainingVariants` charge les pages suivantes de ce produit avec `product(id) { variants(first: 100, after) }`.
- Pas de Bulk Operations, pas de parallélisme.

## Upsert (clé `(shopId, shopifyGid)`, jamais le SKU ni le titre)

Pour chaque produit, on upserte le `Product`. Puis, pour chaque variante, on upserte l'`InventoryItem`, puis la `ProductVariant`, reliée au produit et à l'inventory item internes.

- Un produit ou une variante revu repasse à `deletedAt = null`.
- Les écritures ont lieu entre les appels Shopify : aucune transaction PostgreSQL ouverte pendant le réseau.
- Un produit est entièrement validé avant d'être écrit.

## Coût courant, null ≠ 0

- `InventoryItem.unitCost` est le coût **courant** : il est remplacé à chaque sync (40, puis 50).
- `unitCost: null` chez Shopify donne `unitCost = null` et `unitCostCurrencyCode = null`.
- `0.0` chez Shopify donne `Decimal(0)` avec la devise Shopify.

Argent : chaîne Shopify convertie en `Prisma.Decimal`, sans `number`. Une valeur négative, de plus de 14 chiffres entiers ou de plus de **6 décimales** est rejetée (`INVALID_MONEY`) : PostgreSQL l'arrondirait silencieusement sinon.

## Soft delete

- Les GID vus sont mémorisés pendant la lecture.
- **Seulement après** que toutes les pages ont été lues avec succès, les `Product` et `ProductVariant` actifs du shop absents de ces listes reçoivent `deletedAt = syncTime` (mise à jour par lots d'id).
- Aucune suppression physique.
- `InventoryItem` n'est jamais supprimé ni soft-deleted.
- Si Shopify échoue en cours de route, la phase de soft delete n'est **pas** exécutée. Les upserts déjà faits restent.

## Snapshots COGS : hors scope

Le service ne crée, ne modifie et ne supprime jamais `OrderLineCostSnapshot`. Testé : un snapshot à 40 reste à 40 quand le coût courant passe à 50.

## Tests

20 tests `node:test`, avec un faux `admin.graphql` déterministe et le PostgreSQL local :
- import et coût ;
- coût null, coût à 0, SKU null ou vide ;
- mise à jour sans doublon ;
- pagination des produits et des variantes ;
- soft delete et réapparition ;
- erreur GraphQL sans soft delete ;
- isolation entre deux shops ;
- montant à plus de 6 décimales ;
- snapshot COGS inchangé ;
- shop inconnu ;
- donnée Shopify invalide.

Aucun appel à la vraie boutique et aucun token dans les tests.

## Hors scope

Commandes, remboursements, transactions, snapshots COGS (PG-006), webhooks (`products/*`, `inventory_items/update`), jobs, queue, cron, réconciliation, UI, onboarding.
