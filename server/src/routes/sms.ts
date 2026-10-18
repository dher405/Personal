import express, { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { run } from "../db.js";
import { h } from "../lib/http.js";
import { handleInboundSms } from "../lib/smsInbound.js";

export const smsWebhookRouter = Router();
const form = express.urlencoded({ extended: false });

/** Twilio's X-Twilio-Signature: HMAC-SHA1 over the full URL plus the sorted POST params. */
function validTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined) {
  if (!config.twilio.authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", config.twilio.authToken).update(data).digest("base64");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const verified = (req: express.Request) =>
  validTwilioSignature(`${config.apiUrl}${req.originalUrl}`, req.body ?? {}, req.headers["x-twilio-signature"] as string | undefined);

// Configure as the "A message comes in" webhook on your Twilio number / Messaging Service.
smsWebhookRouter.post("/webhooks/twilio/sms", form, h((req, res) => {
  if (!verified(req)) {
    res.status(403).send("bad signature");
    return;
  }
  // Answer Twilio right away (it times out after 15s); AI replies can take longer, so they're sent via the API.
  res.type("text/xml").send("<Response></Response>");
  handleInboundSms(String(req.body.From ?? ""), String(req.body.Body ?? "")).catch((err) => console.error("inbound sms failed", err));
}));

smsWebhookRouter.post("/webhooks/twilio/status", form, h((req, res) => {
  if (!verified(req)) {
    res.status(403).send("bad signature");
    return;
  }
  run("UPDATE sms_messages SET status = ?, error = COALESCE(?, error) WHERE provider_sid = ?",
    String(req.body.MessageStatus ?? "unknown"), req.body.ErrorCode ? `Twilio error ${req.body.ErrorCode}` : null, String(req.body.MessageSid ?? ""));
  res.sendStatus(204);
}));
