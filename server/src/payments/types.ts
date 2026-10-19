import type { Row } from "../db.js";

export interface CheckoutRequest {
  payment: Row;     // payments row (already inserted, status pending)
  business: Row;
  description: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  providerRef: string;
  checkoutUrl: string;
}

export interface ConfirmResult {
  paid: boolean;
  providerPaymentId?: string;
}

/**
 * Every billing integration implements this. Businesses pick one in their admin
 * settings; the platform never touches card data (all hosted checkout pages).
 */
export interface PaymentProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** Called when the customer returns from checkout (or from a webhook) to verify payment. */
  confirm(payment: Row, business: Row, params: Record<string, string>): Promise<ConfirmResult>;
  refund(payment: Row, business: Row, amountCents: number): Promise<void>;
}

export function toMajorUnits(cents: number) {
  return (cents / 100).toFixed(2);
}
