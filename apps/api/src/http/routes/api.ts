import { IdSchema, LoginRequestSchema, TicketCodeSchema } from '@nexo/shared';
import type { TicketService } from '@nexo/ticket-service';
import { type RequestHandler, Router } from 'express';
import type { AuthService } from '../../auth/auth-service.js';
import type { DraftService } from '../../drafts/draft-service.js';
import { authenticate, currentUser, requireRole } from '../middleware/authenticate.js';

export interface ApiDeps {
  readonly auth: AuthService;
  readonly tickets: TicketService;
  readonly drafts: DraftService;
}

/** Respostas autenticadas nunca devem ser guardadas por caches compartilhados. */
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('cache-control', 'no-store');
  next();
};

/** Rotas de negócio, montadas em `/api`. A lógica de domínio fica nos serviços; aqui só há HTTP. */
export function apiRouter(deps: ApiDeps): Router {
  const router = Router();
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
