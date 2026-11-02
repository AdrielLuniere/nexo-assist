import * as shared from '@nexo/shared';
import { describe, expect, it } from 'vitest';
import * as prismaEnums from '../apps/api/src/generated/prisma/enums.js';

/** Enums do banco e dos contratos precisam ser idênticos: divergência quebraria a API em tempo de execução. */
const PAIRS: Array<[keyof typeof prismaEnums, readonly string[]]> = [
  ['UserRole', shared.USER_ROLES],
  ['AnalystLevel', shared.ANALYST_LEVELS],
  ['TicketType', shared.TICKET_TYPES],
  ['TicketCategory', shared.TICKET_CATEGORIES],
  ['TicketPriority', shared.TICKET_PRIORITIES],
  ['TicketStatus', shared.TICKET_STATUSES],
  ['AffectedScope', shared.AFFECTED_SCOPES],
  ['ConversationStatus', shared.CONVERSATION_STATUSES],
  ['MessageRole', shared.MESSAGE_ROLES],
  ['ActorType', shared.ACTOR_TYPES],
  ['TicketEventType', shared.TICKET_EVENT_TYPES],
  ['DraftOperation', shared.DRAFT_OPERATIONS],
  ['DraftStatus', shared.DRAFT_STATUSES],
  ['HandoffReason', shared.HANDOFF_REASONS],
  ['HandoffStatus', shared.HANDOFF_STATUSES],
  ['AgentIntent', shared.AGENT_INTENTS],
  ['AgentAction', shared.AGENT_ACTIONS],
];

describe('enums Prisma × contratos compartilhados', () => {
  it.each(PAIRS)('%s está sincronizado', (name, values) => {
    expect(Object.values(prismaEnums[name]).sort()).toEqual([...values].sort());
  });

  it('todos os enums do schema estão cobertos', () => {
    expect(Object.keys(prismaEnums).sort()).toEqual(PAIRS.map(([name]) => name).sort());
  });
});
