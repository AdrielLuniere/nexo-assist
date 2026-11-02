import { type ApiErrorCode, httpStatusOf, isRetryable } from '@nexo/shared';

/** Erro de aplicação com código de contrato. Tudo que não for `AppError` vira INTERNAL_ERROR. */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get httpStatus(): number {
    return httpStatusOf(this.code);
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}
