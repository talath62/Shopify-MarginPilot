# PG-001 — Modèle de données MarginPilot (PostgreSQL / Prisma)

| | |
|---|---|
| Date | 2026-10-07 |
| Source de vérité | `docs/PG-000-shopify-data-contract.md` (figé, décisions D1–D8 au §16.1) |
| Schéma | `prisma/schema.prisma` |
| Migrations | `prisma/migrations/20261007162458_pg_001_core_shopify_data_model`, puis `20261007170000_pg_001_tenant_safe_optional_fks` (FK optionnelles composites, `UNIQUE (orderLineId)`) |
| Périmètre | Persistance des **inputs** Shopify et du snapshot COGS. Aucun calcul, aucun import, aucun job. |

## 1. Relations principales

```
Shop ─┬─ Product ──< ProductVariant >── InventoryItem         (catalogue, coût COURANT)
      │                    ┊ (lien optionnel, NoAction)
      └─ Order ─┬─< OrderLine ─┬─< OrderLineDiscountAllocation
                │              ├─< OrderLineTax
                │              ├── OrderLineCostSnapshot      (coût HISTORIQUE, 1 par ligne)
                │              └─< RefundLine
                ├─< ShippingLine ──< ShippingLineTax           (livraison FACTURÉE)
                ├─< OrderTransaction ─┬─< TransactionFee      (frais Shopify Payments vérifiés)
                │        │  ↺ parent  │
                │        └─ refundId? ┘
                └─< Refund ─┬─< RefundLine >── OrderLine
                            ├─< RefundShippingLine
                            ├─< RefundOrderAdjustment
                            └─< OrderTransaction (via refundId)
```

`─<` : un-à-plusieurs. `┊` : FK optionnelle vers le catalogue.

`Session` (scaffold Shopify) est inchangée et n'a pas de FK vers `Shop`. Le lien se fait par `Session.shop = Shop.myshopifyDomain`.

## 2. Modèles

| Modèle | Rôle | Identité Shopify |
|---|---|---|
| `Shop` | Tenant métier. Aucun credential : les tokens restent dans `Session`. | `shopifyGid` UNIQUE, `myshopifyDomain` UNIQUE |
| `Product` | Catalogue courant. | `(shopId, shopifyGid)` |
| `ProductVariant` | Variante courante, prix courant. | `(shopId, shopifyGid)` |
| `InventoryItem` | Porte `unitCost` **courant**. | `(shopId, shopifyGid)` |
| `Order` | En-tête de commande. Contient aussi les montants hors CA (D1 : pourboires, droits, frais additionnels) et les totaux Shopify de contrôle (§3.1). | `(shopId, shopifyGid)` |
| `OrderLine` | Ligne historique, avec les GID produit et variante copiés. | `(shopId, shopifyGid)` |
| `OrderLineDiscountAllocation` | Allocations de remise, source de vérité des remises. | aucune : `(orderLineId, position)` |
| `OrderLineTax` | Taxes de ligne. Le montant fait foi, `rate` est informatif. | aucune : `(orderLineId, position)` |
| `ShippingLine` | Livraison **facturée** au client. | `(shopId, shopifyGid)` si présent, sinon `(orderId, position)` |
| `ShippingLineTax` | Taxes de livraison (§3.2 « Taxes collectées »). | aucune : `(shippingLineId, position)` |
| `OrderTransaction` | Mouvements d'argent : `kind`, `status`, `gateway`, parent, et lien `refundId`. | `(shopId, shopifyGid)` |
| `TransactionFee` | Frais Shopify Payments **vérifiés** uniquement. | aucune : `(transactionId, position)` |
| `Refund` | Remboursement : quantités et contrôle. **Pas** un mouvement d'argent. | `(shopId, shopifyGid)` |
| `RefundLine` | Lignes remboursées, avec `restockType`. | `(shopId, shopifyGid)` si présent, sinon `(refundId, position)` |
| `RefundShippingLine` | Livraison remboursée (§3.2). | aucune : `(refundId, position)` |
| `RefundOrderAdjustment` | Ajustements, dont `REFUND_DISCREPANCY`. Jamais du cash. | aucune : `(refundId, position)` |
| `OrderLineCostSnapshot` | COGS historique d'une ligne, figé à la première ingestion. | une ligne par `OrderLine` |

## 3. Identité Shopify

- PK interne : `UUID`, `DEFAULT gen_random_uuid()`. Fonctionne aussi pour des inserts SQL bruts.
- Les GID Shopify sont stockés **tels quels** (`gid://shopify/Order/…`) en `TEXT`. Ils ne servent jamais de PK.
- Unicité Shopify toujours **par shop** : `UNIQUE (shopId, shopifyGid)`. Le même GID sur deux shops est accepté (testé).
- GID nullable (`ShippingLine`, `RefundLine`) : PostgreSQL accepte plusieurs `NULL` dans `UNIQUE (shopId, shopifyGid)`. L'identité de repli est `(parentId, position)`, toujours unique.
- `RefundLine` n'a **pas** de contrainte `UNIQUE (refundId, orderLineId)`. Une même ligne peut apparaître dans plusieurs remboursements, et éventuellement deux fois dans un même remboursement (par exemple une remise en stock répartie). Le repli `(refundId, position)` n'interdit aucun cas légitime. C'est un écart volontaire par rapport à la suggestion du PG-000 §14.
- Les enfants sans ID Shopify (allocations, taxes, frais, lignes de livraison remboursées, ajustements) sont **remplacés en bloc** à chaque refetch, avec une `position` égale à l'index dans la liste Shopify.
- Les ressources qui ont un GID stable (`OrderLine`, `OrderTransaction`, `Refund`) sont **upsertées par GID**, jamais supprimées puis recréées. Sinon, la cascade détruirait le snapshot COGS de la ligne. Cela précise le §13, point 3 de PG-000.

## 4. Multi-tenant

- Chaque table porte `shopId` (FK vers `Shop`, `ON DELETE CASCADE`).
- **Toutes** les relations entre ressources d'un shop sont des FK **composites** `(shopId, xId)` vers `(shopId, id)`, d'où un `UNIQUE (shopId, id)` sur chaque table référencée. L'isolation est garantie par PostgreSQL, pas par le code d'ingestion.
- Cela vaut aussi pour les relations **optionnelles** :
  - `OrderLine (shopId, productId)` vers `Product (shopId, id)` ;
  - `OrderLine (shopId, variantId)` vers `ProductVariant (shopId, id)` ;
  - `OrderTransaction (shopId, refundId)` vers `Refund (shopId, id)` ;
  - `OrderTransaction (shopId, parentTransactionId)` vers `OrderTransaction (shopId, id)`.
- `shopId` reste `NOT NULL`. Quand l'id optionnel vaut `NULL`, la FK n'est pas vérifiée (`MATCH SIMPLE`, comportement par défaut de PostgreSQL) : le lien absent reste accepté.
- Testé : une ligne ou une transaction du shop A qui pointe vers un produit, une variante, un remboursement ou une transaction du shop B est refusée.

## 5. Argent et devises

- Montants : `DECIMAL(20,6)`, soit 14 chiffres entiers (jusqu'à 99 000 milliards) et 6 décimales. Toutes les devises ISO 4217 ont au plus 4 décimales, et Shopify envoie des montants dans la précision de la devise.
- Taux (`settlementCurrencyRate`, `TransactionFee.rate`, `*Tax.rate`) : `DECIMAL(30,15)`.
- **Aucun `Float` / `REAL` / `DOUBLE`** (vérifié dans `information_schema`). `TaxLine.rate`, un `Float` chez Shopify, est converti en Decimal et reste informatif.
- Pas d'arrondi applicatif. PostgreSQL arrondirait au-delà de 6 décimales : l'ingestion doit **rejeter** un montant de plus de 6 décimales plutôt que le tronquer.
- Toujours `shopMoney`. `presentmentMoney` n'est pas persisté (informatif, PG-000 §3.1), seul `Order.presentmentCurrencyCode` est conservé.
- Une colonne de devise par ligne (`currencyCode`) s'applique à tous les montants de la ligne. Pour `Order`, c'est la devise boutique **au moment de la commande**. La devise courante de `Shop` n'est jamais supposée.
- `ProductVariant.priceCurrencyCode` et `InventoryItem.unitCostCurrencyCode` sont explicites.
- La valeur `NUMERIC` est restituée avec son échelle (`2657.850000`). Les comparaisons se font en Decimal.

## 6. Valeur inconnue (D7)

- Aucun `@default(0)` sur une colonne financière.
- `InventoryItem.unitCost` est `NULL` quand le coût est inconnu. `CHECK` : coût `NULL` ⇔ devise `NULL`.
- `OrderLineCostSnapshot` : `CHECK (source = 'MISSING') = (unitCost IS NULL)` et coût `NULL` ⇔ devise `NULL`.
  - Un coût 0 en `MISSING` est rejeté, tout comme `SHOPIFY_UNIT_COST` sans coût (testé).
- Provenance : `SHOPIFY_UNIT_COST` et `MANUAL` valent `verified` ; `ESTIMATED` vaut `estimated` ; `MISSING` vaut `missing`.
- Les `CHECK` sont écrites à la main dans la migration (Prisma ne les modélise pas). `prisma migrate diff` ne détecte aucune dérive.

## 7. Historique COGS

- `InventoryItem.unitCost` est le coût **courant**, mis à jour par `inventory_items/update`.
- `OrderLineCostSnapshot` est le coût **historique** de référence, un seul par ligne : `UNIQUE (orderLineId)`. La FK vers `OrderLine` reste composite `(shopId, orderLineId)`. Prisma exige aussi `UNIQUE (shopId, orderLineId)` pour une relation un-à-un sur une FK composite ; cet index est conservé, la règle métier est `UNIQUE (orderLineId)`. Il est créé à la première ingestion de la ligne. Il n'a **aucune FK** vers `InventoryItem` : il garde `inventoryItemShopifyGid`, donc il survit au catalogue.
- Aucune mise à jour du snapshot à partir de `InventoryItem` (règle applicative, testée au niveau données).
- `historicalApproximation = true` pour l'import initial (coût actuel appliqué à une commande passée).
- Traçabilité future des corrections manuelles : à ajouter **sans migration destructrice** (colonnes nullables ou table d'historique séparée).

## 8. Soft delete et cascades

| Suppression | Effet |
|---|---|
| `Shop` (purge `shop/redact`) | `CASCADE` vers toutes les tables. Les FK catalogue `NO ACTION` sont vérifiées en fin d'instruction : la purge passe (testé). L'autre shop n'est pas touché. |
| `Order` (base MarginPilot) | `CASCADE` vers lignes, livraison, transactions, remboursements et snapshots. `orders/delete` passe par `Order.deletedAt`, pas par un `DELETE`. |
| `Product` / `ProductVariant` référencés par une `OrderLine` | **Refusé** (`NO ACTION`, testé). On utilise `deletedAt`. L'historique (`OrderLine`, snapshot) reste intact. |
| `Product` non référencé | `CASCADE` vers ses variantes. |
| `InventoryItem` référencé par une variante | Refusé (`NO ACTION`). |
| `Refund` référencé par une transaction | **Refusé** (`NO ACTION`). La transaction (argent) ne peut pas perdre son Refund. Un Refund ne disparaît qu'avec sa commande ou son shop : tout est supprimé dans la même instruction (testé). |
| Transaction parente référencée | **Refusé** (`NO ACTION`), même logique. |

## 9. Index retenus

- `UNIQUE (shopId, shopifyGid)` sur chaque ressource Shopify : upsert, et préfixe `shopId` pour les accès par shop. Aucun index `shopId` seul n'est ajouté.
- `UNIQUE (shopId, id)` : cible obligatoire des FK composites.
- `Shop.myshopifyDomain` / `shopifyGid` : `UNIQUE`, pas d'index séparé.
- `Product (shopId, shopifyUpdatedAt)` et `Order (shopId, shopifyUpdatedAt)` : réconciliation incrémentale (§13).
- `Order (shopId, processedAt)` : rapports par période (D2).
- `Order (shopId, customerShopifyGid)` : LTV future (D5).
- `OrderLine (orderId)`, `OrderTransaction (orderId)`, `Refund (orderId)` : chargement d'une commande et cascades.
- `OrderLine (variantId)` et `OrderLine (productId)` : lignes par produit, et vérification `NO ACTION` sans parcours complet de la table.
- `ProductVariant (productId)`, `ProductVariant (inventoryItemId)` : cascade et propagation du coût courant.
- `OrderTransaction (refundId)`, `(parentTransactionId)` : transactions d'un Refund, et vérification `NO ACTION` sans parcours complet de la table.
- `ProductVariant (shopId, id)`, `UNIQUE`, ajouté comme cible de la FK composite `OrderLine (shopId, variantId)`.
- `RefundLine (orderLineId)` : quantités retournées par ligne (D3).
- Enfants `(parentId, position)` : `UNIQUE`, qui sert aussi d'index de jointure.

## 10. Données personnelles

- Aucune PII client : seul `Order.customerShopifyGid` est conservé.
- Non stockés : `Refund.note` (texte libre), adresses, email, téléphone, IP, `receiptJson`, `paymentId`.
- `Session` (scaffold) contient `firstName` / `lastName` / `email` du **membre du staff** pour les sessions online. Ce sont des données de l'utilisateur marchand, pas du client. Le modèle n'a pas été modifié.

## 11. Volontairement non persisté ou reporté

| Élément | Raison |
|---|---|
| `presentmentMoney` | Informatif (§3.1). Calculs en `shopMoney`. |
| `currentSubtotalPriceSet`, `totalShippingPriceSet` | Sens ambigu, « ne pas utiliser » (§3.1, [NC]). |
| `discountedUnitPriceAfterAllDiscountsSet`, `totalDiscountSet` de ligne | Affichage ou incomplet (§2.6). |
| `LineItem.duties[]`, `Refund.duties[]` | D1 isole les droits : les totaux de commande `original/currentTotalDuties` suffisent au MVP. Détail par ligne reporté. |
| `discountApplication` (targetType, allocationMethod) | Non requis par les formules du §3.2. |
| `ShippingLineDiscountAllocation` | `discountedPriceSet` est déjà net des remises (§3.2). |
| `paymentGatewayNames`, `paymentId`, `receiptJson` | Informatif, ou interdit (§8). |
| `OrderShippingCost` (coût réel transporteur) | Reporté. Aucun producteur n'existe encore (saisie, import, règles). Sa forme (par commande, par envoi, référence d'import) dépend de la tâche coûts. Absence de ligne = `missing` (D7). |
| `WebhookEvent`, Job | Reportés à la tâche webhook / file. Aucune structure existante ne l'exige. |
| `ProfitSnapshot`, coûts externes, Ads | Hors PG-001. |
| Table `Customer` | Interdite (D5). |
