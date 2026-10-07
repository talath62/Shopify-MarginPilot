# PG-004 — Order Profit Aggregate Loader V1

| | |
|---|---|
| Date | 2026-10-07 |
| Code | `app/services/order-profit-aggregate-loader.server.ts` (server-only) |
| Fonction | `loadOrderProfitNormalizationSource(shopId, orderId): Promise<OrderProfitNormalizationSource>` |
| Tests | `app/services/__tests__/` : mapping pur et PostgreSQL réel |
| Références | PG-001 (modèle), PG-003 (contrat `OrderProfitNormalizationSource`) |

## 1. Responsabilité

Le loader charge **une** commande complète depuis PostgreSQL et la transforme en DTO PG-003 :

```
PostgreSQL / Prisma ──PG-004──▶ OrderProfitNormalizationSource ──PG-003──▶ OrderProfitInput ──PG-002──▶ résultat
```

C'est une couche d'infrastructure :
- elle utilise l'instance partagée `app/db.server.ts`, sans nouveau `PrismaClient` ;
- elle ne fait **aucun** calcul financier, aucun filtre métier et aucun appel Shopify ;
- `app/domain/` reste sans base de données.

## 2. Clé et isolation multi-tenant

- `shopId` et `orderId` sont les UUID internes de `Shop` et `Order`.
- Le filtre tenant fait partie de la requête racine :
  ```ts
  tx.order.findFirst({ where: { id: orderId, shopId }, select: orderAggregateSelect })
  ```
  SQL généré : `WHERE ("Order"."id" = $1 AND "Order"."shopId" = $2)`.
- Une commande d'un autre shop n'est jamais lue : on obtient `ORDER_NOT_FOUND`, sans seconde recherche.
- Les relations enfants sont tenant-safe par les FK composites de PG-001.
- Le loader vérifie en plus que les liens restent **dans la commande** : un `refundId` ou une ligne de remboursement pointant vers une autre commande du même shop déclenche `INCONSISTENT_PERSISTED_DATA`.

## 3. Relations chargées (`select` explicite, colonnes minimales)

```
Order { id, shopId, currencyCode, taxesIncluded, test, deletedAt }
├─ lines (id ASC) { id, quantity, isGiftCard, originalTotal, currencyCode }
│   ├─ discountAllocations (position ASC) { amount, currencyCode }
│   ├─ taxes (position ASC) { amount, currencyCode }
│   └─ costSnapshot { unitCost, currencyCode, source, historicalApproximation }
├─ shippingLines (position ASC) { isRemoved, discountedPrice, currencyCode }
│   └─ taxes (position ASC) { amount, currencyCode }
├─ transactions (id ASC) { id, refundId, kind, status, gateway, amount, currencyCode, test }
│   └─ fees (position ASC) { amount, currencyCode }
└─ refunds (id ASC) { id, totalRefunded, currencyCode }
    ├─ lines (position ASC) { orderLineId, quantity, subtotal, taxAmount, currencyCode, restockType }
    ├─ shippingLines (position ASC) { subtotalAmount, taxAmount, currencyCode }
    └─ adjustments (position ASC) { reason, amount, taxAmount, currencyCode }
```

Données jamais chargées :
- `Shop`, `Product`, `ProductVariant`, `InventoryItem` (pas de coût courant) ;
- `customerShopifyGid`, les totaux de commande, les dates, les GID ;
- les taux de taxe et le détail des frais (`type`, `flatFee`, `rate`) ;
- `Session`, et aucune PII.

L'ordre (`position`, sinon `id`) sert uniquement le déterminisme et le débogage. Il ne porte aucun sens métier.

### Requêtes

- Une seule requête Prisma racine.
- Prisma la découpe en **un SELECT par relation** (chargement par lots `IN`, pas de N+1) : au plus 1 + 12 SELECT, quel que soit le nombre de lignes. Mesuré : 5 lignes donnent toujours un seul SELECT sur `OrderLineTax`.
- Ces SELECT tournent dans une transaction `REPEATABLE READ` : un seul instantané PostgreSQL, donc pas de mélange de deux états de la commande.
- Pas de `SERIALIZABLE`, pas de verrou, pas de cache.

## 4. Mapping PG-001 → PG-003

| DTO PG-003 | Source PG-001 |
|---|---|
| `order.currencyCode / taxesIncluded / test` | `Order` |
| `orderLines[].id` | `OrderLine.id` (UUID interne) |
| `orderLines[].originalTotal` | `OrderLine.originalTotal` (shopMoney) |
| `orderLines[].discountAllocations / taxLines` | `OrderLineDiscountAllocation` / `OrderLineTax` : **toutes** les lignes, y compris à 0, jamais sommées |
| `orderLines[].costSnapshot` | `OrderLineCostSnapshot`, ou `null` si absent (jamais inventé) |
| `shippingLines[]` | **Toutes** les `ShippingLine`, y compris `isRemoved = true` (PG-003 décide) |
| `transactions[]` | **Toutes** les `OrderTransaction`, sans filtre de type, statut, test ou passerelle |
| `transactions[].refundId` | `OrderTransaction.refundId` = UUID interne du `Refund` |
| `transactions[].fees` | **Tous** les `TransactionFee`, `amount` seulement |
| `refunds[].id` | `Refund.id` (même espace d'identité que `refundId`) |
| `refunds[].lines[].orderLineId` | `RefundLine.orderLineId` = UUID interne de l'`OrderLine` |
| `refunds[].adjustments` | **Tous** les `RefundOrderAdjustment`, `REFUND_DISCREPANCY` et zéros compris |

**Agrégat complet** : chaque collection contient toutes les lignes persistées de la commande. Une collection vide ressort `[]` et signifie qu'aucune ligne n'existe en base. C'est la garantie exigée par PG-003 §2.

## 5. Decimal et null

- Les `NUMERIC` sont transmis tels quels, en instances `Prisma.Decimal`, sans aucune conversion en `string` ou `number`.
- Les quantités (`Int`) restent des `number`.
- Les `null` sont conservés : `refundId`, `gateway`, `costSnapshot`, `unitCost`, `currencyCode` du snapshot.

## 6. Erreurs (`OrderProfitAggregateLoadError { code, message, context }`)

| Code | Cas |
|---|---|
| `ORDER_NOT_FOUND` | Aucune commande `(shopId, orderId)`, y compris une commande d'un autre shop. |
| `ORDER_DELETED` | `Order.deletedAt` non nul (convention retenue : erreur explicite, pas `NOT_FOUND`). |
| `INCONSISTENT_PERSISTED_DATA` | `refundId` ou `RefundLine.orderLineId` rattaché à une autre commande du même shop. |

Les règles financières (devise, remises, retours, remboursements ambigus…) restent dans PG-003 : elles ne sont pas dupliquées ici.

## 7. Tests

- **Mapping pur** (`order-profit-aggregate-loader.mapping.test.ts`, sans base de données, 16 tests) :
  - toutes les collections sont conservées ;
  - `Decimal` (même instance) et `null` sont préservés ;
  - aucun champ catalogue, shop ou client ;
  - données incohérentes rejetées.
- **PostgreSQL réel** (`order-profit-aggregate-loader.db.test.ts`, 8 tests, sur le `DATABASE_URL` existant) :
  - agrégat complet (2 lignes, remises, taxes, 2 lignes de livraison dont une retirée, 4 transactions, 2 frais, 2 remboursements, lignes et livraison de remboursement, ajustement, snapshot) ;
  - collections vides, `ORDER_NOT_FOUND`, `ORDER_DELETED`, incohérence ;
  - isolation A/B ;
  - pipeline PG-004, puis PG-003, puis PG-002.
- **Isolation des données de test** : les fixtures sont créées dans des shops dédiés à UUID uniques. `after` supprime **uniquement** ces shops (cascade) et déconnecte Prisma. Aucun `TRUNCATE` ni reset.
- **Prérequis** : `npm test` exige que le PostgreSQL local (`docker-compose`) tourne, avec les migrations appliquées.

## 8. Hors scope

Import ou sync Shopify, webhooks, jobs, calculs financiers, coûts externes, `ProfitSnapshot`, cache, UI, LTV, simulateur.
