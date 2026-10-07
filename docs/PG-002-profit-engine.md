# PG-002 — Profit Engine V1

| | |
|---|---|
| Date | 2026-10-07 |
| Code | `app/domain/profit-engine/` |
| Fonction | `calculateOrderProfit(input, config)` |
| Version | `PROFIT_ENGINE_VERSION = 1`, exposée dans `result.calculationVersion` |
| Tests | `npm test` (`node:test`, Node ≥ 22.18, TypeScript exécuté directement) |
| Références | PG-000 (décisions D1–D7), PG-001 (modèle de données) |

## 1. Objectif

Répondre à « combien cette commande me rapporte-t-elle réellement ? » à partir d'un objet **déjà normalisé**.

Le moteur est une fonction **pure** :
- aucune lecture Shopify, Prisma ou PostgreSQL, aucun réseau ;
- pas d'horloge, pas d'aléatoire, aucun état global, aucune mutation de l'input ;
- même entrée, même sortie.

Il ne connaît aucun concept Shopify. Un futur normalizer construira l'input à partir des données PG-001.

## 2. Arithmétique

- `Prisma.Decimal`, l'API publique de `@prisma/client` (decimal.js embarqué). Aucune dépendance ajoutée, aucun `PrismaClient`.
- Le moteur calcule avec un clone dédié : **50 chiffres significatifs**, `ROUND_HALF_EVEN`.
  - Additions, soustractions et multiplications de montants `DECIMAL(20,6)` : **exactes**.
  - Le `Decimal` par défaut (20 chiffres) arrondirait par exemple 99 999 999 999 999,999999 × 2. Il n'est jamais utilisé pour calculer.
  - Seules les divisions (marge, ROAS) peuvent ne pas se terminer. Elles sont coupées à 50 chiffres significatifs : c'est le seul arrondi, documenté et testé.
- Aucun `number`, `parseFloat`, `Math.*`, `toFixed` pour l'argent. Un `number` passé comme montant est **rejeté**.
- Aucun arrondi intermédiaire, aucun arrondi ni formatage des sorties. Le formatage appartient à l'UI.

## 3. Input — `OrderProfitInput`

Une seule devise par exécution, aucune conversion FX. Tous les montants sont HT, en `Decimal`.

| Champ | Type | Sens |
|---|---|---|
| `currency` | `string` non vide | Devise de tous les montants. Jamais supposée. |
| `productRevenueExTax` | `Decimal ≥ 0` | Revenu produit HT après remises (D1). |
| `shippingRevenueExTax` | `Decimal ≥ 0` | Livraison **facturée** au client, HT. |
| `economicRefundsExTax` | `Decimal ≥ 0` | Remboursements économiques **SUCCESS**, HT. Crédit en boutique inclus (D6), jamais de `PENDING`. |
| `cogs` | `FinancialValue` | COGS **net** après retours (D3 appliqué par le normalizer). |
| `shippingCost` | `FinancialValue` | Coût de livraison **réel** du marchand. |
| `paymentFees` | `FinancialValue` | Frais de paiement, quelle que soit leur source. |
| `adCost` | `FinancialValue` | Coût d'acquisition attribué à la commande. |
| `otherCosts` | `FinancialValue` | Total normalisé des autres coûts. |

`shippingRevenueExTax` et `shippingCost` sont indépendants : aucun ne sert de repli à l'autre.

### `FinancialValue` (D7)

```ts
| { status: "verified";  amount: Decimal }
| { status: "estimated"; amount: Decimal }
| { status: "missing";   amount: null }
```

`{ status: "verified", amount: 0 }` est un coût connu de zéro. `missing` est un coût inconnu : il n'est **jamais** traité comme 0.

### `ProfitEngineConfig`

| Champ | Règle |
|---|---|
| `lowMarginThresholdPercent` | `Decimal` fini, entre 0 et 100 inclus. Aucun seuil par défaut dans le code. |

## 4. Formules

```
grossCommercialRevenue  = productRevenueExTax + shippingRevenueExTax
netRevenue              = grossCommercialRevenue − economicRefundsExTax
operatingCostsBeforeAds = cogs + shippingCost + paymentFees + otherCosts
profitBeforeAds         = netRevenue − operatingCostsBeforeAds
maxProfitableCpa        = max(0, profitBeforeAds)
breakEvenRoas           = netRevenue / maxProfitableCpa      si maxProfitableCpa > 0, sinon null
profit                  = profitBeforeAds − adCost
marginPercent           = profit × 100 / netRevenue          si netRevenue > 0, sinon null
```

- La marge est calculée en `profit × 100 / netRevenue`, avec une seule division. C'est mathématiquement identique à `profit / netRevenue × 100`.
- Taxes, droits, pourboires et frais additionnels ne sont jamais dans le revenu (D1). Ils ne font pas partie de l'input.

## 5. Qualité et calculs partiels

Chaque métrique a une qualité `verified | estimated | unavailable` (`result.quality`). Une métrique `unavailable` vaut `null`.

| Métrique | Dépend de |
|---|---|
| `grossCommercialRevenue`, `netRevenue` | Revenus uniquement : toujours `verified`. |
| `operatingCostsBeforeAds`, `profitBeforeAds`, `maxProfitableCpa` | `cogs`, `shippingCost`, `paymentFees`, `otherCosts`. |
| `breakEvenRoas` | Idem, et `unavailable` si `maxProfitableCpa = 0`. |
| `profit` | Les 5 coûts. |
| `marginPercent` | Les 5 coûts, et `unavailable` si `netRevenue ≤ 0`. |

Règle de combinaison :
- une dépendance `missing` donne `unavailable` ;
- sinon, une dépendance `estimated` donne `estimated` ;
- sinon `verified`.

Conséquences :
- `adCost` manquant : `profitBeforeAds`, CPA max et ROAS break-even restent **calculés**, et seuls `profit` et la marge sont `null`. Le manque de coût publicitaire n'empêche pas de connaître la capacité d'acquisition.
- `cogs` (ou un autre coût avant publicité) manquant : seuls les revenus sont calculés.

### `completeness` (global, sur les 5 coûts)

| Valeur | Condition |
|---|---|
| `complete` | Tous les coûts sont connus et `verified`. |
| `estimated` | Tous sont connus, au moins un est `estimated`. Ce n'est **pas** `incomplete`. |
| `incomplete` | Au moins un coût est `missing`. |

## 6. CPA max et ROAS break-even

- `maxProfitableCpa = max(0, profitBeforeAds)` : dépense publicitaire maximale avant un profit nul.
  - 35 donne 35 ; 0 donne 0 ; −5 donne 0.
- `breakEvenRoas = netRevenue / maxProfitableCpa`, uniquement si le CPA max est strictement positif.
  - Si `profitBeforeAds ≤ 0`, la commande est non rentable avant publicité : `null`, jamais `Infinity`.

## 7. États de rentabilité

Ordre d'évaluation :

1. `profit` indisponible : `INCOMPLETE`.
2. `profit < 0` : `LOSS`.
3. `profit = 0` : `LOW_MARGIN`, **quel que soit le seuil**, même 0.
4. `marginPercent < seuil` : `LOW_MARGIN`. Une marge **égale** au seuil n'est pas basse.
5. Sinon : `PROFITABLE`.

Un profit positif implique `netRevenue > 0` (les coûts sont ≥ 0) : la marge est alors toujours disponible.

## 8. Cas limites

| Cas | Comportement |
|---|---|
| `netRevenue = 0` | Marge `null`, aucune division par zéro. |
| Remboursement supérieur au revenu | `netRevenue` négatif. Les coûts connus restent calculés, la marge et le ROAS sont `null`, l'état est `LOSS` si le profit est connu et négatif. |
| `profitBeforeAds ≤ 0` | CPA max = 0, ROAS `null`. |
| NaN / Infinity | Impossibles en sortie : aucune division par une valeur ≤ 0. NaN et Infinity sont rejetés en entrée. |

## 9. Validation (`ProfitEngineInputError`, avec `code` et `field`)

Le moteur rejette ces inputs, sans jamais les corriger (ni `abs`, ni `max(0, …)`, ni repli à 0) :

| Code | Cas |
|---|---|
| `INVALID_CURRENCY` | Devise vide ou faite uniquement d'espaces. |
| `INVALID_DECIMAL` | Montant qui n'est pas un `Decimal` (par exemple un `number`), ou NaN / Infinity. |
| `NEGATIVE_AMOUNT` | Revenu, remboursement ou coût négatif. |
| `INVALID_FINANCIAL_VALUE` | `missing` avec un montant, `verified` / `estimated` sans montant, statut inconnu. |
| `INVALID_CONFIG` | Seuil absent, non fini, < 0 ou > 100. |

## 10. Tests

`app/domain/profit-engine/__tests__/calculate-order-profit.test.ts`, 48 tests :
- le cas de référence de la spécification ;
- les 35 cas obligatoires ;
- des contrôles supplémentaires : statut inconnu, `number` rejeté, non-mutation de l'input, estimated + missing.

Lancement : `npm test`. Ce script exécute `node --test "app/**/*.test.ts"`.

Choix techniques :
- `node:test` est intégré à Node, donc aucune dépendance n'est ajoutée.
- Node 22.18+ exécute directement le TypeScript : les imports internes du moteur finissent donc par `.ts`.
- `tsconfig.json` déclare `allowImportingTsExtensions`, autorisé car le projet est en `noEmit`.

## 11. Hors scope

- Normalizer Shopify vers `OrderProfitInput` : calcul HT, application de D3 aux retours, sélection des remboursements SUCCESS.
- `ProfitSnapshot` et toute persistance des résultats.
- Simulateur, LTV, agrégats par période, produit ou client.
- Règles de coûts (frais tiers estimés, coût transporteur), dépenses publicitaires et API Ads.
- Distinction cash / crédit en boutique pour une analyse de trésorerie.
- Conversion FX.
