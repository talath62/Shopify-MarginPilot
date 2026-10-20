import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleShopifyWebhook } from "../services/shopify-webhook-dispatch.server";

// PG-010: order and catalog webhooks. Verified by authenticate.webhook,
// then enqueued as PG-009 jobs. No sync runs in this request.
export const action = async ({ request }: ActionFunctionArgs) =>
  handleShopifyWebhook(request, (signed) => authenticate.webhook(signed));
