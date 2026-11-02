import {
  AnalystMessageRequestSchema,
  ConsoleActionRequestSchema,
  ConsoleConversationFilterSchema,
  IdSchema,
} from '@nexo/shared';
import { Router } from 'express';
import type { ConsoleService } from '../../console/console-service.js';
import { currentUser } from '../middleware/authenticate.js';

/**
 * Rotas do console do analista, montadas em `/api/console` depois de `authenticate` e
 * `requireAnalyst`. O analista é sempre o usuário da sessão: o corpo nunca informa quem está agindo.
 */
export function consoleRouter(service: ConsoleService): Router {
  const router = Router();

  router.get('/conversations', async (req, res) => {
    res.json(await service.list(ConsoleConversationFilterSchema.parse(req.query)));
  });

  router.get('/conversations/:conversationId', async (req, res) => {
    res.json({ conversation: await service.get(IdSchema.parse(req.params.conversationId)) });
  });

  router.post('/conversations/:conversationId/assume', async (req, res) => {
    const { expectedVersion } = ConsoleActionRequestSchema.parse(req.body);
    res.json({ conversation: await service.assume(currentUser(req), IdSchema.parse(req.params.conversationId), expectedVersion) });
  });

  router.post('/conversations/:conversationId/return', async (req, res) => {
    const { expectedVersion } = ConsoleActionRequestSchema.parse(req.body);
    res.json({ conversation: await service.returnToAgent(currentUser(req), IdSchema.parse(req.params.conversationId), expectedVersion) });
  });

  router.post('/conversations/:conversationId/close', async (req, res) => {
    const { expectedVersion } = ConsoleActionRequestSchema.parse(req.body);
    res.json({ conversation: await service.close(currentUser(req), IdSchema.parse(req.params.conversationId), expectedVersion) });
  });

  router.post('/conversations/:conversationId/messages', async (req, res) => {
    const input = AnalystMessageRequestSchema.parse(req.body);
    const { message, replayed } = await service.sendMessage(currentUser(req), IdSchema.parse(req.params.conversationId), input);
    res.status(replayed ? 200 : 201).json({ message });
  });

  return router;
}
