# PG-000 — Contrat de données Shopify ↔ MarginPilot

| | |
|---|---|
| Statut | **Figé pour PG-001** : décisions verrouillées au §16.1. Validation partielle sur boutique de dev (PG-000B, annexe B). |
| Date | 2026-10-07 (PG-000B : 2026-10-07) |
| API cible | Shopify Admin GraphQL **2026-10** |
| Périmètre | Analyse et spécification uniquement. Aucune table métier, aucun Profit Engine, aucun import implémenté. |

## 0. Méthode et niveau de preuve

Chaque affirmation sur Shopify porte un marqueur :

- **[S]** — vérifié dans le **schéma 2026-10** par introspection
  (`https://shopify.dev/admin-graphql-direct-proxy/2026-10`, le proxy utilisé par `@shopify/api-codegen-preset`).
  Les types, la nullabilité et les descriptions cités en proviennent.
- **[D]** — vérifié dans la **documentation officielle shopify.dev** (URL indiquée).
- **[NC]** — **non confirmé** par la documentation. Hypothèse à valider sur une boutique de développement avant PG-001.
- **[T]** — **testé** sur une vraie boutique de développement (PG-000B, 2026-10-07). Le protocole et les résultats bruts sont dans l'annexe B.

### Validation technique

Les requêtes de l'annexe A ont été validées hors ligne avec `graphql-js` contre le schéma 2026-10 : 8 requêtes sur 8 valides.

Un test négatif confirme que ces champs **n'existent pas** en 2026-10 [S] :

- `Order.financialStatus`
- `LineItem.unitCost`
- `ProductVariant.unitCost`

PG-000B (2026-10-07) a exécuté ces requêtes contre une vraie boutique de développement, avec les seuls scopes `read_orders,read_products`. Résultats : annexe B.

### Références de base

- Objets : `https://shopify.dev/docs/api/admin-graphql/2026-10/objects/<Objet>`
- Scopes : https://shopify.dev/docs/api/usage/access-scopes
- Données client protégées : https://shopify.dev/docs/apps/launch/protected-customer-data

### Conventions sur les montants

- `Money` et `Decimal` sont des **chaînes décimales**, par exemple `"29.99"` [S].
- MarginPilot ne les convertit **jamais** en float.
- Stockage prévu : `NUMERIC` PostgreSQL, manipulé en `Prisma.Decimal`.
- `TaxLine.rate` est un `Float` [S]. Il reste purement informatif et n'entre dans aucun calcul : on utilise toujours les montants `priceSet`.
- **Une valeur inconnue n'est jamais égale à zéro** (§16.1, D7). Toute donnée financière absente garde son état de provenance (`missing`, `estimated` ou `verified`).

---

## 1. Architecture générale

### 1.1 Source de vérité

| Domaine | Source de vérité |
|---|---|
| Boutique, produits, variantes, commandes, lignes, remboursements, transactions, coût unitaire courant (`unitCost`) | **Shopify** |
| Coûts manuels, coûts estimés, règles de frais (paiement, transport, emballage…), dépenses publicitaires | **MarginPilot** |
| Snapshots financiers (dont snapshot COGS par ligne de commande) et calculs de profit | **MarginPilot** |

MarginPilot ne fait que **lire** Shopify. Il n'y écrit rien (voir §10).

### 1.2 Un webhook est une notification, pas un état

Les webhooks ne sont ni garantis ni ordonnés [D] (https://shopify.dev/docs/apps/build/webhooks/best-practices) :

- « Webhook delivery isn't always guaranteed » ;
- « Shopify doesn't guarantee ordering within a topic, or across different topics for the same resource ».

MarginPilot ne persiste donc **jamais** l'état métier à partir du payload d'un webhook. Pipeline cible :

```
Webhook (HMAC vérifié, réponse 200 < 5 s)
   ↓
notification de changement   (shop, topic, GID ressource, X-Shopify-Event-Id)
   ↓
job                          (dédupliqué, asynchrone, rejouable)
   ↓
refetch GraphQL de la ressource par GID (version 2026-10)
   ↓
normalisation                (montants Decimal, devise explicite, statuts)
   ↓
DB MarginPilot               (upsert idempotent, voir §14)
   ↓
recalcul                     (profit des entités impactées)
```

Contraintes de réception [D] (https://shopify.dev/docs/apps/build/webhooks/troubleshooting-webhooks) :

- répondre « within five seconds » ;
- Shopify retente l'envoi « up to eight times in a four-hour period ».

Le handler HTTP ne fait donc qu'enregistrer la notification. Tout le travail se fait dans le job.

Une **réconciliation périodique** complète les webhooks. Shopify recommande des « reconciliation jobs to periodically fetch data from Shopify » [D] (page best-practices).

---

## 2. Tableau objet Shopify → champs → usage MarginPilot

Dans la colonne N, `!` signifie non nullable dans le schéma 2026-10 [S].
Le scope de chaque objet vient de https://shopify.dev/docs/api/usage/access-scopes [D].

### 2.1 Shop

Scope : aucun scope dédié. La requête `shop` réussit avec `read_orders,read_products` seuls [T].

| Donnée | Champ | Type | N | Usage MarginPilot / remarque |
|---|---|---|---|---|
| ID | `Shop.id` | `ID` | ! | Clé du tenant. |
| Nom | `Shop.name` | `String` | ! | Affichage. |
| Domaine | `Shop.myshopifyDomain` | `String` | ! | Identifiant technique stable (sessions, webhooks). |
| Domaine public | `Shop.primaryDomain.host` | `String` | ! | Affichage uniquement. |
| Devise | `Shop.currencyCode` | `CurrencyCode` | ! | Devise de référence des `shopMoney` et de `unitCost`. Peut changer dans le temps : la devise est stockée **avec chaque montant**. |
| Timezone | `Shop.ianaTimezone` | `String` | ! | Découpage jour, semaine et mois des rapports. Timestamps stockés en UTC. |
| Taxes incluses | `Shop.taxesIncluded` | `Boolean` | ! | Réglage **actuel** de la boutique. Pour une commande, utiliser `Order.taxesIncluded`. |

`Shop.email` et `Shop.shopOwnerName` existent mais ne sont **pas** collectés (minimisation des données).

### 2.2 Product

Scope : `read_products`.

| Donnée | Champ | Type | N | Remarque |
|---|---|---|---|---|
| ID | `Product.id` | `ID` | ! | |
| Titre | `Product.title` | `String` | ! | Valeur courante, sans historique. |
| Statut | `Product.status` | `ProductStatus` | ! | Valeurs : `ACTIVE`, `ARCHIVED`, `DRAFT`, `UNLISTED` [S]. |
| Création | `Product.createdAt` | `DateTime` | ! | |
| MAJ | `Product.updatedAt` | `DateTime` | ! | Change aussi lors d'un ajustement de stock causé par une commande [S]. Ce n'est donc pas forcément une modification du catalogue. |

### 2.3 ProductVariant

Scope : `read_products`.

| Donnée | Champ | Type | N | Remarque |
|---|---|---|---|---|
| ID | `ProductVariant.id` | `ID` | ! | |
| Produit | `ProductVariant.product.id` | `ID` | ! | |
| Titre | `ProductVariant.title` | `String` | ! | |
| SKU | `ProductVariant.sku` | `String` | nullable | Peut être vide. Ce n'est jamais une clé. |
| Prix | `ProductVariant.price` | `Money` | ! | Prix courant en devise boutique. Le prix réellement vendu est sur la ligne de commande. |
| Inventory item | `ProductVariant.inventoryItem.id` | `ID` | ! | Porte le COGS. |
| COGS | `ProductVariant.inventoryItem.unitCost` | `MoneyV2` | **nullable** | Voir §4. `ProductVariant.unitCost` n'existe pas [S]. |
| Devise COGS | `…unitCost.currencyCode` | `CurrencyCode` | ! si `unitCost` non null | Toujours la devise boutique : « The shop's currency is used » [S][D]. |

### 2.4 InventoryItem

Scope : `read_inventory` **ou** `read_products`. Les deux sont acceptés pour cet objet [D] (https://shopify.dev/docs/api/admin-graphql/2026-10/objects/InventoryItem).
`read_products` seul suffit : `ProductVariant.inventoryItem.unitCost`, `inventoryItem(id:)` et `inventoryItems` répondent sans `read_inventory` [T].

| Donnée | Champ | Type | N | Remarque |
|---|---|---|---|---|
| ID | `InventoryItem.id` | `ID` | ! | |
| Coût unitaire | `InventoryItem.unitCost` | `MoneyV2` | nullable | Coût **courant** uniquement. |
| MAJ | `InventoryItem.updatedAt` | `DateTime` | ! | Sert à détecter un changement de coût. |
| Variantes | `InventoryItem.variants` | connexion | ! | `InventoryItem.variant` est **déprécié** [S]. |

### 2.5 Order

Scope : `read_orders`, limité aux 60 derniers jours (voir §10.2).

| Donnée | Champ | Type | N | Remarque |
|---|---|---|---|---|
| ID | `Order.id` | `ID` | ! | |
| Nom | `Order.name` | `String` | ! | Ex. `#1001`. Pas forcément unique (préfixes, multi-boutique) [S]. Affichage uniquement. |
| Numéro | `Order.number` | `Int` | ! | Ni consécutif ni garanti unique [S]. |
| Création | `Order.createdAt` | `DateTime` | ! | Fixé au checkout, immuable [S]. |
| MAJ | `Order.updatedAt` | `DateTime` | ! | Curseur de synchronisation incrémentale. |
| Traitement | `Order.processedAt` | `DateTime` | ! | Peut différer de `createdAt`, par exemple pour une commande importée [S]. **Date comptable de la vente** (§16.1, D2). |
| Annulation | `Order.cancelledAt` / `cancelReason` | `DateTime` / enum | nullable | |
| Test | `Order.test` | `Boolean` | ! | Les commandes de test sont **exclues** des calculs. |
| Devise boutique | `Order.currencyCode` | `CurrencyCode` | ! | Devise boutique **au moment de la commande** [S]. |
| Devise client | `Order.presentmentCurrencyCode` | `CurrencyCode` | ! | Informatif (multi-devise). |
| Statut financier | `Order.displayFinancialStatus` | enum | **nullable** | `financialStatus` n'existe pas [S]. C'est un statut **d'affichage**, jamais utilisé dans un calcul (voir §6). |
| Statut fulfillment | `Order.displayFulfillmentStatus` | enum | ! | Informatif. |
| Taxes incluses | `Order.taxesIncluded` | `Boolean` | ! | Indispensable pour interpréter sous-totaux et livraison. |
| Droits inclus | `Order.dutiesIncluded` | `Boolean` | ! | |
| Client | `Order.customer.id` | `ID` | nullable | Vaut `null` pour un guest checkout [S][D]. **Exige `read_customers`**, même pour le seul `id` : avec `read_orders` seul, Shopify renvoie `ACCESS_DENIED` « Required access: `read_customers` access scope » et toute la requête échoue [T]. |
| Passerelles | `Order.paymentGatewayNames` | `[String!]` | ! | Informatif. La source fiable est `OrderTransaction.gateway`. |
| Poids | `Order.totalWeight` | `UnsignedInt64`, en grammes | nullable | Base possible pour estimer le coût de transport (§7). |

### 2.6 LineItem

Scope : `read_orders`.

| Donnée | Champ | Type | N | Remarque |
|---|---|---|---|---|
| ID | `LineItem.id` | `ID` | ! | |
| Produit | `LineItem.product.id` | `ID` | **nullable** | `null` si le produit a été supprimé. |
| Variante | `LineItem.variant.id` | `ID` | **nullable** | `null` si la variante a été supprimée. Le snapshot COGS doit alors s'en passer. |
| Titre | `LineItem.title` | `String` | ! | Valeur « at time of order creation » [S] : historique fiable. |
| Titre variante | `LineItem.variantTitle` | `String` | nullable | Même principe que le titre. |
| SKU | `LineItem.sku` | `String` | nullable | |
| Quantité commandée | `LineItem.quantity` | `Int` | ! | Quantité d'origine, « including refunded and removed units » [S]. |
| Quantité courante | `LineItem.currentQuantity` | `Int` | ! | Hors unités remboursées et retirées [S]. |
| Quantité remboursable | `LineItem.refundableQuantity` | `Int` | ! | |
| Prix unitaire d'origine | `LineItem.originalUnitPriceSet` | `MoneyBag` | ! | Avant remise [S]. |
| Prix unitaire remisé | `LineItem.discountedUnitPriceAfterAllDiscountsSet` | `MoneyBag` | ! | Qualifié d'« approximate » [S]. Affichage uniquement, jamais dans un calcul. |
| Total d'origine | `LineItem.originalTotalSet` | `MoneyBag` | ! | `originalUnitPrice × quantity`, avant remise. |
| Remises de la ligne | `LineItem.discountAllocations[].allocatedAmountSet` | `MoneyBag` | ! | Inclut la part allouée des remises de commande et la part sur les quantités remboursées [S]. **Source de vérité des remises par ligne.** |
| Remise de ligne seule | `LineItem.totalDiscountSet` | `MoneyBag` | ! | **Exclut** les remises de niveau commande [S]. À ne pas utiliser seul. |
| Taxes | `LineItem.taxLines[].priceSet` | `MoneyBag` | ! | Inclut les taxes des quantités remboursées [S]. |
| Droits de douane | `LineItem.duties[].price` | `MoneyBag` | ! | |
| Carte cadeau | `LineItem.isGiftCard` | `Boolean` | ! | Exclue du CA produit (voir §3). |
| Coût | — | — | — | **`LineItem.unitCost` n'existe pas** [S]. Shopify ne fournit aucun COGS historique. |

### 2.7 Autres objets

| Objet | Scope | Détail |
|---|---|---|
| OrderTransaction | `read_orders` | §6 |
| Refund | `read_orders` | §5 |
| Customer | `read_customers`, retenu **uniquement** pour lire `Order.customer.id` (§16.1, D4 et D5). L'objet `Customer` n'est jamais interrogé. | §9 |

---

## 3. Données financières

### 3.1 Champs de commande et sémantique

Les montants sont des `MoneyBag` qui contiennent deux valeurs [S][D] :

- `shopMoney`, en devise boutique ;
- `presentmentMoney`, en devise du client.

MarginPilot calcule en **`shopMoney`**. `presentmentMoney` est conservé à titre informatif.

Shopify distingue deux familles de champs [D] (https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order) :

- **original / total** : état à la création, « before returns » ;
- **current** : état « after returns, refunds, order edits, and cancellations ».

| Champ | Sémantique documentée [S] | Usage MarginPilot |
|---|---|---|
| `subtotalPriceSet` | Somme des lignes **après remises**, **avant retours**. Inclut la taxe si `taxesIncluded`. | Contrôle de cohérence uniquement. |
| `currentSubtotalPriceSet` | Le schéma dit « total price of the order, after returns and refunds… includes taxes and discounts ». **Description ambiguë** : sous-total ou total ? [NC] | Ne pas utiliser. Observé [T] : baisse de `refundLineItems.subtotalSet` dès la création du Refund, même si la transaction REFUND est encore `PENDING`. Test sans livraison payante ni taxe : l'ambiguïté sous-total / total reste ouverte [NC]. |
| `totalPriceSet` | Total **avant retours**, taxes et remises incluses. | Total facturé initial. **Ce n'est pas le CA.** |
| `currentTotalPriceSet` | Total après retours. | Contrôle de cohérence. |
| `originalTotalPriceSet` | Total à la création. | Contrôle des éditions de commande. |
| `totalDiscountsSet` / `currentTotalDiscountsSet` | Remises totales (ligne et commande), avant / après retours. | Contrôle. Le calcul part des `discountAllocations` des lignes. |
| `cartDiscountAmountSet` | Remise panier à la création, avant retours. | Informatif. |
| `totalShippingPriceSet` | Le schéma dit « total shipping costs **returned to the customer**… includes fees and any related discounts that were refunded ». **Formulation ambiguë.** [NC] | Ne pas utiliser. Test PG-000B non concluant : livraison gratuite, donc tous les champs de livraison valent `0.0` (annexe B, F). |
| `currentShippingPriceSet` | Livraison après remboursements et remises. Inclut la taxe si `taxesIncluded`. | Contrôle de la livraison facturée nette. |
| `totalTaxSet` / `currentTotalTaxSet` | Taxes avant / après retours. | Taxes collectées, qui ne sont pas un revenu. |
| `originalTotalDutiesSet` / `currentTotalDutiesSet` | Droits de douane avant / après modifications. | Hors CA, ligne séparée (§16.1, D1). |
| `originalTotalAdditionalFeesSet` / `currentTotalAdditionalFeesSet` | Frais additionnels (droits, frais d'import…). Nullable. | Hors CA, ligne séparée (§16.1, D1). |
| `totalTipReceivedSet` | Pourboires. | Hors CA produit. |
| `totalReceivedSet` | Montant **reçu** du client, avant retours. | Rapprochement avec les transactions. |
| `netPaymentSet` | Reçu moins remboursé. **Non déprécié** [S] : seul le scalaire `netPayment` l'est. | Rapprochement. |
| `totalRefundedSet` | Total remboursé. Ne compte **que** les transactions abouties : il reste à `0.0` tant que la transaction REFUND est `PENDING` [T]. | Rapprochement avec les transactions REFUND. |
| `totalRefundedShippingSet` | Livraison remboursée. | Contrôle. |
| `totalOutstandingSet` | Montant pas encore transacté. Positif = en faveur du marchand. | Détection des commandes non soldées. |

**Règle :** aucun champ « total » Shopify n'est pris tel quel comme chiffre d'affaires MarginPilot.

- Le CA est **reconstruit** à partir des lignes, des allocations de remise, des lignes de livraison et des remboursements.
- Les totaux de commande servent de **contrôles de cohérence**. Un écart signale une donnée à inspecter.

### 3.2 Reconstruction proposée (spécification, non implémentée)

Toutes les grandeurs sont en `shopMoney`, en Decimal.

Si `Order.taxesIncluded = true`, les prix des lignes et de la livraison **incluent la taxe** [S]. Il faut alors retirer la taxe pour obtenir un montant HT.

| Grandeur | Formule de référence |
|---|---|
| Prix brut produits | Σ des lignes non cadeau : `originalTotalSet` |
| Remises | Σ des lignes non cadeau : Σ `discountAllocations.allocatedAmountSet` |
| CA produit brut (après remises) | Prix brut − Remises, moins les taxes de ligne si `taxesIncluded` |
| Livraison facturée | Σ des `shippingLines` non retirées : `discountedPriceSet`, moins les taxes de livraison si `taxesIncluded` |
| Taxes collectées | Σ `LineItem.taxLines.priceSet` + Σ `ShippingLine.taxLines.priceSet` |
| Droits | Σ `LineItem.duties.price` |
| Total payé | Σ des transactions `SALE` / `CAPTURE` en `SUCCESS`, moins `CHANGE` (voir §6) |
| Remboursements produits | Σ `RefundLineItem.subtotalSet`, plus les taxes via `totalTaxSet` |
| Remboursement livraison | Σ `RefundShippingLine.subtotalAmountSet`, plus `taxAmountSet` |
| Remboursement économique | Σ des transactions `REFUND` en `SUCCESS`, **toutes passerelles**, y compris `shopify_store_credit` (§5, §16.1 D6) |
| dont remboursement cash | Même somme, **hors** `gateway = "shopify_store_credit"` |
| dont crédit en boutique | Même somme, **uniquement** `gateway = "shopify_store_credit"` |
| Revenu commercial total HT | CA produit HT + Livraison facturée HT (§16.1, D1) |
| Net après remboursements | CA produit brut + Livraison facturée − remboursements HT (produits et livraison) ± `orderAdjustments` |

Deux points restent à **valider sur des commandes réelles** [NC] :

- `RefundLineItem.subtotalSet` inclut-il la taxe quand `taxesIncluded = true` ? La boutique de test ne collectait aucune taxe (`totalTaxSet = 0.0`), donc ce point n'a pas pu être tranché.
- Les `orderAdjustments` corrigent-ils l'écart entre le montant calculé et le montant réellement remboursé ?
  Observé [T] :
  - le Refund dont la transaction est `PENDING` porte un `orderAdjustment` `REFUND_DISCREPANCY` égal au montant non encore rendu (885.95) ;
  - le Refund dont la transaction est immédiatement `SUCCESS` (crédit en boutique) n'en porte aucun.
  L'évolution de l'ajustement quand une transaction `PENDING` passe en `SUCCESS` reste [NC] (annexe B, D).

La définition du CA « MarginPilot » est figée au §16.1, D1 : calcul en HT, CA produit et livraison séparés.

---

## 4. COGS

### 4.1 Contrat Shopify

| Point | Constat |
|---|---|
| Champ | `InventoryItem.unitCost: MoneyV2`, nullable [S]. |
| Relation | `ProductVariant.inventoryItem: InventoryItem!` : une variante a un inventory item [S]. Dans l'autre sens : `InventoryItem.variants`. |
| Scope | `read_inventory` **ou** `read_products` [D] (page InventoryItem). `read_products` seul suffit, testé [T]. `read_inventory` n'est pas demandé (§16.1, D4). |
| Devise | Toujours la devise boutique : « The shop's currency is used » [S][D]. Observé `{ amount: "400.0", currencyCode: "EUR" }` sur une boutique en EUR [T]. Aucun coût par marché ou par devise documenté [NC]. |
| Format | `amount` vaut `"400.0"` en GraphQL, alors que le payload du webhook `inventory_items/update` porte `cost: "400.00"` [T]. Les comparaisons se font **en Decimal**, jamais sur les chaînes. |
| `unitCost` absent | Vaut `null` quand le marchand n'a pas saisi de coût. MarginPilot ne le remplace **jamais** par 0. La ligne est marquée **COGS manquant** et le profit de la commande est **incomplet**. |
| Permission utilisateur | « the user must have "View product costs" permission… once product granular permissions are enabled » [S]. Cela vise a priori les tokens *online* (utilisateur), alors que les jobs utiliseront le token *offline*. Effet sur le token offline : [NC]. Non testé en PG-000B : les permissions granulaires n'étaient pas activées sur la boutique de dev. |
| Import produits | Lisible dans la même requête que produits et variantes (`variants { inventoryItem { unitCost } }`). Requête validée [S] (annexe A). |
| Historique | **Aucun.** `LineItem.unitCost` n'existe pas [S]. Shopify n'expose que le coût **courant**. |

### 4.2 Contrat de snapshot (à implémenter plus tard)

1. **Création.** À la **première ingestion** d'une ligne de commande, MarginPilot fige un snapshot COGS :
   `(line_item, inventory_item_gid, unit_cost_amount, currency, source, captured_at)`.
2. **Valeurs de `source`.**
   - `shopify_unit_cost` : coût lu au moment de l'ingestion.
   - `manual` : coût saisi dans MarginPilot.
   - `estimated` : coût issu d'une règle MarginPilot.
   - `missing` : aucun coût disponible.
3. **Changement de coût.** Un changement ultérieur de `unitCost` (webhook `inventory_items/update`, déclenchement vérifié [T]) met à jour le **coût courant** de la variante. Il **ne modifie jamais** un snapshot existant.
4. **Import initial.** Le coût d'époque n'existe pas. Les commandes passées reçoivent donc le coût *actuel* au moment de l'import. Ces snapshots sont marqués « approximation historique », et le marchand peut les corriger manuellement.
5. **Ingestion tardive** (webhook perdu, rattrapage par la réconciliation). Le coût capturé est celui du moment de l'ingestion. `captured_at` le rend traçable.
6. **Variante supprimée** (`LineItem.variant = null`). Aucun coût n'est récupérable : snapshot `missing` ou `manual`.
7. **Corrections.** Toute correction manuelle d'un snapshot est explicite et tracée. Aucun recalcul silencieux.

---

## 5. Refunds

| Donnée | Champ | Type | N |
|---|---|---|---|
| ID | `Refund.id` | `ID` | ! |
| Commande | `Refund.order.id` | `ID` | ! |
| Création | `Refund.createdAt` | `DateTime` | **nullable** [S] |
| MAJ | `Refund.updatedAt` | `DateTime` | ! |
| Lignes | `Refund.refundLineItems` (connexion) | — | ! |
| Ligne d'origine | `RefundLineItem.lineItem.id` | `ID` | ! |
| Quantité | `RefundLineItem.quantity` | `Int` | ! |
| Sous-total | `RefundLineItem.subtotalSet` | `MoneyBag` | ! |
| Taxes | `RefundLineItem.totalTaxSet` | `MoneyBag` | ! |
| Remise en stock | `RefundLineItem.restockType` / `restocked` | enum / `Boolean` | ! |
| ID ligne remboursée | `RefundLineItem.id` | `ID` | **nullable** [S] |
| Livraison remboursée | `Refund.refundShippingLines[].subtotalAmountSet` / `taxAmountSet` | `MoneyBag` | ! |
| Droits remboursés | `Refund.duties[].amountSet` | `MoneyBag` | liste nullable |
| Ajustements | `Refund.orderAdjustments[]` (`amountSet`, `taxAmountSet`, `reason`) | — | ! |
| Transactions | `Refund.transactions` (connexion `OrderTransaction`) | — | ! |
| Total | `Refund.totalRefundedSet` | `MoneyBag` | ! — « total amount across all transactions for the refund » |

### Un Refund n'est pas forcément un mouvement d'argent

- Doc Refund : « The existence of a `Refund` object doesn't guarantee that the money has been returned… check the status of the associated transactions » [D] (https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Refund).
- Le webhook `refunds/create` se déclenche « independent from the movement of money » [S] (`WebhookSubscriptionTopic.REFUNDS_CREATE`).

### Règles MarginPilot

- **Remboursement économique** = Σ des `Refund.transactions` avec `kind = REFUND` **et** `status = SUCCESS`, en `amountSet.shopMoney`, toutes passerelles confondues.
  - **Remboursement cash** : la même somme, hors `gateway = "shopify_store_credit"`.
  - **Crédit en boutique** : uniquement `gateway = "shopify_store_credit"` (§16.1, D6).
- **Transaction `PENDING`, `AWAITING_RESPONSE` ou `UNKNOWN`** : remboursement en attente. Il n'est pas compté et sera revérifié.
- **Transaction `FAILURE` ou `ERROR`** : aucun mouvement d'argent.
- **Refund sans transaction** (simple remise en stock, ou remboursement fait hors Shopify) : les quantités sont retournées **sans** sortie d'argent. Ce cas se déduit de la séparation entre Refund et transaction ; aucune doc ne le formule explicitement [NC]. Non testé en PG-000B.
- **Quantités et argent sont suivis séparément.**
  - Une unité retournée et remise en stock (`restockType = RETURN` ou `CANCEL`) annule son COGS.
  - Avec `NO_RESTOCK`, la marchandise est perdue et le COGS reste dû.
  - Règle figée au §16.1, D3.
- **`Refund.totalRefundedSet`** sert uniquement de contrôle.
  - Transaction en attente : il vaut `0.0` tant que la transaction REFUND est `PENDING`, alors que les quantités, `currentTotalPriceSet` et `currentSubtotalPriceSet` sont déjà réduits [T].
  - Transaction en échec : comportement non testé [NC].
- **Ordre des effets** observé [T] : à la création du Refund, quantités et totaux `current*` baissent tout de suite, mais `Order.totalRefundedSet`, `netPaymentSet` et `displayFinancialStatus` (`PAID`) ne bougent pas tant que l'argent n'est pas parti. Cela confirme la règle « quantités et argent suivis séparément ».
- **`restockType`** : un remboursement avec remise en stock sur une commande **non expédiée** donne `restockType = CANCEL`, `restocked = true` [T].
- **Crédit en boutique** [T] : un remboursement en « crédit en boutique » produit une transaction `REFUND` / `SUCCESS` immédiate.
  - Ses attributs : `gateway = "shopify_store_credit"`, `parentTransaction = null`, `paymentId` du type `#1001.1`, `fees = []`.
  - Elle est comptée dans `Refund.totalRefundedSet`, `Order.totalRefundedSet` et `netPaymentSet`, et fait passer `displayFinancialStatus` à `PARTIALLY_REFUNDED`.
  - **Aucune sortie de trésorerie** n'a lieu : le marchand crée un passif, que le client dépensera plus tard.
  - MarginPilot classe donc les REFUND par `gateway`. Le crédit en boutique compte comme **remboursement économique**, et reste distingué d'un remboursement cash (§16.1, D6).

---

## 6. Transactions

| Donnée | Champ | Type | N |
|---|---|---|---|
| ID | `OrderTransaction.id` | `ID` | ! |
| Commande | `OrderTransaction.order.id` | `ID` | nullable |
| Type | `OrderTransaction.kind` | `OrderTransactionKind` | ! |
| Statut | `OrderTransaction.status` | `OrderTransactionStatus` | ! |
| Passerelle | `OrderTransaction.gateway` / `formattedGateway` | `String` | nullable |
| Montant | `OrderTransaction.amountSet` | `MoneyBag` | ! |
| Règlement | `settlementCurrency` / `settlementCurrencyRate` | `CurrencyCode` / `Decimal` | nullable |
| Date | `OrderTransaction.processedAt` | `DateTime` | nullable ; repli sur `createdAt`, non nullable |
| Parent | `OrderTransaction.parentTransaction.id` | `ID` | nullable ; par exemple l'autorisation d'une capture [S] |
| Test | `OrderTransaction.test` | `Boolean` | ! |
| Erreur | `OrderTransaction.errorCode` | enum | nullable |
| Frais | `OrderTransaction.fees` | `[TransactionFee!]!` | ! ; Shopify Payments uniquement (§8) |

### Classification

Basée sur les enums `OrderTransactionKind` et `OrderTransactionStatus` [S].

| Cas | Critère | Effet pour MarginPilot |
|---|---|---|
| Autorisation | `kind = AUTHORIZATION` ou `EMV_AUTHORIZATION` | **Aucun** encaissement : « Money does not change hands until the authorization is captured ». |
| Capture | `kind = CAPTURE`, `status = SUCCESS` | Encaissement. Le parent est l'autorisation. |
| Vente | `kind = SALE`, `status = SUCCESS` | Encaissement : autorisation et capture en une seule étape. |
| Remboursement | `kind = REFUND`, `status = SUCCESS` | Décaissement. |
| Annulation | `kind = VOID` | Libère une autorisation. **Aucun** mouvement d'argent. |
| Rendu monnaie | `kind = CHANGE` | Décaissement, pour un paiement en espèces. |
| Suggestion | `kind = SUGGESTED_REFUND` | **Ignoré** : ce n'est pas une vraie transaction. |
| Échec | `status = FAILURE` ou `ERROR` | **Ignoré** pour les montants, conservé pour l'audit. |
| En attente | `status = PENDING`, `AWAITING_RESPONSE` ou `UNKNOWN` | Provisoire : non compté, à revérifier. |
| Test | `test = true` | Exclu. |

`Order.displayFinancialStatus` est un statut **d'affichage** [S], nullable. Il n'entre dans aucun calcul.

`Order.transactions` est une **liste**, pas une connexion [S]. Sa limite de taille est à vérifier [NC].

Observé [T] (Shopify Payments en mode test, capture automatique) :

- le paiement au checkout produit une seule transaction `SALE` / `SUCCESS`, avec `parentTransaction = null` et `test = true` ;
- le remboursement vers la carte produit une transaction `REFUND` `PENDING`, dont `parentTransaction` pointe vers la `SALE`. Elle était **toujours `PENDING` environ 8 minutes plus tard**, à la fin des tests. Son statut final n'a pas été observé ;
- le remboursement en crédit en boutique produit une transaction `REFUND` / `SUCCESS`, gateway `shopify_store_credit`, sans parent (§5) ;
- `AUTHORIZATION` / `CAPTURE` (capture manuelle) **non testés** [NC].

---

## 7. Shipping

Deux notions distinctes :

- **A.** la livraison facturée au client ;
- **B.** le coût réel payé par le marchand au transporteur.

| | A. Livraison facturée au client | B. Coût réel transporteur |
|---|---|---|
| Disponible dans l'API ? | **Oui** | **Non**, à notre connaissance |
| Champs | `Order.shippingLines` (`includeRemovals: true`) : `originalPriceSet`, `discountedPriceSet`, `currentDiscountedPriceSet`, `discountAllocations`, `taxLines`, `isRemoved`, `title`, `code`, `source`, `carrierIdentifier` [S] | `ShippingLabel` n'expose que `cancellable`, `id`, `location`, `printed`, `shippingDocuments` et `trackingInfo`, sans aucun prix [D] (https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ShippingLabel). Une recherche des champs « cost » dans le schéma ne trouve aucun coût d'étiquette ni de transport [S]. |
| Remboursements | `Refund.refundShippingLines` [S] | — |
| Taxe | Incluse dans le prix si `Order.taxesIncluded` [S] | — |

**A et B ne sont jamais assimilés.** Une livraison facturée 0 € n'implique pas un coût nul, et inversement.

Pour MarginPilot, B est un **coût externe**. Trois sources possibles, de la plus fiable à la moins fiable :

1. **manuel** : saisi par commande ;
2. **importé** : facture transporteur, CSV ;
3. **estimé** : règle MarginPilot par zone, poids (`Order.totalWeight`), méthode (`ShippingLine.code` / `title`) ou forfait.

La source est stockée avec le coût.

Coût des étiquettes Shopify Shipping : probablement non exposé [NC]. Aucune doc ne l'affirme explicitement.

PG-000B [T] : la seule commande de test utilisait une livraison gratuite (« Standard », `source = shopify`, `carrierIdentifier = null`, `ShippingLine.id` présent). `originalPriceSet`, `discountedPriceSet`, `currentDiscountedPriceSet`, `totalShippingPriceSet` et `currentShippingPriceSet` valaient tous `0.0`, sans remboursement de livraison. La comparaison de ces champs reste donc **à faire** avec une livraison payante et un remboursement partiel de livraison [NC].

---

## 8. Payment fees

| Élément | Disponibilité |
|---|---|
| Passerelle utilisée | `OrderTransaction.gateway` [S], scope `read_orders`. |
| Montant de la transaction | `OrderTransaction.amountSet` [S]. |
| Frais Shopify Payments par transaction | `OrderTransaction.fees: [TransactionFee!]!`. Champs de `TransactionFee` : `amount`, `flatFee`, `rate` (Decimal), `taxAmount`, `type`, `flatFeeName`, `rateName` [S]. « Only present for Shopify Payments transactions » [S][D]. Scope `read_orders`, testé [T]. |
| Frais Shopify Payments rapprochés du solde | `ShopifyPaymentsBalanceTransaction.fee` / `net` / `amount`, reliés à la transaction par `sourceOrderTransactionId` et `associatedOrder` [S]. Scope `read_shopify_payments_payouts` et permission utilisateur `view_payouts` [D] (https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ShopifyPaymentsBalanceTransaction). |
| `OrderTransaction.shopifyPaymentsSet` | Boutiques **Shopify Plus uniquement** [S]. Non utilisé. |
| Frais des passerelles tierces (PayPal, Stripe, Klarna…) | **Non disponibles.** `fees` est réservé à Shopify Payments et aucun champ documenté n'expose les frais tiers [D/NC]. |
| `receiptJson` | « gateway-specific and not a stable contract » [S]. **Interdit** comme source de frais. |

### Contrat MarginPilot

1. **Shopify Payments.** Les frais viennent de `OrderTransaction.fees`, avec la source `shopify_payments`.
   - Remplis **immédiatement** [T] : la transaction `SALE` portait ses frais à la première lecture, quelques minutes après le checkout et avant tout versement.
   - Exemple observé : vente de 2657.85 EUR, frais de 72.01 EUR, soit 2657.85 × 0.027 + 0.25 arrondi.
     - `type = "processing_fee"`, `rate = "0.027"`, `rateName = "international_card_not_present"` ;
     - `flatFee = 0.25`, `flatFeeName = null`, `taxAmount = 0.0`.
   - La réconciliation périodique reste nécessaire pour les cas non observés.
2. **Autres passerelles.** Les frais sont **estimés** par une règle MarginPilot par passerelle (taux + part fixe), avec la source `estimated`.
3. **Frais sur remboursement.** Le comportement des processeurs (frais rendus ou non) n'est pas documenté [NC]. Il passe par une règle explicite. Observé [T] : la transaction `REFUND` Shopify Payments a `fees = []` (lue au statut `PENDING`). Aucun frais n'est rendu, aucun frais supplémentaire n'est prélevé.
4. **Scope.** `read_shopify_payments_payouts` **n'est pas** demandé au MVP. C'est une option de phase 2, pour le rapprochement fin avec les versements.

---

## 9. Customer, LTV et données personnelles

### 9.1 Ce qui est protégé

Source [D] : https://shopify.dev/docs/apps/launch/protected-customer-data

- **Niveau 1** : « Customer data **excluding** name, address, phone, and email fields ».
- **Niveau 2** : données client **incluant** nom, adresse, téléphone ou email.
- **Les commandes sont elles-mêmes protégées** : « Orders, draft orders, abandoned checkouts, refunds, transactions, and other data that relate to a single customer ». Les webhooks associés le sont aussi.
- **App publique** : les deux niveaux sont soumis à « Requires review ». Avant approbation, « the API won't return data from non-development stores ».
- **Boutique de développement** : aucune demande nécessaire.
- **Après approbation**, les champs non approuvés sont caviardés (renvoyés à `null`).

**Conséquence :**

- Même sans aucune PII, MarginPilot doit obtenir l'**approbation niveau 1** pour fonctionner sur des boutiques réelles.
- Le **niveau 2 n'est jamais demandé.**

### 9.2 Minimum pour la LTV

| Donnée | Source | Scope | Retenu |
|---|---|---|---|
| ID client | `Order.customer.id` [S] | **`read_customers` obligatoire** [T] : avec `read_orders` seul, `customer { id }` renvoie `ACCESS_DENIED`. Aucun autre champ de `Order` n'expose l'ID client (introspection 2026-10 : `customer`, `customerAcceptsMarketing`, `customerJourneySummary`, `customerLocale`, `canNotifyCustomer`) [T]. Plus le niveau 1. | **Oui** (§16.1, D5) |
| Nombre de commandes, montants cumulés | **Calculés par MarginPilot** à partir des commandes importées | — | Oui |
| `Customer.numberOfOrders` / `amountSpent` | [S] (`UnsignedInt64!` / `MoneyV2!`), sur tout l'historique de la boutique | `read_customers` [D] | **Non au MVP** |
| Nom, prénom, email, adresse, téléphone | — | Niveau 2 | **Jamais** |

### Recommandation

- La LTV est calculée sur **l'historique importé par MarginPilot** : commandes rattachées à un `customer.id`, avec les montants **nets** MarginPilot.
- Cela **impose `read_customers`** [T], qui est retenu (§16.1, D4). Ce scope ne donne pas pour autant accès aux PII : nom, email, adresse et téléphone restent soumis au niveau 2, jamais demandé.
- Aucun rapprochement de clients par email, nom, téléphone ou adresse.
- On n'utilise pas `amountSpent` : c'est un montant brut Shopify, dont la devise n'est pas documentée [NC].
- Sans `read_all_orders`, l'historique ne couvre que 60 jours : la LTV est donc tronquée (voir §10.2).
- Les commandes **guest** (`customer = null`) ne sont rattachables à aucun client. Elles sont exclues de la LTV et comptées à part.

### Règles de minimisation

- Les requêtes GraphQL ne sélectionnent **aucun** champ PII.
- Les payloads de webhook, qui peuvent contenir des PII, ne sont **jamais** persistés ni journalisés. Seuls l'ID, le topic et les en-têtes de déduplication sont conservés.
- Les exigences du niveau 1 (minimisation, limitation de finalité, rétention, chiffrement en transit et au repos) font partie du cahier des charges technique.

---

## 10. Scopes

### 10.1 Scopes MVP retenus (lecture seule)

```toml
[access_scopes]
scopes = "read_orders,read_products,read_customers"
```

Décision figée au §16.1, D4.

Source [D] : https://shopify.dev/docs/api/usage/access-scopes

| Scope | Nécessaire ? | Justification |
|---|---|---|
| `read_orders` | **Oui** | `Order`, `OrderTransaction`, remboursements, et les webhooks associés. Couvre les « orders created within the last 60 days ». |
| `read_products` | **Oui** | `Product`, `ProductVariant` et les webhooks `products/*`. |
| `read_inventory` | **Non nécessaire** [T] | `read_products` seul lit `InventoryItem.unitCost` et reçoit `inventory_items/update` (§4.1, §11). |
| `read_customers` | **Oui** | `Order.customer { id }` exige ce scope [T]. Utilisé **uniquement** pour cet ID (LTV, §9). |
| `read_shopify_payments_payouts` | **Non au MVP** | Rapprochement des versements, prévu en phase 2 (§8). |
| `read_all_orders` | **Prévu**, demandé dès que possible, déclaré après approbation Shopify | Voir §10.2. |
| Tout scope `write_*` | **Jamais** | MarginPilot n'écrit rien dans Shopify. |

### 10.2 `read_all_orders`

**Utilité.** Ce scope donne accès à toutes les commandes, au-delà de la fenêtre par défaut de 60 jours. Il est indispensable pour un historique de rentabilité et une LTV réalistes.

**Approbation** [D] (https://shopify.dev/docs/api/usage/access-scopes) :

- Le scope est marqué « Shopify approval required ».
- La demande se fait depuis le Partner Dashboard : Apps, puis l'app, puis « API access requests », puis la carte « Read all orders scope », puis « Request access », avec une justification.
- Si on déclare le scope avant l'approbation, la création d'une version échoue avec « `app_access` validation error on `scopes` ».
- Le circuit équivalent dans le Dev Dashboard n'est pas documenté [NC].

**Stratégie MVP sans ce scope :**

1. L'import initial est limité aux 60 derniers jours. L'UI l'affiche clairement (« historique disponible depuis le JJ/MM »).
2. MarginPilot **accumule** l'historique dès l'installation : chaque commande importée est conservée au-delà de 60 jours. L'historique s'allonge donc naturellement avec le temps.
3. La LTV et les tendances sont marquées « partielles » tant que l'historique couvre moins de N mois.
4. La demande `read_all_orders` est déposée dès que l'app est prête pour la revue. Après approbation, un **backfill** complète les commandes antérieures.

---

## 11. Webhooks

### Déclaration

Les abonnements sont déclarés en **app-specific** dans `shopify.app.toml` [D] (https://shopify.dev/docs/apps/build/webhooks/subscribe) :

- ils sont « applied uniformly » à toutes les boutiques ;
- en cas d'échec, ils « will not be deleted », contrairement aux abonnements shop-specific.

Le paramètre `api_version` du TOML « controls the GraphQL Admin API version used to serialize payloads » [D]. Il est aligné sur `2026-10` depuis PG-000B (le scaffold indiquait `2027-01`).

### Topics retenus

| Topic | Scope [S] | Raison | Données impactées | Traitement attendu |
|---|---|---|---|---|
| `orders/create` | `read_orders` | Nouvelle commande | Order, lignes, snapshot COGS | Job : refetch de la commande, upsert, **création des snapshots COGS**, recalcul. |
| `orders/updated` | `read_orders` | Toute modification : paiement, annulation, édition, remboursement… | Order et enfants | Job : refetch, upsert si `updatedAt` plus récent, recalcul. |
| `orders/delete` | `read_orders` | Suppression de commande | Order | Suppression logique et exclusion des calculs. |
| `refunds/create` | `read_orders` | Nouveau remboursement, « independent from the movement of money » | Refund, transactions | Job : refetch de la **commande** entière (avec remboursements et transactions), recalcul. |
| `order_transactions/create` | `read_orders` | Transaction créée ou changement de statut, uniquement pour success, failure et error | Transactions, frais | Job : refetch de la commande, recalcul de l'encaissé et des frais. |
| `products/create` | `read_products` | Nouveau produit | Product, variantes, coût courant | Job : refetch du produit et des variantes (avec `inventoryItem.unitCost`). |
| `products/update` | `read_products` | Produit modifié, ou variantes ajoutées, retirées ou modifiées. Se déclenche aussi lors d'une commande (stock). | Product, variantes, coût courant | Job : refetch, upsert si changement. Volume potentiellement élevé : déduplication par GID dans la file. |
| `products/delete` | `read_products` | Suppression de produit | Product, variantes | Suppression logique. Les snapshots COGS restent intacts. |
| `inventory_items/update` | `read_inventory` ou `read_products` | **Changement de `unitCost`**. Déclenchement vérifié avec `read_products` seul : une livraison par modification, payload `admin_graphql_api_id` + `cost` [T] | Coût courant | Job : refetch de l'InventoryItem et mise à jour du **coût courant uniquement**. |
| `app/uninstalled` | — | Désinstallation | Sessions, état de la boutique | Déjà présent : supprime les sessions. À ajouter : boutique marquée inactive, jobs arrêtés. **Pas** de purge immédiate : elle arrive avec `shop/redact`. |
| `app/scopes_update` | — | Changement de scopes | Session | Déjà présent dans le scaffold. |
| `customers/data_request` | aucun (conformité) | Demande d'accès RGPD | Données liées au `customer.id` | Fournir au marchand les données détenues : GID client, commandes et montants rattachés. Réponse 200, action sous 30 jours. |
| `customers/redact` | aucun (conformité) | Effacement d'un client, **différé** (voir ci-dessous) | Lien client ↔ commandes listées | Supprimer ou anonymiser le `customer.id` et les agrégats LTV du client. Les commandes, qui sont des données marchand, restent sans lien client. |
| `shop/redact` | aucun (conformité) | Envoyé 48 h après la désinstallation | Toutes les données de la boutique | **Purge complète** du tenant. |

### Webhooks de conformité

Source [D] : https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance

- Obligatoires pour l'App Store.
- Déclaration : `compliance_topics = ["customers/data_request","customers/redact","shop/redact"]`.
- Réponse 2xx, ou 401 si le HMAC est invalide.
- Action à réaliser « within 30 days of receiving the request », pour chacun des trois topics.

#### `customers/redact` et `shop/redact` : deux topics différents

| | `customers/redact` | `shop/redact` |
|---|---|---|
| Déclencheur | Le marchand demande l'effacement d'**un client**. | Le marchand **désinstalle** l'app. |
| Délai d'envoi | « If a customer hasn't placed an order in the past six months, then Shopify sends the payload 10 days after the deletion request. Otherwise, the request is withheld until six months have passed. » | « 48 hours after a store owner uninstalls your app ». |
| Payload | `shop_id`, `shop_domain`, `customer` (`id`, `email`, `phone`), `orders_to_redact` | `shop_id`, `shop_domain` uniquement |
| Portée | Un client et les commandes listées. La boutique reste active. | Toute la boutique. |
| Action MarginPilot | Délier `customer.id` des commandes de `orders_to_redact`, puis supprimer les agrégats LTV du client. | Purger le tenant. |
| Délai d'exécution | 30 jours après réception. | 30 jours après réception. |

Source [D] : https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance (consultée le 2026-10-07).

Conséquences :

- Le délai « 10 jours ou 6 mois » est un délai d'**envoi** par Shopify. Les 30 jours d'exécution commencent à la **réception**.
- MarginPilot n'a pas à reproduire ce délai de grâce : il traite le webhook dès qu'il arrive.
- Le payload `customers/redact` contient `email` et `phone`. Comme tout payload (§9), il n'est **jamais** persisté ni journalisé. Seuls `customer.id` et `orders_to_redact` sont utilisés.
- `orders_to_redact` permet de retrouver les commandes concernées même si l'ID client n'a jamais été stocké.

### Topics volontairement non retenus

- `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `orders/edited` : leur effet est couvert par `orders/updated` suivi d'un refetch [NC], à confirmer en dev.
- `customers/*` : le scope `read_customers` est retenu (§16.1, D4), mais ces topics restent inutiles : l'ID client arrive avec la commande.
- `inventory_items/create` et `inventory_items/delete` : couverts par `products/*`.

### Déduplication

Source [D] : https://shopify.dev/docs/apps/build/webhooks/ignore-duplicates

- Les retries d'un même événement partagent le même `X-Shopify-Event-Id`, mais ont des `X-Shopify-Webhook-Id` différents.
- La doc recommande de dédupliquer sur `X-Shopify-Webhook-Id`.
- MarginPilot conserve les deux en-têtes.
- Le traitement étant un refetch idempotent, un doublon résiduel est sans effet.

---

## 12. Stratégie d'import initial

1. **Boutique** : requête `shop` (annexe A).
2. **Catalogue** : opération bulk (`bulkOperationRunQuery`) sur `products → variants → inventoryItem.unitCost`.
3. **Commandes** : opération bulk `orders(query: "created_at:>=<J-60>")`.
   - Imbrication : `lineItems`, `refunds` (liste), `refundLineItems`, `transactions` (liste).
   - Contrainte [D] : « Maximum of five total connections », sur deux niveaux d'imbrication au plus.
   - Si Shopify refuse cette forme : une passe bulk pour les commandes et leurs lignes, puis un refetch par commande pour les remboursements et les transactions.
4. **Limites bulk** [D] (https://shopify.dev/docs/api/usage/bulk-operations/queries) :
   - jusqu'à 5 opérations bulk simultanées par app et par boutique (depuis 2026-01) ;
   - résultat au format JSONL, URL valable une semaine ;
   - exécution limitée à 10 jours.
5. **Snapshots COGS** : après les commandes, création des snapshots « approximation historique » (§4.2, point 4), puis calcul.
6. **Curseur** : le curseur de synchronisation est initialisé à `max(Order.updatedAt)` des commandes importées.

### Repli sans bulk

Contraintes [D] (https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits) :

- une requête ne peut pas dépasser 1 000 points de coût ;
- le débit restauré va de 100 à 2 000 points/s selon le plan ;
- les opérations bulk échappent à ces limites.

La pagination est plafonnée à 25 000 objets [D] (https://shopify.dev/docs/api/usage/limits).

---

## 13. Stratégie de synchronisation

1. **Temps réel** : webhooks (§11), puis notification, job, refetch par GID (pipeline du §1.2).
2. **Réconciliation périodique** (fréquence à décider, par exemple toutes les heures) :
   - `orders(query: "updated_at:>='<curseur − marge>'", sortKey: UPDATED_AT)` ;
   - même principe pour `products` ;
   - la marge de recouvrement absorbe les décalages d'horloge et les webhooks perdus.
3. **Règle d'écriture** :
   - upsert seulement si l'`updatedAt` Shopify est supérieur ou égal à la valeur stockée ;
   - à chaque refetch de commande, les sous-collections (lignes, remboursements, transactions, allocations) sont **remplacées en bloc** dans une transaction DB.
4. **Recalcul** : toute écriture effective déclenche le recalcul du profit de la commande et des agrégats concernés (jour, produit, client).
5. **File de jobs** : pas de Redis en V1. La file vit dans PostgreSQL. Le choix d'implémentation se fera en PG-001 ou plus tard.
6. **Tokens** : le scaffold active `expiringOfflineAccessTokens: true`. Les jobs doivent donc gérer le rafraîchissement du token offline.

---

## 14. Idempotence

Chaque ressource est identifiée par son **GID Shopify**, conservé tel quel, par exemple `gid://shopify/Order/123…`.
Le `legacyResourceId` (`UnsignedInt64`) peut être conservé en plus pour le support, mais ce n'est jamais une clé.

Principe : `UNIQUE (shop_id, shopify_gid)` sur chaque table de ressource. Les contraintes ne sont pas créées en PG-000.

| Ressource | Identifiant Shopify | N | Clé MarginPilot proposée |
|---|---|---|---|
| Shop | `Shop.id` et `myshopifyDomain` | ! | `UNIQUE (shopify_gid)` et `UNIQUE (myshopify_domain)` |
| Product | `Product.id` | ! | `UNIQUE (shop_id, shopify_gid)` |
| Variant | `ProductVariant.id` | ! | `UNIQUE (shop_id, shopify_gid)` |
| InventoryItem | `InventoryItem.id` | ! | `UNIQUE (shop_id, shopify_gid)` |
| Order | `Order.id` | ! | `UNIQUE (shop_id, shopify_gid)` |
| Line item | `LineItem.id` | ! | `UNIQUE (shop_id, shopify_gid)` |
| Transaction | `OrderTransaction.id` | ! | `UNIQUE (shop_id, shopify_gid)` |
| Refund | `Refund.id` | ! | `UNIQUE (shop_id, shopify_gid)` |
| Refund line item | `RefundLineItem.id` | **nullable** [S] | GID si présent, sinon `(refund_id, line_item_id)` |
| Shipping line | `ShippingLine.id` | **nullable** [S] | GID si présent, sinon `(order_id, position)` |
| Discount allocation, tax line | aucun ID [S] | — | Enfants remplacés en bloc à chaque refetch (§13, point 3) |
| Webhook reçu | `X-Shopify-Webhook-Id`, `X-Shopify-Event-Id` | — | `UNIQUE (shop_id, webhook_id)` |

Les jobs sont idempotents par construction (refetch puis upsert) : rejouer un job ne crée aucun doublon.

---

## 15. Limitations connues

1. **Aucun COGS historique** dans Shopify : `LineItem.unitCost` n'existe pas [S]. L'historique antérieur à l'installation est donc approximatif.
2. **`unitCost` peut valoir `null`** : le profit est alors incomplet, jamais calculé avec un coût à 0.
3. **Coût transporteur réel** non exposé [S/NC].
4. **Frais de paiement** disponibles uniquement pour Shopify Payments [S][D]. Les autres passerelles sont estimées.
5. **Fenêtre de 60 jours** sans `read_all_orders` [D].
6. **Approbation niveau 1** obligatoire pour une app publique sur des boutiques réelles, y compris pour lire des commandes sans PII [D].
7. **Webhooks** non garantis et non ordonnés [D]. La réconciliation est obligatoire.
8. **Descriptions ambiguës dans le schéma** : `currentSubtotalPriceSet` et `totalShippingPriceSet` [S]. Leur sens réel est à valider sur des données.
9. **Champs réservés à Shopify Plus** : `OrderTransaction.shopifyPaymentsSet` et `authorizationExpiresAt` [S].
10. **Produit ou variante supprimés** : `LineItem.product` / `variant` valent `null` [S]. On garde le titre et le SKU de la ligne.
11. **Devise boutique modifiable** dans le temps : la devise est stockée avec chaque montant, sans conversion implicite.
12. **Permission « View product costs »** : effet possible sur la lecture de `unitCost` [S]. Impact sur le token offline [NC].
13. **ID client** : `Order.customer { id }` exige `read_customers` [T]. Ce scope est retenu au MVP (§16.1, D4).
14. **Taxes non testées** : la boutique de dev ne collectait aucune taxe. Les points liés à `taxesIncluded` restent [NC].

### Données que Shopify ne fournit pas directement

- COGS à la date de la commande.
- Coût réel du transporteur ou de l'étiquette.
- Frais des passerelles tierces.
- Frais de remboursement ou de litige hors Shopify Payments.
- Coûts d'emballage, de fulfillment externe et de main-d'œuvre.
- Dépenses publicitaires.
- CA « MarginPilot » normalisé, à reconstruire.
- Historique au-delà de 60 jours sans `read_all_orders`.

---

## 16. Décisions

### 16.1 Décisions figées pour PG-001

Ces décisions sont verrouillées. Les changer exige une révision explicite de PG-000.

**D1. CA MarginPilot**

- Le calcul principal se fait **en HT**.
- Le **CA produit** et la **livraison facturée** sont deux grandeurs séparées.
- **Revenu commercial total = CA produit HT + livraison facturée HT.**
- Les **taxes** sont toujours une grandeur séparée. Elles ne sont jamais un revenu.
- Les **droits**, **pourboires** et **frais additionnels** sont séparés du CA produit et du revenu commercial.
- Formules de référence : §3.2.

**D2. Date comptable**

- Vente : `Order.processedAt`.
- Mouvement financier, dont remboursement : `OrderTransaction.processedAt`, ou `OrderTransaction.createdAt` si `processedAt` vaut `null`.

**D3. Retours et COGS**

- `restockType = RETURN` ou `CANCEL` : le COGS de la quantité retournée est réintégré.
- `restockType = NO_RESTOCK` : le COGS est conservé.
- La règle est **déterministe** : elle dépend uniquement du `restockType` et de la quantité du `RefundLineItem`.
- Elle est **traçable** : chaque réintégration référence le `RefundLineItem` source et le snapshot COGS utilisé (§4.2).

**D4. Scopes MVP**

- Demandés : `read_orders,read_products,read_customers`.
- Non demandés : `read_inventory`, `read_shopify_payments_payouts`, tout `write_*`.
- `read_all_orders` reste prévu. Il sera déclaré uniquement après approbation Shopify (§10.2).

**D5. LTV**

- La LTV est conservée dans le MVP.
- Seule clé client : `Order.customer.id`.
- Aucune PII n'est sélectionnée dans les requêtes ni stockée.
- Les commandes guest (`customer = null`) sont exclues de la LTV client.
- Aucun rapprochement par email, nom, téléphone ou adresse.

**D6. Crédit en boutique**

- Une transaction `REFUND` / `SUCCESS` avec `gateway = "shopify_store_credit"` compte comme **remboursement économique**.
- Elle est explicitement distinguée d'un **remboursement cash** (toute autre passerelle).
- La passerelle est conservée sur chaque mouvement, pour permettre plus tard une analyse cash-flow séparée.

**D7. Règle générale de qualité**

- Une valeur inconnue n'est **jamais** égale à zéro.
- Toute donnée financière (COGS, frais, coût de livraison, etc.) garde son état de provenance :
  - `missing` : aucune valeur disponible ;
  - `estimated` : valeur issue d'une règle MarginPilot ;
  - `verified` : valeur lue chez Shopify ou saisie par le marchand.
- Un calcul qui dépend d'une valeur `missing` est marqué **incomplet**. Il n'est jamais complété par zéro.

**D8. Version d'API**

- Admin GraphQL `2026-10` partout : `shopify.server.ts` et `.graphqlrc.ts` (`ApiVersion.October26`), et TOML `[webhooks] api_version = "2026-10"`. Fait en PG-000B.

### 16.2 Points [NC] restants (non bloquants pour PG-001)

Ces points restent documentés dans leurs sections et dans l'annexe B. Ils ne bloquent pas PG-001. Le code de PG-001 doit les traiter de façon défensive, en appliquant D7.

- Taxes : `RefundLineItem.subtotalSet` avec `taxesIncluded = true`. Il faut activer la collecte FR sur la boutique de dev.
- Livraison payante : sens réel de `totalShippingPriceSet` et `currentSubtotalPriceSet`, et remboursement de livraison.
- Capture manuelle : `AUTHORIZATION` / `CAPTURE`.
- Transaction en échec, et comportement de `Refund.totalRefundedSet` dans ce cas.
- Statut final d'un REFUND Shopify Payments resté `PENDING`, et évolution de `REFUND_DISCREPANCY`.
- Refund sans transaction.
- Permission « View product costs » sur le token offline.
- Lecture de `Order.customer { id }` avec `read_customers` : attendue, pas encore re-testée.
- Limite de taille de `Order.transactions`, et coût réel de `ContractOrder` (`extensions.cost`).

### 16.3 Questions ouvertes (hors PG-001 ou à trancher pendant)

1. **Cartes cadeaux.** La vente d'une carte cadeau reste exclue du CA produit (§2.6). Le traitement d'un **paiement** par carte cadeau reste à préciser.
2. **Réconciliation.** Fréquence et marge de recouvrement.
3. **File de jobs.** Mécanisme sur PostgreSQL, sans Redis.
4. **Rétention et purge.** Politique exigée par le niveau 1. Délais Shopify documentés au §11. Délai interne d'exécution : au plus 30 jours.
5. **Calendrier des demandes à Shopify** : `read_all_orders` et accès aux données client protégées (niveau 1).

---

## Annexe A — Requêtes de contrat (validées contre le schéma 2026-10)

> **PG-000B** : `ContractOrder` échoue tel quel (`ACCESS_DENIED` sur `customer`) avec `read_orders,read_products`. Sans la ligne `customer { id }`, il réussit [T]. Avec `read_customers` (scopes MVP retenus), la requête complète devrait réussir. Ce point n'a pas encore été re-testé [NC].

Validation `graphql-js` sur le schéma 2026-10 : **8 requêtes sur 8 valides**.
Requêtes concernées : `shop`, `products`, `inventory_item`, `order`, `orders_incremental`, `customer`, `payments_fees`, et la mutation `bulkOperationRunQuery`.

### Requête de référence « commande complète »

```graphql
query ContractOrder($id: ID!) {
  order(id: $id) {
    id legacyResourceId name number test
    createdAt updatedAt processedAt cancelledAt cancelReason closedAt
    currencyCode presentmentCurrencyCode taxesIncluded dutiesIncluded edited
    displayFinancialStatus displayFulfillmentStatus
    customer { id }
    subtotalPriceSet { ...Bag } currentSubtotalPriceSet { ...Bag }
    totalPriceSet { ...Bag } currentTotalPriceSet { ...Bag } originalTotalPriceSet { ...Bag }
    totalDiscountsSet { ...Bag } currentTotalDiscountsSet { ...Bag } cartDiscountAmountSet { ...Bag }
    totalShippingPriceSet { ...Bag } currentShippingPriceSet { ...Bag }
    totalTaxSet { ...Bag } currentTotalTaxSet { ...Bag }
    originalTotalDutiesSet { ...Bag } currentTotalDutiesSet { ...Bag }
    originalTotalAdditionalFeesSet { ...Bag } currentTotalAdditionalFeesSet { ...Bag }
    totalTipReceivedSet { ...Bag } totalReceivedSet { ...Bag } netPaymentSet { ...Bag }
    totalRefundedSet { ...Bag } totalRefundedShippingSet { ...Bag } totalOutstandingSet { ...Bag }
    paymentGatewayNames
    shippingLines(first: 20, includeRemovals: true) {
      nodes {
        id title code source carrierIdentifier isRemoved
        originalPriceSet { ...Bag } discountedPriceSet { ...Bag } currentDiscountedPriceSet { ...Bag }
        taxLines { title rate priceSet { ...Bag } }
      }
    }
    lineItems(first: 250) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title variantTitle name sku vendor isGiftCard requiresShipping taxable
        quantity currentQuantity refundableQuantity
        product { id } variant { id inventoryItem { id } }
        originalUnitPriceSet { ...Bag } discountedUnitPriceSet { ...Bag } discountedUnitPriceAfterAllDiscountsSet { ...Bag }
        originalTotalSet { ...Bag } discountedTotalSet { ...Bag } totalDiscountSet { ...Bag }
        discountAllocations { allocatedAmountSet { ...Bag } discountApplication { targetType allocationMethod } }
        taxLines { title rate channelLiable priceSet { ...Bag } }
        duties { id price { ...Bag } }
      }
    }
    transactions(first: 100) {
      id kind status gateway formattedGateway test errorCode
      processedAt createdAt paymentId
      amountSet { ...Bag } settlementCurrency settlementCurrencyRate
      parentTransaction { id kind }
      fees { id type amount { amount currencyCode } flatFee { amount currencyCode } rate taxAmount { amount currencyCode } }
    }
    refunds(first: 50) {
      id createdAt updatedAt
      totalRefundedSet { ...Bag }
      refundLineItems(first: 250) {
        nodes { id quantity restockType restocked lineItem { id } priceSet { ...Bag } subtotalSet { ...Bag } totalTaxSet { ...Bag } }
      }
      refundShippingLines(first: 20) { nodes { id subtotalAmountSet { ...Bag } taxAmountSet { ...Bag } } }
      duties { amountSet { ...Bag } originalDuty { id } }
      orderAdjustments(first: 20) { nodes { id reason amountSet { ...Bag } taxAmountSet { ...Bag } } }
      transactions(first: 20) { nodes { id kind status gateway processedAt amountSet { ...Bag } parentTransaction { id } } }
    }
  }
}
fragment Bag on MoneyBag { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
```

Le **coût calculé** de cette requête, avec lignes et remboursements imbriqués, peut approcher la limite de 1 000 points.
Le coût réel est à mesurer en dev via `extensions.cost`. Si nécessaire, paginer `lineItems` et `refundLineItems` séparément.

### Requête catalogue et COGS courant

```graphql
query ContractProducts($cursor: String, $query: String) {
  products(first: 100, after: $cursor, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId title status createdAt updatedAt
      variants(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id legacyResourceId title sku price createdAt updatedAt
          inventoryItem { id updatedAt unitCost { amount currencyCode } }
        }
      }
    }
  }
}
```

---

## Annexe B — PG-000B : validation sur boutique de développement

### Contexte

| | |
|---|---|
| Date | 2026-10-07 (UTC) |
| Boutique | `marginpilot-dev-cflxugvw.myshopify.com` : dev store, plan Basic, pays FR, devise EUR, `taxesIncluded = true`, données de démo |
| API | Admin GraphQL `2026-10` (`ApiVersion.October26`, TOML `api_version = "2026-10"`) |
| Scopes accordés | `read_orders,read_products` uniquement, vérifiés par `currentAppInstallation.accessScopes`. Aucun write scope. |
| Exécution | `shopify app dev`, puis `shopify app execute --version 2026-10` : token de l'app, avec ses scopes. |
| Données de test | Créées par le marchand dans l'admin et au checkout. Aucune mutation de l'app. |
| Paiement | Shopify Payments disponible en mode test sur la boutique de dev (gateway `shopify_payments`, `test = true`). |

### Résultats

| Test | Résultat | Détail |
|---|---|---|
| A. `ProductVariant.inventoryItem.unitCost` avec `read_products` | **Réussi** | Avant saisie : `unitCost = null` sur toutes les variantes de démo, sans erreur d'accès. Après saisie de 400 € : `{ amount: "400.0", currencyCode: "EUR" }`. `inventoryItem(id:)` et `inventoryItems` fonctionnent aussi sans `read_inventory`. |
| B. `Order.customer { id }` avec `read_orders` | **Échec, attendu** : scope manquant | `ACCESS_DENIED` : « Access denied for customer field. Required access: `read_customers` access scope. » L'erreur fait échouer toute la requête. Aucun champ alternatif sur `Order`. |
| C. Commande et champs financiers | **Réussi** (requête `ContractOrder` sans `customer`) | Commande `#1001` : 3 × The Minimal Snowboard à 885.95. `subtotal = total = totalReceived = 2657.85`. Remises 0, taxes 0, livraison 0, `test = true`, `processedAt` 2 s avant `createdAt`. Valeurs `0.0` (pas `null`) pour les champs non utilisés ; `cartDiscountAmountSet`, duties et additional fees valent `null`. |
| D. Refund | **Réussi** | Deux remboursements de 1 unité chacun, avec remise en stock. Le premier (15:58:52) part vers la carte Shopify Payments, le second (16:06:23) en crédit en boutique. **Premier refund** : `RefundLineItem` : `quantity 1`, `restockType CANCEL`, `restocked true`, `priceSet = subtotalSet = 885.95`, `totalTaxSet 0.0`, `id` présent. `refundShippingLines` vide. `Refund.totalRefundedSet = 0.0` (transaction PENDING). `orderAdjustments` : `REFUND_DISCREPANCY 885.95`. Côté commande : `currentQuantity 2`, `currentSubtotalPriceSet = currentTotalPriceSet = 1771.9`, mais `totalRefundedSet 0.0`, `netPaymentSet 2657.85`, `displayFinancialStatus PAID`. **Second refund** : transaction `REFUND / SUCCESS / shopify_store_credit`, `totalRefundedSet 885.95`, aucun `orderAdjustment`. **Commande après les deux** : `currentQuantity 1`, `currentSubtotalPriceSet = currentTotalPriceSet = 885.95`, `totalRefundedSet 885.95` (crédit seul), `netPaymentSet 1771.9`, `PARTIALLY_REFUNDED`. |
| E. Transactions | **Partiel** | Observés : `SALE / SUCCESS` (parent `null`), `REFUND / PENDING` vers la carte (parent : la `SALE`, toujours PENDING à 16:06), `REFUND / SUCCESS` en crédit en boutique (parent `null`). Toutes en `test = true`. `AUTHORIZATION` / `CAPTURE` non testés : la commande en capture manuelle n'a pas été créée. |
| F. Shipping | **Non concluant** | Livraison gratuite (« Standard ») : tous les champs valent `0.0`. Aucune différence observable entre `shippingLines`, `totalShippingPriceSet` et `currentShippingPriceSet`. |
| G. Payment fees | **Réussi** | Shopify Payments disponible. `fees` rempli immédiatement sur la `SALE` : `processing_fee` 72.01 = 2.7 % + 0.25, `rateName international_card_not_present`. `fees = []` sur le `REFUND`. |
| H. Webhook `inventory_items/update` | **Réussi** | Une livraison après modification du coût dans l'admin, avec `read_products` seul. Payload : `admin_graphql_api_id` = l'InventoryItem modifié, `cost = "400.00"`. `X-Shopify-Event-Id` présent. |

### Observations annexes

- Au démarrage, `shopify app dev` a envoyé lui-même un webhook `APP_UNINSTALLED` à l'app locale (« Sending APP_UNINSTALLED webhook to app server »). Le handler doit donc supporter un uninstall suivi d'une réinstallation.
- `Order.updatedAt` change à chaque création de Refund (15:58:52, puis 16:06:23).
