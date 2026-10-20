# PG-010 — Webhooks Shopify V1

| | |
|---|---|
| Date | 2026-10-20 |
| Route | `app/routes/webhooks.marginpilot.tsx` (`POST /webhooks/marginpilot`) |
| Service | `app/services/shopify-webhook-dispatch.server.ts` |
| Tests | `app/services/__tests__/shopify-webhook-dispatch.test.ts`, `shopify-webhook-route.test.ts` |

## Objectif

Recevoir les événements Shopify de commandes et de catalogue, les vérifier, puis créer un job PG-009.

Aucune synchronisation n'a lieu dans la requête HTTP : c'est PG-011 qui exécutera les jobs. PG-005 à PG-008 ne sont pas modifiés.

## Topics (Admin API 2026-10, aucun scope ajouté)

| Topic | Scope | Job |
|---|---|---|
| `orders/create`, `orders/updated` | `read_orders` | `ORDER_SYNC` `{ orderGid: payload.admin_graphql_api_id }` |
| `refunds/create` | `read_orders` | `ORDER_SYNC` sur la **commande parente** `gid://shopify/Order/<order_id>` |
| `products/create`, `products/update`, `products/delete` | `read_products` | `CATALOG_SYNC` `{}` |
| `inventory_items/update` | `read_products` (validé en PG-000B) | `CATALOG_SYNC` `{}` |

Les topics sont déclarés dans `shopify.app.toml` : une seule subscription vers `/webhooks/marginpilot`, et chaque topic n'y apparaît qu'une fois. Ce choix a été validé avec `shopify app config validate`.

- `app/uninstalled` et `app/scopes_update` restent inchangés, avec leurs routes.
- La subscription temporaire PG-000B (`/webhooks/inventory_items/update`) et sa route de test sont remplacées.
- Aucun webhook de conformité n'est configuré pour l'instant ; ce point est hors scope.
- Les topics de commandes portent sur des données client protégées. En boutique de développement, aucune démarche n'est nécessaire. Pour une boutique réelle, il faudra l'approbation niveau 1 (PG-000 §9).

Payloads réels 2026-10, vérifiés avec `shopify app webhook trigger` :
- `refunds/create` contient `order_id` (un nombre). Son `admin_graphql_api_id` est le GID du **remboursement**, pas celui de la commande.
- `orders/*` contient `admin_graphql_api_id` = GID de la commande.
- `products/delete` ne contient que `id`.

## Authentification

- Seul `authenticate.webhook(request)` du SDK officiel est utilisé : aucune vérification HMAC maison, et le body n'est jamais lu avant cette vérification.
- Une signature invalide est rejetée par le SDK avec une réponse 4xx, sans job.
- La boutique est identifiée par le `shop` (domaine) renvoyé par le SDK, retrouvé dans `Shop.myshopifyDomain`. Un `shopId` présent dans le payload n'est **jamais** utilisé.
- Aucune session navigateur n'est nécessaire. La présence de la session offline sert seulement à savoir si l'app est encore installée.

## Mapping et dedupeKey

| Type | dedupeKey | Effet |
|---|---|---|
| `ORDER_SYNC` | `orderGid` | Les trois topics de commande partagent la même clé : plusieurs événements sur une même commande donnent un seul job `PENDING`. |
| `CATALOG_SYNC` | `catalog:full` | Une rafale d'événements catalogue donne une seule synchro complète PG-005. |

- Le `webhookId` n'est pas utilisé comme clé.
- Les livraisons en double sont sans effet : PG-009 déduplique les `PENDING` et PG-007 est idempotent.
- Un événement reçu pendant qu'un job tourne (`RUNNING`) crée un nouveau `PENDING`.

`refunds/create` : `order_id` est un nombre JSON qui peut dépasser `Number.MAX_SAFE_INTEGER` (les exemples Shopify contiennent par exemple `820982911946154508`). `JSON.parse` l'arrondirait. Pour lire l'identifiant exact :
1. la route clone la requête **avant** `authenticate.webhook()`, puis ne lit cette copie **qu'après** la vérification de la signature, et seulement pour `REFUNDS_CREATE` ;
2. `topLevelSourceOf(rawBody, "order_id")` relit le body avec le reviver `JSON.parse` de Node.js 22 (`context.source`), qui donne les chiffres exacts du champ `order_id` **de premier niveau**. Les `order_id` imbriqués (par exemple dans `order_adjustments`) sont ignorés ;
3. ces chiffres doivent correspondre à `^[1-9]\d*$` : `1.5`, `-1`, `0` ou `8.2e17` sont refusés (422) ;
4. le GID construit est `gid://shopify/Order/<chiffres exacts>`. Le GID du remboursement (`admin_graphql_api_id`) n'est jamais utilisé.

Sans source brute (appel direct du service), un nombre n'est accepté que s'il est un entier sûr, et une chaîne décimale reste acceptée.

Seuls les champs de routage sont lus, et le payload Shopify n'est jamais copié dans le job : aucune PII, adresse, token ni donnée de carte.

## Réponses HTTP

| Cas | Réponse |
|---|---|
| Job persisté, ou déjà `PENDING` (dédupliqué) | **200**, une fois l'écriture en base confirmée |
| Boutique inconnue, inactive (`isActive = false` ou `uninstalledAt`), ou sans session offline (désinstallée) | **200**, sans job |
| Payload invalide ou topic non géré | **422**, sans job |
| Échec PostgreSQL ou de l'enqueue | **503** avec un message générique, pour que Shopify réessaie |
| Signature invalide | Réponse 4xx du SDK |

Journal minimal sur une ligne : topic, domaine, résultat (`enqueued`, `deduplicated`, `ignored`, `rejected`, `failed`), `jobId` et catégorie d'erreur. Jamais le payload ni un secret.

## Prérequis à connaître

- Une boutique n'existe dans `Shop` qu'une fois créée par l'onboarding, **pas encore implémenté**. D'ici là, tous les webhooks reçus répondent 200 sans job (`unknown_shop`).
- `npm test` exécute maintenant les fichiers de test **en série** (`--test-concurrency=1`). Les suites qui utilisent la base partagent la file de jobs globale, et `processJobsOnce` d'un fichier pourrait sinon prendre les jobs d'un autre.

## Tests

26 tests :
- **mapping pur :** les 7 topics, commande parente d'un remboursement, ids dangereux rejetés, payload invalide, topic inconnu ;
- **PostgreSQL :** payload limité à `{ orderGid }`, un seul `PENDING` par commande et par catalogue, nouveau `PENDING` pendant `RUNNING`, isolation A/B (`shop_id` du payload ignoré), boutique inconnue, inactive ou sans session ;
- **contrat HTTP :** 200, dédupliqué, 422, 503 sans détail interne, aucun appel GraphQL, rejet d'authentification transmis tel quel ;
- **configuration :** routes existantes conservées, et chaque topic présent une seule fois dans le TOML ;
- **SDK réel :** `authenticate.webhook`, configuré comme `shopify.server.ts` avec un secret de test. Requête non signée ou mal signée : rejet 4xx. Requête signée : 200 et job créé. Requête signée sans session offline : 200 sans job. `refunds/create` avec `order_id: 820982911946154508` en nombre JSON brut donne exactement `gid://shopify/Order/820982911946154508` ; un `order_id` brut malformé donne 422 sans job.

## Hors scope

Worker, cron, scheduler, exécution des jobs (PG-011), réconciliation périodique, statut de synchronisation, `orders/delete`, webhooks de conformité, UI, profit, scopes.
