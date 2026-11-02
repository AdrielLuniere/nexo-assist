import { IdSchema, LoginRequestSchema, SendMessageRequestSchema, TicketCodeSchema } from '@nexo/shared';
import type { TicketService } from '@nexo/ticket-service';
import { type RequestHandler, Router } from 'express';
import type { AuthService } from '../../auth/auth-service.js';
import type { ConversationService } from '../../conversations/conversation-service.js';
import { type AgentResponder, noAgentResponder } from '../../conversations/responder.js';
import type { DraftService } from '../../drafts/draft-service.js';
import { authenticate, currentUser, requireRole } from '../middleware/authenticate.js';
import type { ErrorLogger } from '../middleware/error-handler.js';
import { openSse } from '../sse.js';

export interface ApiDeps {
  readonly auth: AuthService;
  readonly tickets: TicketService;
  readonly drafts: DraftService;
  readonly conversations: ConversationService;
  /** Agente que responde às mensagens. Sem ele, a mensagem é gravada e o stream termina sem resposta. */
  readonly responder?: AgentResponder;
}

/** Respostas autenticadas nunca devem ser guardadas por caches compartilhados. */
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('cache-control', 'no-store');
  next();
};

/** Rotas de negócio, montadas em `/api`. A lógica de domínio fica nos serviços; aqui só há HTTP. */
export function apiRouter(deps: ApiDeps, logger: ErrorLogger): Router {
  const router = Router();
  const responder = deps.responder ?? noAgentResponder;
  const requireLogin = authenticate(deps.auth);
  const employeeOnly = [requireLogin, requireRole('EMPLOYEE')];

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
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      stream.send({ event: 'message.accepted', data: { message: accepted.message } });
      if (accepted.status !== 'WITH_AGENT') {
        // Agente pausado: avisa a interface de que a conversa está com a equipe humana.
        stream.send({ event: 'conversation.status', data: { status: accepted.status, version: accepted.version } });
      }
      if (accepted.agentShouldRespond) {
        const events = responder.respond({ user, conversation: accepted.conversation, message: accepted.message, signal: abort.signal });
        for await (const event of events) {
          if (!stream.send(event)) break;
        }
      }
    } catch (error) {
      logger.error('Falha ao responder no stream', {
        requestId: req.requestId,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'desconhecido',
      });
      stream.send({
        event: 'error',
        data: { error: { code: 'AGENT_UNAVAILABLE', message: 'Não consegui responder agora. Tente novamente.', retryable: true, requestId: req.requestId } },
      });
    }
    stream.send({ event: 'done', data: {} });
    stream.end();
  });

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

  return router;
}
