import express, { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { one, run, Row } from "../db.js";
import { channelsFor } from "../lib/channels.js";
import { h } from "../lib/http.js";
import { handleInboundSms } from "../lib/smsInbound.js";

export const smsWebhookRouter = Router();
const form = express.urlencoded({ extended: false });

/** Twilio's X-Twilio-Signature: HMAC-SHA1 over the full URL plus the sorted POST params, keyed by the account's auth token. */
function validTwilioSignature(authToken: string | undefined, url: string, params: Record<string, string>, signature: string | undefined) {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Each business has its own webhook addresses (shown on its Text messages tab), checked with its own Twilio auth token. */
function verifiedBusiness(req: express.Request): Row | null {
  const business = one("SELECT * FROM businesses WHERE id = ?", req.params.bid);
  if (!business) return null;
  const ok = validTwilioSignature(channelsFor(business).sms.authToken, `${config.apiUrl}${req.originalUrl}`, req.body ?? {}, req.headers["x-twilio-signature"] as string | undefined);
  return ok ? business : null;
}

// The business sets this as "A message comes in" on its Twilio number or Messaging Service.
smsWebhookRouter.post("/webhooks/twilio/:bid/sms", form, h((req, res) => {
  const business = verifiedBusiness(req);
  if (!business) return void res.status(403).send("bad signature");
  // Answer Twilio right away (it times out after 15s); AI replies can take longer, so they're sent via the API.
  res.type("text/xml").send("<Response></Response>");
  handleInboundSms(business, String(req.body.From ?? ""), String(req.body.Body ?? "")).catch((err) => console.error("inbound sms failed", err));
}));

smsWebhookRouter.post("/webhooks/twilio/:bid/status", form, h((req, res) => {
  const business = verifiedBusiness(req);
  if (!business) return void res.status(403).send("bad signature");
  run("UPDATE sms_messages SET status = ?, error = COALESCE(?, error) WHERE business_id = ? AND provider_sid = ?",
    String(req.body.MessageStatus ?? "unknown"), req.body.ErrorCode ? `Twilio error ${req.body.ErrorCode}` : null, business.id, String(req.body.MessageSid ?? ""));
  res.sendStatus(204);
}));
