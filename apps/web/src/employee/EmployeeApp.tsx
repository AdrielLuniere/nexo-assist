import { type ConversationStatus, type User } from '@nexo/shared';
import { useEffect, useState } from 'react';
import { Avatar, Button, Icons, Logo, cx } from '../components/ui';
import { formatListTime } from '../lib/format';
import { useSession } from '../session';
import { ChatPage } from './ChatPage';
import { ProfilePage } from './ProfilePage';
import { type ChatController, useChat } from './use-chat';

type View = 'chat' | 'profile';

const LIST_STATUS: Record<ConversationStatus, string> = {
  WITH_AGENT: 'Com o assistente',
  WAITING_ANALYST: 'Aguardando atendente',
  WITH_ANALYST: 'Com um analista',
  CLOSED: 'Encerrada',
};

/** Área do funcionário: barra lateral (Atendimento, Meu perfil, conversas) e a tela escolhida. */
export function EmployeeApp({ user, retryDelays }: { user: User; retryDelays?: readonly number[] }) {
  const { client, logout } = useSession();
  const chat = useChat(client, retryDelays ? { retryDelays } : {});
  const [view, setView] = useState<View>('chat');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const sidebar = (
    <Sidebar
      user={user}
      view={view}
      chat={chat}
      onView={(next) => {
        setView(next);
        setMenuOpen(false);
      }}
      onOpenConversation={(id) => {
        chat.open(id);
        setView('chat');
        setMenuOpen(false);
      }}
      onNew={() => {
        void chat.startNew();
        setView('chat');
        setMenuOpen(false);
      }}
      onLogout={logout}
    />
  );

  return (
    <div className="flex h-dvh bg-slate-50 text-slate-900">
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white md:flex" aria-label="Navegação">
        {sidebar}
      </aside>
      {menuOpen ? (
        <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="flex w-72 max-w-[85%] bg-white shadow-xl">{sidebar}</div>
          <button type="button" className="flex-1 bg-slate-900/30" aria-label="Fechar menu" onClick={() => setMenuOpen(false)} />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {view === 'chat' ? <ChatPage chat={chat} meId={user.id} onMenu={() => setMenuOpen(true)} /> : <ProfilePage user={user} onMenu={() => setMenuOpen(true)} />}
      </div>
    </div>
  );
}

function Sidebar({
  user,
  view,
  chat,
  onView,
  onOpenConversation,
  onNew,
  onLogout,
}: {
  user: User;
  view: View;
  chat: ChatController;
  onView: (view: View) => void;
  onOpenConversation: (id: string) => void;
  onNew: () => void;
  onLogout: () => void;
}) {
  const navItem = (target: View, label: string, Icon: (typeof Icons)['chat']) => (
    <button
      type="button"
      onClick={() => onView(target)}
      aria-current={view === target ? 'page' : undefined}
      className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm', view === target ? 'bg-sky-50 font-medium text-brand' : 'text-slate-700 hover:bg-slate-50')}
    >
      <Icon /> {label}
    </button>
  );

  return (
    <div className="flex h-full w-full flex-col">
      <div className="px-4 py-4">
        <Logo />
      </div>
      <nav className="flex flex-col gap-1 px-2" aria-label="Seções">
        {navItem('chat', 'Atendimento', Icons.chat)}
        {navItem('profile', 'Meu perfil', Icons.user)}
      </nav>

      <section className="mt-4 flex min-h-0 flex-1 flex-col border-t border-slate-100 px-2 pt-3" aria-labelledby="conversas-titulo">
        <div className="flex items-center justify-between px-2">
          <h2 id="conversas-titulo" className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Conversas
          </h2>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onNew}>
            <Icons.plus className="size-3.5" /> Nova conversa
          </Button>
        </div>
        <ul className="mt-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2">
          {chat.listState === 'error' ? <li className="px-2 py-1 text-xs text-rose-700">Não foi possível carregar.</li> : null}
          {chat.listState === 'ready' && chat.conversations.length === 0 ? <li className="px-2 py-1 text-xs text-slate-500">Nenhuma conversa ainda.</li> : null}
          {chat.conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                onClick={() => onOpenConversation(conversation.id)}
                aria-current={chat.activeId === conversation.id ? 'true' : undefined}
                className={cx('flex w-full flex-col rounded-lg px-2.5 py-2 text-left', chat.activeId === conversation.id ? 'bg-slate-100' : 'hover:bg-slate-50')}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{conversation.title ?? 'Nova conversa'}</span>
                  {conversation.lastMessageAt ? <span className="shrink-0 text-[11px] text-slate-400">{formatListTime(conversation.lastMessageAt)}</span> : null}
                </span>
                <span className="text-[11px] text-slate-500">{LIST_STATUS[conversation.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="border-t border-slate-100 p-3">
        <div className="flex items-center gap-2">
          <Avatar name={user.name} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
          </div>
        </div>
        <button type="button" onClick={onLogout} className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          <Icons.logout /> Sair
        </button>
      </div>
    </div>
  );
}
