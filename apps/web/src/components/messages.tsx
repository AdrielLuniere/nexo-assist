import { type AgentDecision, type AgentStep, HANDOFF_REASON_LABELS, type Message, type MessageBlock, type QuickReply, type TicketSummary } from '@nexo/shared';
import type { ReactNode } from 'react';
import { formatTime } from '../lib/format';
import { AgentStepsLine } from './decision';
import { DraftCard } from './draft-card';
import { TicketCard, TicketSelection } from './tickets';
import { Button, Icons, cx } from './ui';

export type Perspective = 'employee' | 'analyst';

export interface MessageActions {
  /** Envia um texto como mensagem do funcionário (respostas rápidas, seleção de chamado). */
  readonly send?: (text: string) => void;
  readonly confirmDraft?: (draftId: string) => void;
  readonly discardDraft?: (draftId: string) => void;
  readonly openDecision?: (decision: AgentDecision) => void;
}

export interface MessageViewProps {
  readonly message: Message;
  readonly decision: AgentDecision | undefined;
  readonly perspective: Perspective;
  /** Id do usuário da sessão (para "Você"). */
  readonly meId: string;
  /** Respostas rápidas e seleção de chamado só valem na última mensagem do agente, com ele ativo. */
  readonly choicesEnabled: boolean;
  /** Rascunhos podem ser confirmados (funcionário, conversa não encerrada). */
  readonly draftsEnabled: boolean;
  readonly draftBusy: { readonly draftId: string; readonly action: 'confirm' | 'discard' } | null;
  readonly actions: MessageActions;
  readonly now?: Date;
}

/** Bolha + blocos de uma mensagem. Do lado do funcionário, a pessoa fica à direita; no console, o inverso. */
export function MessageView(props: MessageViewProps) {
  const { message, decision, perspective, meId } = props;

  if (message.role === 'SYSTEM') {
    return <p className="text-center text-xs text-slate-500">{message.content}</p>;
  }

  const own = perspective === 'employee' ? message.role === 'EMPLOYEE' : message.role !== 'EMPLOYEE';
  const time = formatTime(message.createdAt);

  if (message.role === 'EMPLOYEE') {
    return (
      <Row own={own}>
        <Bubble tone={perspective === 'employee' ? 'dark' : 'light'} time={time}>
          {message.content}
        </Bubble>
      </Row>
    );
  }

  if (message.role === 'ANALYST') {
    const label = message.authorId === meId ? 'Você' : 'Analista do suporte';
    return (
      <Row own={own}>
        <div className={cx('flex max-w-[min(36rem,90%)] flex-col gap-1', own ? 'items-end' : 'items-start')}>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <Icons.headset className="size-3.5 text-emerald-600" /> {label}
          </span>
          <Bubble tone="green" time={time}>
            {message.content}
          </Bubble>
        </div>
      </Row>
    );
  }

  // Mensagem do agente: ações executadas em cima, texto e blocos em seguida.
  const steps: AgentStep[] = decision?.steps ?? [];
  const textBlocks = message.blocks.filter((b) => b.type === 'text');
  const text = message.content.trim() || textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return (
    <Row own={own}>
      <div className={cx('flex w-full max-w-[min(40rem,100%)] flex-col gap-2', own ? 'items-end' : 'items-start')}>
        <AgentStepsLine steps={steps} {...(decision && props.actions.openDecision ? { onDetails: () => props.actions.openDecision?.(decision) } : {})} />
        {text ? (
          <Bubble tone={perspective === 'employee' ? 'light' : 'blue'} time={time}>
            {text}
          </Bubble>
        ) : null}
        {message.blocks.map((block, index) => (
          <BlockView key={`${block.type}-${index}`} block={block} {...props} />
        ))}
      </div>
    </Row>
  );
}

function BlockView({ block, choicesEnabled, draftsEnabled, draftBusy, actions, now }: MessageViewProps & { block: MessageBlock }) {
  switch (block.type) {
    case 'text':
      return null;
    case 'ticket_cards':
      return (
        <div className="flex w-full flex-col gap-2">
          {block.tickets.map((ticket) => (
            <TicketCard key={ticket.code} ticket={ticket} {...(now ? { now } : {})} />
          ))}
        </div>
      );
    case 'ticket_selection':
      return (
        <div className="flex w-full flex-col gap-1.5">
          <p className="text-sm font-medium text-slate-700">{block.prompt}</p>
          <TicketSelection prompt={block.prompt} options={block.options} disabled={!choicesEnabled || !actions.send} onSelect={(ticket: TicketSummary) => actions.send?.(`${ticket.code} · ${ticket.title}`)} />
        </div>
      );
    case 'draft':
      return (
        <div className="w-full">
          <DraftCard
            draft={block.draft}
            actionable={draftsEnabled}
            busy={draftBusy?.draftId === block.draft.id ? draftBusy.action : null}
            onConfirm={() => actions.confirmDraft?.(block.draft.id)}
            onDiscard={() => actions.discardDraft?.(block.draft.id)}
          />
        </div>
      );
    case 'quick_replies':
      return <QuickReplies options={block.options} disabled={!choicesEnabled || !actions.send} onPick={(reply) => actions.send?.(reply.value)} />;
    case 'handoff_notice':
      return (
        <p className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-900">
          <Icons.transfer className="size-3.5" /> Transferido para um analista · {HANDOFF_REASON_LABELS[block.reason]}
          {block.relatedTicketCode ? ` · ${block.relatedTicketCode}` : ''}
        </p>
      );
  }
}

export function QuickReplies({ options, disabled, onPick }: { options: QuickReply[]; disabled: boolean; onPick: (reply: QuickReply) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Respostas rápidas">
      {options.map((option) => (
        <Button key={option.id} disabled={disabled} onClick={() => onPick(option)} className="rounded-md">
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function Row({ own, children }: { own: boolean; children: ReactNode }) {
  return <div className={cx('flex w-full', own ? 'justify-end' : 'justify-start')}>{children}</div>;
}

const BUBBLE_TONES = {
  dark: 'bg-ink text-white',
  light: 'border border-slate-200 bg-white text-slate-800',
  blue: 'border border-sky-100 bg-sky-50 text-slate-800',
  green: 'border border-emerald-100 bg-emerald-50 text-slate-800',
};

function Bubble({ tone, time, children }: { tone: keyof typeof BUBBLE_TONES; time: string; children: ReactNode }) {
  return (
    <div className={cx('max-w-full rounded-xl px-3.5 py-2 text-sm shadow-sm', BUBBLE_TONES[tone])}>
      <p className="break-words whitespace-pre-line">{children}</p>
      <time className={cx('mt-0.5 block text-right text-[10px]', tone === 'dark' ? 'text-slate-300' : 'text-slate-400')}>{time}</time>
    </div>
  );
}
