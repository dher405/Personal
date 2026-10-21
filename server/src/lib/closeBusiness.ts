import { DateTime } from "luxon";
import { config } from "../config.js";
import { all, audit, one, run, type Row } from "../db.js";
import { stripe } from "../payments/stripe.js";
import { cancelBooking } from "./bookings.js";
import { badRequest, notFound } from "./errors.js";

type Actor = { id?: string | null; label: string };

/**
 * What a business pays the platform when it's suspended, closed or deleted. Suspending pauses its Stripe
 * subscription (invoices are voided, so nothing is charged) and reactivating resumes it. Closing or deleting
 * cancels the subscription for good. Without Stripe connected there's nothing to change.
 */
export async function pauseBilling(business: Row, paused: boolean) {
  if (!config.stripe.secretKey || !business.platform_subscription_id) return false;
  await stripe().subscriptions.update(business.platform_subscription_id, { pause_collection: paused ? { behavior: "void" } : "" });
  return true;
}

async function endSubscription(business: Row) {
  if (!config.stripe.secretKey || !business.platform_subscription_id) return false;
  try {
    await stripe().subscriptions.cancel(business.platform_subscription_id);
  } catch (err: any) {
    // Already cancelled (or gone) in Stripe: nothing left to stop.
    if (err?.code !== "resource_missing" && !/canceled/i.test(String(err?.message))) throw err;
  }
  return true;
}

/**
 * Closes a business: its Stripe subscription is cancelled now (no further charges), every upcoming booking is
 * cancelled with the customer emailed and refunded in full, and the business is hidden. Its records are kept until
 * it's deleted permanently.
 */
export async function closeBusiness(businessId: string, actor: Actor) {
  const business = one("SELECT * FROM businesses WHERE id = ?", businessId);
  if (!business) throw notFound("Business not found");
  // Stop billing first: if Stripe refuses, nothing else changes and the super admin sees why.
  const subscriptionCancelled = await endSubscription(business);
  run("UPDATE businesses SET suspended = 1, closed_at = ?, plan = 'free', plan_status = 'active', plan_ends_at = NULL, platform_subscription_id = NULL WHERE id = ?",
    DateTime.utc().toISO(), businessId);

  const upcoming = all("SELECT id FROM bookings WHERE business_id = ? AND status IN ('confirmed','pending_payment','requested') AND starts_at > ?", businessId, DateTime.utc().toISO());
  let refundsFailed = 0;
  for (const b of upcoming) {
    const cancelled = await cancelBooking(b.id, { byCustomer: false, reason: "The business has closed" }, actor);
    if (cancelled.refund_error) refundsFailed += 1;
  }
  audit(actor, businessId, "business.closed", { subscriptionCancelled, bookingsCancelled: upcoming.length, refundsFailed });
  return { subscriptionCancelled, bookingsCancelled: upcoming.length, refundsFailed };
}

/** Deletes a closed business and everything that belongs to it. Can't be undone. */
export async function deleteBusiness(businessId: string, actor: Actor) {
  const business = one("SELECT * FROM businesses WHERE id = ?", businessId);
  if (!business) throw notFound("Business not found");
  if (!business.closed_at) throw badRequest("Close the business first: that cancels its billing and upcoming bookings (with refunds) before anything is deleted.");
  await endSubscription(business); // in case it was re-subscribed somehow
  run("DELETE FROM businesses WHERE id = ?", businessId);
  audit(actor, null, "business.deleted", { businessId, name: business.name, slug: business.slug });
  return { deleted: true };
}
