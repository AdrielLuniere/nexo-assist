import type {
  ActorType,
  AffectedScope,
  TicketCategory,
  TicketEventType,
  TicketPriority,
  TicketStatus,
  TicketType,
} from '@nexo/shared';
import { computeSlaDueAt } from '@nexo/ticket-service';

/**
 * Dados de exemplo (Anexo B). Todos fictícios.
 *
 * Determinismo: ids, códigos, textos e relações são fixos. Os instantes são definidos como
 * "há N horas/dias" em relação a `now`, então fixar `now` (SEED_NOW) reproduz o conjunto exato.
 * Os prazos usam a mesma regra do serviço (`computeSlaDueAt`), o que mantém os dados coerentes.
 */

export const SEED_PASSWORD_NOTE = 'O login aceita qualquer senha para os usuários cadastrados (PRD, Tela 1).';

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  role: 'EMPLOYEE' | 'ANALYST';
  analystLevel: 'N1' | 'N2' | null;
  department: string;
}

export interface SeedHelpArticle {
  id: string;
  slug: string;
  title: string;
  body: string;
  category: TicketCategory | null;
  tags: string[];
}

export interface SeedTicket {
  id: string;
  code: string;
  type: TicketType;
  title: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  affectedScope: AffectedScope;
  affectedDescription: string;
  requesterId: string;
  slaDueAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeedTicketEvent {
  id: string;
  ticketId: string;
  type: TicketEventType;
  actorType: ActorType;
  actorId: string | null;
  comment: string | null;
  createdAt: Date;
}

export interface SeedData {
  users: SeedUser[];
  helpArticles: SeedHelpArticle[];
  tickets: SeedTicket[];
  events: SeedTicketEvent[];
  /** Último número usado por tipo (o próximo chamado continua daqui). */
  sequences: Record<TicketType, number>;
}

export const USERS: readonly SeedUser[] = [
  { id: 'usr_ana_souza', email: 'ana.souza@nexo.com.br', name: 'Ana Souza', role: 'EMPLOYEE', analystLevel: null, department: 'Marketing' },
  { id: 'usr_bruno_lima', email: 'bruno.lima@nexo.com.br', name: 'Bruno Lima', role: 'EMPLOYEE', analystLevel: null, department: 'Comercial' },
  { id: 'usr_carla_mendes', email: 'carla.mendes@nexo.com.br', name: 'Carla Mendes', role: 'EMPLOYEE', analystLevel: null, department: 'Jurídico' },
  { id: 'usr_diego_ferreira', email: 'diego.ferreira@nexo.com.br', name: 'Diego Ferreira', role: 'EMPLOYEE', analystLevel: null, department: 'Engenharia' },
  { id: 'usr_elisa_rocha', email: 'elisa.rocha@nexo.com.br', name: 'Elisa Rocha', role: 'EMPLOYEE', analystLevel: null, department: 'Operações' },
  { id: 'usr_marcos_oliveira', email: 'marcos.oliveira@nexo.com.br', name: 'Marcos Oliveira', role: 'ANALYST', analystLevel: 'N1', department: 'Service Desk de TI' },
  { id: 'usr_paula_santos', email: 'paula.santos@nexo.com.br', name: 'Paula Santos', role: 'ANALYST', analystLevel: 'N2', department: 'Service Desk de TI' },
];

export const HELP_ARTICLES: readonly SeedHelpArticle[] = [
  {
    id: 'kb_vpn_erro_809',
    slug: 'vpn-erro-809',
    title: 'VPN com erro 809',
    body: 'VPN com erro 809: reinstale o cliente de VPN pelo portal de softwares e reinicie o computador. Vale apenas para Windows 10; no Windows 11, abra um chamado.',
    category: 'NETWORK_VPN',
    tags: ['vpn', 'erro 809', 'windows 10', 'windows 11', 'conexão remota'],
  },
  {
    id: 'kb_horario_service_desk',
    slug: 'horario-service-desk',
    title: 'Horário do service desk',
    body: 'Horário do service desk: de segunda a sexta, das 8h às 18h. Chamados críticos têm plantão 24 horas.',
    category: 'OTHER',
    tags: ['horário', 'plantão', 'atendimento', 'service desk'],
  },
  {
    id: 'kb_desbloquear_conta',
    slug: 'desbloquear-conta-e-redefinir-senha',
    title: 'Conta bloqueada ou senha esquecida',
    body: 'Para redefinir a senha, acesse o portal de autoatendimento (senha.nexo.com.br) e valide sua identidade pelo aplicativo autenticador. A conta é desbloqueada na hora. Se o autenticador não estiver disponível, abra um chamado de acesso.',
    category: 'ACCESS',
    tags: ['senha', 'conta bloqueada', 'sap', 'redefinir', 'login'],
  },
  {
    id: 'kb_mfa_novo_celular',
    slug: 'autenticador-novo-celular',
    title: 'Troquei de celular: como migrar o autenticador',
    body: 'Antes de trocar de celular, instale o aplicativo autenticador no aparelho novo e use "Transferir contas" no antigo. Se o aparelho antigo já foi perdido ou resetado, abra uma requisição de acesso: o service desk valida sua identidade e libera um novo cadastro.',
    category: 'ACCESS',
    tags: ['autenticador', 'mfa', 'celular', 'dois fatores'],
  },
  {
    id: 'kb_wifi_corporativo',
    slug: 'wifi-corporativo',
    title: 'Wi-Fi corporativo não conecta',
    body: 'Esqueça a rede "Nexo-Corp" nas configurações de Wi-Fi e conecte de novo com seu e-mail corporativo e senha. Se a senha foi alterada há pouco, aguarde 15 minutos para a sincronização. Persistindo, abra um chamado informando o andar e o aparelho.',
    category: 'NETWORK_VPN',
    tags: ['wifi', 'rede', 'internet', 'nexo-corp'],
  },
  {
    id: 'kb_solicitar_software',
    slug: 'solicitar-software-ou-licenca',
    title: 'Como pedir um software ou licença',
    body: 'Softwares do catálogo (Office, Adobe Acrobat, Teams, navegador) são instalados pelo portal de softwares, sem chamado. Para um programa fora do catálogo, abra uma requisição com o nome do software, a justificativa e a aprovação do gestor.',
    category: 'SOFTWARE',
    tags: ['software', 'licença', 'instalar', 'portal de softwares', 'adobe'],
  },
  {
    id: 'kb_outlook_sincronizacao',
    slug: 'outlook-nao-sincroniza',
    title: 'Outlook não sincroniza e-mails',
    body: 'Verifique se o Outlook está em "Trabalhar offline" (aba Enviar/Receber). Feche e abra o aplicativo e confira o espaço da caixa postal (limite de 50 GB). Se continuar sem receber e-mails, abra um chamado de E-mail informando desde quando acontece.',
    category: 'EMAIL',
    tags: ['outlook', 'e-mail', 'sincronização', 'caixa postal'],
  },
  {
    id: 'kb_notebook_lento',
    slug: 'notebook-lento',
    title: 'Notebook lento',
    body: 'Reinicie o notebook (desligar e ligar, não apenas fechar a tampa) e feche programas que você não usa. Confira se há atualizações do Windows pendentes. Se a lentidão persistir por mais de um dia, abra um chamado de Hardware.',
    category: 'HARDWARE',
    tags: ['notebook', 'lento', 'desempenho', 'windows'],
  },
  {
    id: 'kb_impressora',
    slug: 'impressora-nao-imprime',
    title: 'Impressora não imprime',
    body: 'Confirme se a impressora está ligada e sem papel atolado, e cancele trabalhos presos na fila de impressão. Para impressoras de rede, reinstale pelo nome que aparece na etiqueta do equipamento. Se o problema for na impressora do andar inteiro, abra um chamado.',
    category: 'HARDWARE',
    tags: ['impressora', 'imprimir', 'fila de impressão'],
  },
];

export function buildSeedData(now: Date): SeedData {
  const H = 3_600_000;
  const D = 24 * H;
  const ago = (ms: number) => new Date(now.getTime() - ms);

  interface TicketSpec {
    code: string;
    title: string;
    description: string;
    category: TicketCategory;
    priority: TicketPriority;
    status: TicketStatus;
    scope: AffectedScope;
    affected: string;
    requesterId: string;
    createdAgo: number;
    updatedAgo: number;
    /** Análise do analista, para dar histórico aos chamados em andamento. */
    analystNote?: string;
  }

  const specs: TicketSpec[] = [
    // Ana Souza: usuária principal da demonstração.
    {
      code: 'INC-20311',
      title: 'Notebook lento após atualização do Windows',
      description: 'Depois da última atualização do Windows o notebook demora muito para abrir qualquer programa e trava ao usar o Excel.',
      category: 'HARDWARE', priority: 'MEDIUM', status: 'WAITING_ANALYST', scope: 'INDIVIDUAL',
      affected: 'Somente Ana Souza', requesterId: 'usr_ana_souza', createdAgo: 8 * D, updatedAgo: 6 * D,
    },
    {
      code: 'REQ-10442',
      title: 'Segundo monitor para home office',
      description: 'Solicito um segundo monitor de 24 polegadas para uso em home office, aprovado pela gestão.',
      category: 'HARDWARE', priority: 'LOW', status: 'APPROVED', scope: 'INDIVIDUAL',
      affected: 'Somente Ana Souza', requesterId: 'usr_ana_souza', createdAgo: 10 * D, updatedAgo: 7 * D,
      analystNote: 'Aprovado pelo gestor. Aguardando separação do equipamento no estoque.',
    },
    {
      code: 'INC-20150',
      title: 'Senha do SAP bloqueada',
      description: 'Errei a senha do SAP algumas vezes e a conta foi bloqueada. Preciso acessar para fechar o mês.',
      category: 'ACCESS', priority: 'MEDIUM', status: 'RESOLVED', scope: 'INDIVIDUAL',
      affected: 'Somente Ana Souza', requesterId: 'usr_ana_souza', createdAgo: 6 * D, updatedAgo: 4 * D,
      analystNote: 'Conta desbloqueada e senha redefinida pelo portal.',
    },
    {
      code: 'INC-19980',
      title: 'VPN caindo toda hora',
      description: 'A conexão VPN cai a cada poucos minutos quando estou em home office.',
      category: 'NETWORK_VPN', priority: 'MEDIUM', status: 'RESOLVED', scope: 'INDIVIDUAL',
      affected: 'Somente Ana Souza', requesterId: 'usr_ana_souza', createdAgo: 16 * D, updatedAgo: 12 * D,
      analystNote: 'Cliente de VPN atualizado. Resolvido fora da janela de reabertura de 7 dias.',
    },
    {
      code: 'INC-20335',
      title: 'Outlook não sincroniza e-mails',
      description: 'O Outlook parou de receber novos e-mails desde o começo da manhã; o webmail funciona normalmente.',
      category: 'EMAIL', priority: 'HIGH', status: 'IN_PROGRESS', scope: 'INDIVIDUAL',
      affected: 'Somente Ana Souza', requesterId: 'usr_ana_souza', createdAgo: 1.5 * H, updatedAgo: 1 * H,
      analystNote: 'Em análise: recriando o perfil do Outlook.',
    },
    // Outros funcionários: servem para testar privacidade e a visão do console.
    {
      code: 'INC-20344',
      title: 'Sem acesso ao CRM',
      description: 'Ao entrar no CRM aparece "permissão negada" desde a troca de equipe.',
      category: 'ACCESS', priority: 'HIGH', status: 'WAITING_ANALYST', scope: 'INDIVIDUAL',
      affected: 'Somente Bruno Lima', requesterId: 'usr_bruno_lima', createdAgo: 2 * H, updatedAgo: 2 * H,
    },
    {
      code: 'INC-20290',
      title: 'VPN com erro 809',
      description: 'Não consigo conectar na VPN: aparece o erro 809 ao tentar autenticar.',
      category: 'NETWORK_VPN', priority: 'MEDIUM', status: 'RESOLVED', scope: 'INDIVIDUAL',
      affected: 'Somente Bruno Lima', requesterId: 'usr_bruno_lima', createdAgo: 5 * D, updatedAgo: 2 * D,
      analystNote: 'Cliente de VPN reinstalado. Resolvido recentemente (dentro da janela de reabertura).',
    },
    {
      code: 'REQ-10450',
      title: 'Licença do Adobe Acrobat',
      description: 'Preciso de uma licença do Adobe Acrobat para editar e assinar contratos.',
      category: 'SOFTWARE', priority: 'LOW', status: 'WAITING_ANALYST', scope: 'INDIVIDUAL',
      affected: 'Somente Carla Mendes', requesterId: 'usr_carla_mendes', createdAgo: 1 * D, updatedAgo: 1 * D,
    },
    {
      code: 'INC-20352',
      title: 'Servidor de build fora do ar',
      description: 'O servidor de build não responde e a equipe de engenharia inteira está sem conseguir publicar.',
      category: 'OTHER', priority: 'CRITICAL', status: 'WAITING_ANALYST', scope: 'TEAM',
      affected: 'Equipe de engenharia (12 pessoas)', requesterId: 'usr_diego_ferreira', createdAgo: 3 * H, updatedAgo: 3 * H,
    },
    {
      code: 'INC-20301',
      title: 'Impressora do 3º andar sem imprimir',
      description: 'A impressora do 3º andar aceita os trabalhos, mas nada sai na bandeja.',
      category: 'HARDWARE', priority: 'MEDIUM', status: 'IN_PROGRESS', scope: 'TEAM',
      affected: 'Quem usa o 3º andar', requesterId: 'usr_elisa_rocha', createdAgo: 3 * D, updatedAgo: 1 * D,
      analystNote: 'Técnico agendado para verificar o equipamento.',
    },
  ];

  const tickets: SeedTicket[] = [];
  const events: SeedTicketEvent[] = [];
  const sequences: Record<TicketType, number> = { INC: 0, REQ: 0 };

  for (const spec of specs) {
    const type: TicketType = spec.code.startsWith('INC') ? 'INC' : 'REQ';
    const number = Number(spec.code.slice(4));
    sequences[type] = Math.max(sequences[type], number);

    const id = `tkt_${spec.code.toLowerCase().replace('-', '_')}`;
    const createdAt = ago(spec.createdAgo);
    const updatedAt = ago(spec.updatedAgo);
    const resolved = spec.status === 'RESOLVED';

    tickets.push({
      id,
      code: spec.code,
      type,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      priority: spec.priority,
      status: spec.status,
      affectedScope: spec.scope,
      affectedDescription: spec.affected,
      requesterId: spec.requesterId,
      // O prazo conta da última atualização (Anexo A: vale para a primeira resposta e para cada atualização).
      slaDueAt: computeSlaDueAt(spec.priority, updatedAt),
      firstResponseAt: spec.analystNote ? updatedAt : null,
      resolvedAt: resolved ? updatedAt : null,
      closedAt: null,
      createdAt,
      updatedAt,
    });

    events.push({
      id: `evt_${id}_1`,
      ticketId: id,
      type: 'CREATED',
      actorType: 'EMPLOYEE',
      actorId: spec.requesterId,
      comment: null,
      createdAt,
    });
    if (spec.analystNote) {
      events.push({
        id: `evt_${id}_2`,
        ticketId: id,
        type: resolved || spec.status === 'APPROVED' || spec.status === 'IN_PROGRESS' ? 'STATUS_CHANGED' : 'COMMENT_ADDED',
        actorType: 'ANALYST',
        actorId: 'usr_marcos_oliveira',
        comment: spec.analystNote,
        createdAt: updatedAt,
      });
    }
  }

  return { users: [...USERS], helpArticles: [...HELP_ARTICLES], tickets, events, sequences };
}
