export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
