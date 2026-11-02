import { type ConversationStatus, type HandoffStatus, canTransition } from '@nexo/shared';

/**
 * Regras do console do analista, sem acesso a dados. As duas implementações do repositório (PostgreSQL
 * e memória) aplicam exatamente estas decisões; a atomicidade fica por conta de cada uma (trava de
 * linha no banco, ausência de `await` na memória).
 *
 * Modelo de atendimento:
 * - qualquer analista (N1 ou N2) pode assumir uma conversa que aguarda atendimento;
 * - quem assumiu é o responsável: só ele responde, devolve ao agente ou encerra;
 * - qualquer analista pode encerrar uma conversa que ainda aguarda (ninguém é o responsável);
 * - toda ação informa a versão que o analista viu; se a conversa mudou, nada é alterado.
 */

export type ConsoleAction = 'assume' | 'return' | 'close';

export interface ConversationState {
  readonly status: ConversationStatus;
  readonly version: number;
  readonly assignedAnalystId: string | null;
}

export type TransitionDecision =
  | {
      readonly kind: 'apply';
      readonly to: ConversationStatus;
      /** Responsável depois da ação (`null` limpa; ao encerrar, quem era responsável continua registrado). */
      readonly assignedAnalystId: string | null;
      /** Transferência em andamento: de qual estado para qual (os registros nunca são apagados). */
      readonly handoff: { readonly from: readonly HandoffStatus[]; readonly to: HandoffStatus };
    }
  /** Repetição de uma ação que já foi aplicada por este mesmo analista (resposta perdida). */
  | { readonly kind: 'replay' }
  | { readonly kind: 'not_owner' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'invalid_state' };

/**
 * Ordem das verificações (a primeira que falha vence):
 * 1. responsável: quem não é o responsável de uma conversa em atendimento não altera nada;
 * 2. versão: a conversa mudou desde que o analista a viu (`stale`);
 * 3. estado: a ação não existe a partir do estado atual (`invalid_state`).
 */
export function decideTransition(state: ConversationState, action: ConsoleAction, analystId: string, expectedVersion: number): TransitionDecision {
  const ownedByOther = state.status === 'WITH_ANALYST' && state.assignedAnalystId !== analystId;
  if (action !== 'assume' && ownedByOther) return { kind: 'not_owner' };

  if (state.version !== expectedVersion) {
    // Quem assumiu e repete o pedido (a resposta se perdeu) vê a conversa já assumida por ele, uma
    // versão à frente. Só `assume` é tratada assim: é a ação disputada por vários analistas.
    const retry = action === 'assume' && state.status === 'WITH_ANALYST' && state.assignedAnalystId === analystId && state.version === expectedVersion + 1;
    return retry ? { kind: 'replay' } : { kind: 'stale' };
  }

  const apply = (to: ConversationStatus, assignedAnalystId: string | null, from: readonly HandoffStatus[], handoffTo: HandoffStatus): TransitionDecision =>
    canTransition(state.status, to) ? { kind: 'apply', to, assignedAnalystId, handoff: { from, to: handoffTo } } : { kind: 'invalid_state' };

  switch (action) {
    case 'assume':
      return state.status === 'WAITING_ANALYST' ? apply('WITH_ANALYST', analystId, ['WAITING'], 'ASSUMED') : { kind: 'invalid_state' };
    case 'return':
      return state.status === 'WITH_ANALYST' ? apply('WITH_AGENT', null, ['ASSUMED'], 'RETURNED_TO_AGENT') : { kind: 'invalid_state' };
    case 'close':
      if (state.status === 'WAITING_ANALYST') return apply('CLOSED', null, ['WAITING'], 'CLOSED');
      if (state.status === 'WITH_ANALYST') return apply('CLOSED', state.assignedAnalystId, ['ASSUMED'], 'CLOSED');
      return { kind: 'invalid_state' };
  }
}

export type PostDecision = { readonly kind: 'allow' } | { readonly kind: 'not_owner' } | { readonly kind: 'invalid_state' };

/** Mensagem de analista: só na conversa em atendimento humano e só do responsável. */
export function decidePost(state: ConversationState, analystId: string): PostDecision {
  if (state.status !== 'WITH_ANALYST') return { kind: 'invalid_state' };
  return state.assignedAnalystId === analystId ? { kind: 'allow' } : { kind: 'not_owner' };
}
