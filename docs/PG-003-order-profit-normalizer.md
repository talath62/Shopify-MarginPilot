# PG-003 — Order Profit Normalizer V1

| | |
|---|---|
| Date | 2026-10-07 |
| Code | `app/domain/order-profit-normalizer/` |
| Fonction | `normalizeOrderProfitInput(source, externalCosts?) : OrderProfitInput` |
| Tests | `npm test` (86 tests du normalizer, plus les 48 de PG-002) |
| Références | PG-000 (D1–D8), PG-001 (modèle), PG-002 (contrat `OrderProfitInput`) |

## 1. Rôle

Le normalizer transforme l'agrégat persisté d'**une** commande (données PG-001) en `OrderProfitInput` PG-002, sans adaptation supplémentaire.

Il est **pur** :
- aucun Prisma, aucun Shopify, aucun réseau, aucune horloge ;
- aucune mutation de la source ;
- même source et mêmes `externalCosts` : même résultat.

Il ne calcule aucun profit. Il ne devine rien : dès qu'une règle manque, il lève `OrderProfitNormalizationError`.

Le `Decimal` utilisé est celui de PG-002 (`profit-engine/money.ts`, 50 chiffres significatifs). Les montants ne passent jamais par `number`, et aucun arrondi n'est fait.

## 2. Contrat source

`OrderProfitNormalizationSource` est un DTO explicite, pas un objet Prisma :

```
order          { currencyCode, taxesIncluded, test }
orderLines[]   { id, quantity, isGiftCard, originalTotal, currencyCode,
                 discountAllocations[{amount,currencyCode}], taxLines[{amount,currencyCode}],
                 costSnapshot { unitCost|null, currencyCode|null, source, historicalApproximation } | null }
shippingLines[]{ isRemoved, discountedPrice, currencyCode, taxLines[] }
transactions[] { id, refundId|null, kind, status, gateway|null, amount, currencyCode, test, fees[{amount,currencyCode}] }
refunds[]      { id, totalRefunded, currencyCode,
                 lines[{orderLineId, quantity, subtotal, taxAmount, currencyCode, restockType}],
                 shippingLines[{subtotalAmount, taxAmount, currencyCode}],
                 adjustments[{reason, amount, taxAmount, currencyCode}] }
```

Les lignes de remboursement sont rattachées à leur `Refund`, avec `orderLineId`. Elles ne sont pas dupliquées sous `orderLines`.

### Agrégat complet

**Le caller garantit que chaque collection est complète** : toutes les lignes, toutes les lignes de livraison, toutes les transactions avec tous leurs frais, et tous les remboursements avec leurs lignes, leur livraison et leurs ajustements.

Une collection vide signifie « aucun élément », jamais « non chargé ». Un chargement partiel est **interdit**.

C'est cette garantie qui rend vérifiés les zéros d'absence, par exemple `economicRefundsExTax = 0` sans remboursement.

Le futur loader DB devra respecter ce contrat.

## 3. Revenus (D1)

Pour chaque ligne **non carte cadeau** :

```
lineAfterDiscount = originalTotal − Σ discountAllocations.amount
lineRevenueExTax  = lineAfterDiscount                   si taxesIncluded = false
                  = lineAfterDiscount − Σ taxLines.amount si taxesIncluded = true
```

`productRevenueExTax = Σ lineRevenueExTax`. Règles :
- Cartes cadeaux : exclues.
- Remises : les allocations font foi, pas `Order.totalDiscounts`.
- Totaux Shopify : jamais une source (ils ne figurent pas dans le DTO).
- Taux de taxe : informatif seulement, il n'est pas dans le DTO.

Livraison : uniquement les lignes `isRemoved = false`, sur la base de `discountedPrice`. Si `taxesIncluded = true`, on retire `Σ ShippingLineTax.amount`.

Le revenu de livraison n'est **jamais** un coût de livraison : `shippingCost` vient uniquement des coûts externes.

## 4. Remboursements économiques

Deux mondes séparés :

| | Source | Sert à |
|---|---|---|
| Quantités, remise en stock | `Refund.lines` | COGS (§5), **quel que soit** le statut de l'argent |
| Argent | Transactions `REFUND` | `economicRefundsExTax` |

- Une transaction compte si `kind = REFUND`, `status = SUCCESS` et `test = false`. Toutes les passerelles comptent, `shopify_store_credit` compris (D6).
- `PENDING`, `AWAITING_RESPONSE`, `UNKNOWN`, `FAILURE`, `ERROR` et `SUGGESTED_REFUND` ne comptent pas.
- Un Refund sans transaction `SUCCESS` vaut 0.
- Un Refund réalisé est compté **une seule fois** :
  `Σ RefundLine.subtotal + Σ RefundShippingLine.subtotalAmount`, hors taxe (`taxesIncluded = false`, PG-000 §3.2).
- `OrderTransaction.amount` (TTC) n'est jamais utilisé comme montant HT.

Contrôles appliqués à un Refund réalisé (aucune auto-réparation) :

1. `taxesIncluded = true` : `UNRESOLVED_TAX_INCLUDED_REFUND`.
2. Ajustement non nul : `UNRESOLVED_REFUND_ADJUSTMENT`.
3. Ligne de carte cadeau remboursée : `UNRESOLVED_GIFT_CARD_REFUND`.
4. Transaction `REFUND` non finale (ni `SUCCESS`, ni `FAILURE`, ni `ERROR`) à côté d'un `SUCCESS` : `AMBIGUOUS_PARTIAL_REFUND`. Un échec définitif à côté d'un `SUCCESS` (tentative ratée) est accepté.
5. `Σ SUCCESS.amount` doit égaler `Σ subtotal + Σ taxAmount` (lignes et livraison). Sinon : `AMBIGUOUS_PARTIAL_REFUND`. Ce contrôle couvre aussi plusieurs `SUCCESS` non réconciliables.
6. `Refund.totalRefunded` (contrôle, qui ne compte que les `SUCCESS` [T]) doit égaler `Σ SUCCESS.amount`. Sinon : `REFUND_TOTAL_MISMATCH`. Il n'est jamais utilisé comme montant.

Une transaction `REFUND` non rattachée à un Refund de la commande déclenche `INCONSISTENT_AGGREGATE`.

## 5. COGS (snapshot uniquement, D3)

- Source : `OrderLineCostSnapshot` exclusivement. Le coût courant de l'`InventoryItem` n'est pas dans le DTO.
- Par ligne non carte cadeau :
  `netLineCogs = quantity × unitCost − returnedQty × unitCost`,
  avec `returnedQty = Σ RefundLine.quantity` des types `RETURN` et `CANCEL`, **quel que soit le statut du remboursement**.
- `NO_RESTOCK` : le COGS reste dû.
- Autre `restockType` : `UNKNOWN_RESTOCK_TYPE`.
- `returnedQty > quantity` : `INVALID_RETURN_QUANTITY`. Jamais de plancher à 0.
- Cartes cadeaux exclues : aucun COGS inventé.

Provenance :

| Snapshot | `FinancialValue` |
|---|---|
| absent, ou `MISSING` | `missing` |
| `SHOPIFY_UNIT_COST`, `historicalApproximation = false` | `verified` |
| `SHOPIFY_UNIT_COST`, `historicalApproximation = true` | **`estimated`** |
| `MANUAL` (quel que soit `historicalApproximation`) | `verified` |
| `ESTIMATED` | `estimated` |

`historicalApproximation = true` signifie « coût actuel appliqué à une commande passée », lors du backfill (PG-001 §7). Ce coût Shopify n'est pas vérifié pour la date de la commande : il devient donc `estimated`.

Ce flag ne dégrade **que** `SHOPIFY_UNIT_COST`. Une valeur `MANUAL` a été saisie ou corrigée explicitement par le marchand : elle reste `verified`, même si un ancien flag vaut `true`.

Agrégation des lignes :
- une ligne `missing` rend le COGS de la commande `missing` (`amount: null`), même si cette ligne est entièrement retournée ;
- sinon, une ligne `estimated` le rend `estimated` ;
- sinon il est `verified`.

Un coût connu de 0 reste `verified 0`. Une commande sans ligne de produit a un COGS `verified 0`, en vertu du contrat d'agrégat complet.

## 6. Frais de paiement

- `paymentFeesOverride` fourni : il est transmis tel quel, après validation.
- Sinon, on additionne les `TransactionFee` des transactions `SALE` / `CAPTURE` en `SUCCESS`, non test. Le résultat est `verified` **uniquement si** :
  - il existe au moins une transaction de paiement ;
  - toutes ont `gateway = "shopify_payments"` ;
  - **et** chacune a au moins une ligne de frais (frais remplis immédiatement [T], PG-000 §8).
- Sinon, le résultat est `missing` : passerelle tierce, liste de frais vide ou aucun paiement. Jamais `verified 0` à cause de `fees = []`.
- Les transactions `AUTHORIZATION`, `VOID`, en échec, en attente ou de test sont ignorées.
- Des frais sur un `REFUND` `SUCCESS` : `UNRESOLVED_REFUND_FEES`, car leur sens et leur signe sont [NC] (PG-000 §8).

## 7. Coûts externes

`ExternalProfitCosts { shippingCost?, adCost?, otherCosts?, paymentFeesOverride? }` :
- les valeurs sont transmises après validation du contrat `FinancialValue` de PG-002 ;
- une valeur absente donne `missing`, jamais 0 ;
- aucune règle de transport, de publicité ou de frais n'est implémentée.

## 8. Devise

`Order.currencyCode` est la seule référence. `Shop.currencyCode` n'est jamais utilisé.

Toutes les devises de la commande doivent être identiques à celle de la commande, sinon `CURRENCY_MISMATCH`. Cela concerne :
- lignes, allocations et taxes de ligne ;
- livraison et taxes de livraison ;
- remboursements, avec leurs lignes, leur livraison et leurs ajustements ;
- transactions et leurs frais ;
- snapshots COGS dotés d'un coût.

Aucune conversion FX.

## 9. Erreurs (`OrderProfitNormalizationError { code, field, message }`)

| Code | Cas |
|---|---|
| `INVALID_CURRENCY` | Devise de commande vide. |
| `CURRENCY_MISMATCH` | Devise différente de `Order.currencyCode`. |
| `INVALID_DECIMAL` | Pas un `Decimal` (par exemple un `number`), NaN ou Infinity. |
| `NEGATIVE_AMOUNT` | Montant négatif, ou taxe supérieure au prix TTC. |
| `INVALID_DISCOUNT` | Remises supérieures à `originalTotal`. |
| `INVALID_QUANTITY` | Quantité non entière ou négative. |
| `INVALID_RETURN_QUANTITY` | Quantité `RETURN` / `CANCEL` supérieure à la quantité commandée. |
| `UNKNOWN_RESTOCK_TYPE` | `restockType` sans règle D3. |
| `INCONSISTENT_AGGREGATE` | Ligne de remboursement vers une ligne inconnue, ou `REFUND` non rattaché. |
| `TEST_ORDER_NOT_NORMALIZABLE` | `order.test = true`. |
| `UNRESOLVED_TAX_INCLUDED_REFUND` | Remboursement réalisé avec `taxesIncluded = true`. |
| `UNRESOLVED_REFUND_ADJUSTMENT` | Ajustement non nul sur un remboursement réalisé. |
| `UNRESOLVED_GIFT_CARD_REFUND` | Ligne de carte cadeau dans un remboursement réalisé. |
| `UNRESOLVED_REFUND_FEES` | Frais sur un `REFUND` `SUCCESS`. |
| `AMBIGUOUS_PARTIAL_REFUND` | Part réalisée inconnue, ou argent ≠ reconstruction. |
| `REFUND_TOTAL_MISMATCH` | `totalRefunded` ≠ Σ `SUCCESS`. |
| `INVALID_FINANCIAL_VALUE` | Coût externe ou snapshot incohérent. |

## 10. Cas BLOCKED (erreur au lieu d'une estimation)

| Point | Origine [NC] | Erreur |
|---|---|---|
| Sens de `RefundLineItem.subtotalSet` quand `taxesIncluded = true` | PG-000 §3.2 | `UNRESOLVED_TAX_INCLUDED_REFUND` |
| Traitement des `orderAdjustments` (`REFUND_DISCREPANCY`…) | PG-000 §3.2, annexe B | `UNRESOLVED_REFUND_ADJUSTMENT` |
| Frais rendus ou prélevés sur remboursement | PG-000 §8 | `UNRESOLVED_REFUND_FEES` |
| Remboursement d'une carte cadeau (exclue du revenu par D1) | Aucune règle | `UNRESOLVED_GIFT_CARD_REFUND` |
| Remboursement partiellement réalisé | PG-000 §5 | `AMBIGUOUS_PARTIAL_REFUND` |
| Complétude des frais hors Shopify Payments, ou avec liste vide | PG-000 §8 | `paymentFees = missing` (pas d'erreur) |

Conséquence : **toute boutique en taxes incluses (cas général en France) dont une commande a un remboursement réalisé ne peut pas être normalisée** tant que PG-000 n'est pas amendé.

## 11. Hors scope

- Le loader Prisma qui construit l'agrégat complet.
- L'import Shopify, les webhooks et les jobs.
- Les règles de coûts de transport, de publicité et de frais tiers.
- Les droits de douane, pourboires et frais additionnels (hors revenu selon D1, et absents de `OrderProfitInput`).
- `ProfitSnapshot`, LTV et simulateur.
