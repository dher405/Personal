import { config } from "../config.js";
import type { PaymentProvider } from "./types.js";

/** Local/demo provider: "checkout" is a server URL that immediately marks the payment paid. */
export const mockProvider: PaymentProvider = {
  name: "mock",
  async createCheckout(req) {
    return {
      providerRef: `mock_${req.payment.id}`,
      checkoutUrl: `${config.apiUrl}/api/payments/${req.payment.id}/return?mock=paid&next=${encodeURIComponent(req.successUrl)}`,
    };
  },
  async confirm(payment, _business, params) {
    return { paid: params.mock === "paid", providerPaymentId: `mockpay_${payment.id}` };
  },
  async refund() {},
};
