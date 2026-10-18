import { badRequest } from "../lib/errors.js";
import { mockProvider } from "./mock.js";
import { paypalProvider } from "./paypal.js";
import { squareProvider } from "./square.js";
import { stripeProvider } from "./stripe.js";
import type { PaymentProvider } from "./types.js";

const providers: Record<string, PaymentProvider> = {
  stripe: stripeProvider,
  square: squareProvider,
  paypal: paypalProvider,
  mock: mockProvider,
};

export function providerFor(name: string): PaymentProvider {
  const provider = providers[name];
  if (!provider) throw badRequest("This business does not accept online payments");
  return provider;
}
