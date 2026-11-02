import { AgentTurnError } from '@nexo/agent';
import { type ApiErrorBody, IdSchema, LoginRequestSchema, type Message, RequestHandoffRequestSchema, SendMessageRequestSchema, TicketCodeSchema, type User } from '@nexo/shared';
import type { TicketService } from '@nexo/ticket-service';
import { type Request, type RequestHandler, type Response, Router } from 'express';
import type { AuthService } from '../../auth/auth-service.js';
import type { ConsoleService } from '../../console/console-service.js';
import type { HandoffRequestService } from '../../conversations/handoff-request.js';
import { type ConversationEventBus, createConversationEventBus } from '../../conversations/conversation-events.js';
import type { ConversationRecord } from '../../conversations/conversation-repository.js';
import type { ConversationService } from '../../conversations/conversation-service.js';
import { type AgentResponder, noAgentResponder } from '../../conversations/responder.js';
import type { DraftService } from '../../drafts/draft-service.js';
import { isTransientDatabaseError } from '../../infra/prisma-errors.js';
import { BusyError } from '../../infra/write-slots.js';
import { AppError } from '../app-error.js';
import { authenticate, currentUser, requireAnalyst, requireRole } from '../middleware/authenticate.js';
import { type ErrorLogger, busyToAppError } from '../middleware/error-handler.js';
import { type SseStream, openSse } from '../sse.js';
import { consoleRouter } from './console.js';
import { conversationEventsHandler } from './events.js';

export interface ApiDeps {
  readonly auth: AuthService;
  readonly tickets: TicketService;
  readonly drafts: DraftService;
  readonly conversations: ConversationService;
  /** Agente que responde às mensagens. Sem ele, a mensagem é gravada e o stream termina sem resposta. */
  readonly responder?: AgentResponder;
  /** Console do analista (`/api/console/*`). Sem ele essas rotas não existem. */
  readonly console?: ConsoleService;
  /**
   * Barramento dos eventos da conversa. O mesmo que o console usa para avisar o funcionário; sem ele o
   * stream de eventos funciona, mas só entrega o estado atual e as mensagens já gravadas.
   */
  readonly events?: ConversationEventBus;
  /** Pedido direto de analista pelo funcionário. Sem ele a rota não existe. */
  readonly handoffs?: HandoffRequestService;
  readonly eventStreams?: { readonly maxPerUser?: number; readonly heartbeatMs?: number };
}

/** Respostas autenticadas nunca devem ser guardadas por caches compartilhados. */
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('cache-control', 'no-store');
  next();
};

const AGENT_FAILURE_MESSAGES: Record<AgentTurnError['reason'], string> = {
  MODEL_UNAVAILABLE: 'Não consegui responder agora. Sua mensagem ficou registrada; tente novamente em instantes.',
  TIMEOUT: 'A resposta demorou mais que o esperado. Sua mensagem ficou registrada; tente novamente.',
  INVALID_RESPONSE: 'Não consegui montar uma resposta válida. Sua mensagem ficou registrada; tente novamente.',
  ABORTED: 'A resposta foi interrompida. Sua mensagem ficou registrada; tente novamente.',
};

/** Erro depois de o stream abrir: vira evento `error` com código de contrato e mensagem segura. */
function streamErrorOf(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AgentTurnError) return new AppError('AGENT_UNAVAILABLE', AGENT_FAILURE_MESSAGES[error.reason]);
  if (error instanceof BusyError) return busyToAppError(error);
  if (isTransientDatabaseError(error)) return new AppError('DATABASE_UNAVAILABLE', 'Banco de dados indisponível. Tente novamente em instantes.');
  return new AppError('AGENT_UNAVAILABLE', 'Não consegui responder agora. Tente novamente.');
}

/**
 * Repassa a resposta do agente pelo stream já aberto. Qualquer falha vira um evento `error` (a mensagem
 * do funcionário continua gravada e pendente) e o stream sempre termina com `done`.
 */
async function streamAgentResponse(
  req: Request,
  res: Response,
  stream: SseStream,
  responder: AgentResponder,
  logger: ErrorLogger,
  input: { user: User; conversation: ConversationRecord; message: Message },
): Promise<void> {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    for await (const event of responder.respond({ ...input, signal: abort.signal })) {
      if (!stream.send(event)) break;
    }
  } catch (error) {
    const appError = streamErrorOf(error);
    logger.error('Falha ao responder no stream', {
      requestId: req.requestId,
      code: appError.code,
      error: error instanceof AgentTurnError ? { name: error.name, reason: error.reason } : error instanceof Error ? { name: error.name, message: error.message } : 'desconhecido',
    });
    const body: ApiErrorBody = { error: { code: appError.code, message: appError.message, retryable: appError.retryable, requestId: req.requestId } };
    stream.send({ event: 'error', data: body });
  }
}

/** Rotas de negócio, montadas em `/api`. A lógica de domínio fica nos serviços; aqui só há HTTP. */
export function apiRouter(deps: ApiDeps, logger: ErrorLogger): Router {
  const router = Router();
  const responder = deps.responder ?? noAgentResponder;
  const requireLogin = authenticate(deps.auth);
  const employeeOnly = [requireLogin, requireRole('EMPLOYEE')];
  const events = deps.events ?? createConversationEventBus();

  router.use(noStore);

  // --- Auth ---------------------------------------------------------------
  router.post('/auth/login', async (req, res) => {
    const { email, password } = LoginRequestSchema.parse(req.body);
    res.json(await deps.auth.login(email, password));
  });

  router.get('/auth/me', requireLogin, (req, res) => {
    res.json({ user: currentUser(req) });
  });

  // --- Chamados do funcionário --------------------------------------------
  router.get('/tickets', ...employeeOnly, async (req, res) => {
    const items = await deps.tickets.listForRequester({ employeeId: currentUser(req).id });
    res.json({ items });
  });

  router.get('/tickets/:ticketCode', ...employeeOnly, async (req, res) => {
    const code = TicketCodeSchema.parse(req.params.ticketCode);
    const ticket = await deps.tickets.getForRequester({ employeeId: currentUser(req).id }, code);
    res.json({ ticket });
  });

  // --- Conversas ----------------------------------------------------------
  router.get('/conversations', ...employeeOnly, async (req, res) => {
    res.json({ items: await deps.conversations.list(currentUser(req)) });
  });

  router.post('/conversations', ...employeeOnly, async (req, res) => {
    const { conversation, created } = await deps.conversations.start(currentUser(req));
    res.status(created ? 201 : 200).json({ conversation });
  });

  router.get('/conversations/:conversationId', ...employeeOnly, async (req, res) => {
    const conversationId = IdSchema.parse(req.params.conversationId);
    res.json({ conversation: await deps.conversations.get(currentUser(req), conversationId) });
  });

  /**
   * Mensagem do funcionário. Tudo que pode falhar (validação, dono, conversa encerrada, limite) é
   * resolvido ANTES de abrir o stream, então vira um erro JSON comum. Depois de aberto, falhas do
   * agente chegam como evento `error`.
   */
  router.post('/conversations/:conversationId/messages', ...employeeOnly, async (req, res) => {
    const user = currentUser(req);
    const conversationId = IdSchema.parse(req.params.conversationId);
    const input = SendMessageRequestSchema.parse(req.body);
    const accepted = await deps.conversations.sendMessage(user, conversationId, input);

    const stream = openSse(res);
    try {
      stream.send({ event: 'message.accepted', data: { message: accepted.message } });
      if (accepted.status !== 'WITH_AGENT') {
        // Agente pausado: avisa a interface de que a conversa está com a equipe humana.
        stream.send({ event: 'conversation.status', data: { status: accepted.status, version: accepted.version } });
      }
      if (accepted.agentShouldRespond) {
        await streamAgentResponse(req, res, stream, responder, logger, { user, conversation: accepted.conversation, message: accepted.message });
      }
    } finally {
      stream.send({ event: 'done', data: {} });
      stream.end();
    }
  });

  /**
   * Retoma a resposta pendente do agente (ex.: o modelo falhou depois de a mensagem ser gravada, ou o
   * cliente caiu). Idempotente: se a resposta já existe, ela é devolvida sem chamar o modelo de novo;
   * se não há pendência, o stream só informa o estado e termina.
   */
  router.post('/conversations/:conversationId/resume', ...employeeOnly, async (req, res) => {
    const user = currentUser(req);
    const conversationId = IdSchema.parse(req.params.conversationId);
    const { conversation, pending } = await deps.conversations.resume(user, conversationId);

    const stream = openSse(res);
    try {
      if (conversation.status !== 'WITH_AGENT') {
        stream.send({ event: 'conversation.status', data: { status: conversation.status, version: conversation.version } });
      } else if (pending) {
        await streamAgentResponse(req, res, stream, responder, logger, { user, conversation, message: pending });
      }
    } finally {
      stream.send({ event: 'done', data: {} });
      stream.end();
    }
  });

  /** Mensagens do analista e mudanças de estado, sem recarregar a página (ver `events.ts`). */
  router.get(
    '/conversations/:conversationId/events',
    ...employeeOnly,
    conversationEventsHandler({ conversations: deps.conversations, events, ...deps.eventStreams }),
  );

  /** O funcionário pede um analista direto, sem passar pelo agente (idempotente). */
  if (deps.handoffs) {
    const handoffs = deps.handoffs;
    router.post('/conversations/:conversationId/handoff', ...employeeOnly, async (req, res) => {
      const conversationId = IdSchema.parse(req.params.conversationId);
      const { note } = RequestHandoffRequestSchema.parse(req.body ?? {});
      const { created, handoff, conversation } = await handoffs.request(currentUser(req), conversationId, { note });
      res.status(created ? 201 : 200).json({ handoff, conversation });
    });
  }

  // --- Rascunhos ----------------------------------------------------------
  router.post('/conversations/:conversationId/drafts/:draftId/confirm', ...employeeOnly, async (req, res) => {
    const conversationId = IdSchema.parse(req.params.conversationId);
    const draftId = IdSchema.parse(req.params.draftId);
    res.json(await deps.drafts.confirm(currentUser(req), conversationId, draftId));
  });

  router.post('/conversations/:conversationId/drafts/:draftId/discard', ...employeeOnly, async (req, res) => {
    const conversationId = IdSchema.parse(req.params.conversationId);
    const draftId = IdSchema.parse(req.params.draftId);
    res.json(await deps.drafts.discard(currentUser(req), conversationId, draftId));
  });

  // --- Console do analista ------------------------------------------------
  if (deps.console) router.use('/console', requireLogin, requireAnalyst, consoleRouter(deps.console));

  return router;
}
