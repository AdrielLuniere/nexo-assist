import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const HEADER = 'x-request-id';
const VALID_ID = /^[\w-]{1,64}$/;

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

/** Reaproveita um `x-request-id` válido recebido ou gera um novo; devolve no header da resposta. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(HEADER);
  req.requestId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(HEADER, req.requestId);
  next();
};
