import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { HttpError, badRequest } from "./errors.js";

/** Wraps async handlers so thrown errors reach the error middleware. */
export const h = (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res)).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next);

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest("Invalid request", z.flattenError(result.error as z.ZodError).fieldErrors);
  return result.data;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
}
