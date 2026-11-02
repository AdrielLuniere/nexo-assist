import { type HealthResponse, HealthResponseSchema } from '@nexo/shared';

/** `/health` responde 503 com corpo válido quando o banco está fora; ambos os casos são lidos. */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/health', signal ? { signal } : {});
  if (response.status !== 200 && response.status !== 503) {
    throw new Error(`API respondeu ${response.status}`);
  }
  return HealthResponseSchema.parse(await response.json());
}
