import type { ApiErrorBody } from '@nexo/shared';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../app-error.js';

export interface ErrorLogger {
  error(message: string, context: Record<string, unknown>): void;
}

function send(res: Response, error: AppError, requestId: string): void {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  res.status(error.httpStatus).json(body);
}

function isBodyParserError(error: unknown): error is { type: string; status: number } {
  return typeof error === 'object' && error !== null && 'type' in error && 'status' in error;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `Rota não encontrada: ${req.method} ${req.path}`));
};

/** Converte qualquer erro em `ApiErrorBody`. Detalhes internos só vão para o log. */
export function createErrorHandler(logger: ErrorLogger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof AppError) {
      send(res, error, req.requestId);
      return;
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      send(res, new AppError('VALIDATION_ERROR', 'Dados inválidos na requisição.', details), req.requestId);
      return;
    }

    if (isBodyParserError(error) && error.status >= 400 && error.status < 500) {
      const message = error.status === 413 ? 'Corpo da requisição muito grande.' : 'JSON inválido no corpo da requisição.';
      send(res, new AppError('VALIDATION_ERROR', message), req.requestId);
      return;
    }

    logger.error('Erro não tratado', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
    });
    send(res, new AppError('INTERNAL_ERROR', 'Erro interno. Tente novamente em instantes.'), req.requestId);
  };
}
