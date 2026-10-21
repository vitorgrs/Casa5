// Catálogo único de acesso. Ele é usado pela interface (menus, botões), pelas
// Server Actions e pela tela de permissões. As mesmas chaves são checadas no
// banco por public.has_permission(); ao criar uma chave nova, inclua-a também
// em public.valid_permission_keys() (migration 036).
//
// Este módulo não importa nada do servidor para poder ser usado em
// componentes cliente.

export const PERMISSION_GROUPS = [
  {
    key: "expenses",
    label: "Despesas",
    permissions: [
      {
        key: "manage_expenses",
        label: "Cadastrar e editar despesas",
        description:
          "Criar e editar despesas, valores, categorias, divisão entre moradores, boleto e comprovante geral.",
      },
      {
        key: "delete_expenses",
        label: "Excluir despesas",
        description: "Apagar uma despesa inteira, com as parcelas e anexos.",
      },
      {
        key: "mark_expenses_paid",
        label: "Marcar parcelas como pagas",
        description:
          "Alterar o status de pagamento das parcelas e dos reembolsos e anexar comprovante por outro morador.",
      },
      {
        key: "record_payments_without_receipt",
        label: "Registrar pagamento sem comprovante",
        description:
          "Confirmar pagamentos sem anexo e informar um valor pago diferente do valor da parcela.",
      },
    ],
  },
  {
    key: "finance",
    label: "Conta da casa (Mercado Pago)",
    permissions: [
      {
        key: "view_wallet_balance",
        label: "Ver saldo e extrato",
        description:
          "Ver o saldo da conta compartilhada, o histórico, o extrato e o resumo mensal.",
      },
      {
        key: "manage_wallet",
        label: "Sincronizar e conciliar a conta",
        description:
          "Sincronizar o Mercado Pago, registrar saldo manual e conciliar Pix recebidos com parcelas.",
      },
    ],
  },
  {
    key: "shopping",
    label: "Compras e organização",
    permissions: [
      {
        key: "manage_shopping",
        label: "Gerenciar lista de compras",
        description:
          "Incluir, editar e marcar itens, lançar compras, retirar itens e desfazer compras.",
      },
      {
        key: "manage_shopping_settlements",
        label: "Gerenciar acertos de compras",
        description:
          "Registrar ou confirmar pagamentos de acertos entre outros moradores e quitar saldos zerados.",
      },
      {
        key: "manage_tasks",
        label: "Gerenciar tarefas delegadas",
        description: "Criar e apagar tarefas com prazo e responsáveis.",
      },
    ],
  },
  {
    key: "house",
    label: "Casa em dia",
    permissions: [
      {
        key: "manage_daily_rotation",
        label: "Administrar escala diária",
        description:
          "Configurar a escala, editar tarefas padrão, aprovar trocas e marcar tarefas de qualquer dia.",
      },
      {
        key: "manage_laundry",
        label: "Administrar lavanderia",
        description: "Configurar o rodízio da lavanderia e as lavagens coletivas.",
      },
      {
        key: "manage_water",
        label: "Administrar galão de água",
        description:
          "Configurar o rodízio, trocar a pessoa da vez e confirmar ou revisar pagamentos do galão.",
      },
      {
        key: "manage_stove_dish",
        label: "Administrar fogão e louça",
        description:
          "Configurar a ordem do fogão (usada também no lava-louça) e trocar a pessoa da vez dos dois rodízios.",
      },
      {
        key: "manage_house_map",
        label: "Administrar mapa da casa",
        description:
          "Iniciar o mapa, configurar rodízios dos cômodos e registrar limpezas por outros moradores.",
      },
    ],
  },
  {
    key: "members",
    label: "Moradores",
    permissions: [
      {
        key: "manage_members",
        label: "Gerenciar moradores",
        description:
          "Editar e-mail, chave PIX e identificação no Mercado Pago, e vincular contas pendentes.",
      },
    ],
  },
  {
    key: "system",
    label: "Sistema",
    permissions: [
      {
        key: "manage_notifications",
        label: "Gerenciar e-mails e lembretes",
        description:
          "Alterar as preferências de lembrete e disparar manualmente os e-mails do dia e de acertos.",
      },
      {
        key: "manage_storage",
        label: "Gerenciar armazenamento",
        description: "Ver o uso do Supabase e remover arquivos sem uso.",
      },
    ],
  },
] as const;

export type PermissionKey =
  (typeof PERMISSION_GROUPS)[number]["permissions"][number]["key"];

export const PERMISSION_CATALOG: {
  key: PermissionKey;
  label: string;
  description: string;
  group: string;
}[] = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => ({ ...permission, group: group.label })),
);

export const PERMISSION_KEYS = PERMISSION_CATALOG.map((item) => item.key);

// Páginas que o administrador pode esconder. Elas ficam visíveis por padrão;
// a tela de permissões guarda somente as páginas ocultas. Rotas mais
// específicas vêm antes para que `pageForPath` escolha a mais precisa.
export const PAGE_CATALOG = [
  { key: "laundry", label: "Casa em dia • Lavanderia", href: "/app/limpeza/lavanderia" },
  { key: "water", label: "Casa em dia • Galão de água", href: "/app/limpeza/agua" },
  { key: "stove", label: "Casa em dia • Fogão", href: "/app/limpeza/fogao" },
  { key: "dish_rack", label: "Casa em dia • Lava e seca-louça", href: "/app/limpeza/louca" },
  { key: "house_map", label: "Casa em dia • Mapa da casa", href: "/app/limpeza/mapa" },
  { key: "daily_rotation_admin", label: "Casa em dia • Administrar escala", href: "/app/limpeza/rotina" },
  { key: "chores", label: "Casa em dia • Tarefas do dia", href: "/app/limpeza" },
  { key: "finance", label: "Conta da casa", href: "/app/financeiro" },
  { key: "me", label: "Minha página", href: "/app/eu" },
  { key: "expenses", label: "Despesas", href: "/app/despesas" },
  { key: "shopping", label: "Compras", href: "/app/organizacao" },
  { key: "complaints", label: "Reclamações", href: "/app/reclamacoes" },
  { key: "members", label: "Moradores", href: "/app/moradores" },
  { key: "settings", label: "Configurações", href: "/app/configuracoes" },
  { key: "overview", label: "Visão geral", href: "/app" },
] as const;

export type PageKey = (typeof PAGE_CATALOG)[number]["key"];

export const PAGE_KEYS = PAGE_CATALOG.map((page) => page.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as string[]).includes(value);
}

export function isPageKey(value: string): value is PageKey {
  return (PAGE_KEYS as string[]).includes(value);
}

export function pageForPath(pathname: string): PageKey | null {
  const page = PAGE_CATALOG.find(
    (item) =>
      pathname === item.href ||
      (item.href !== "/app" && pathname.startsWith(`${item.href}/`)),
  );
  return page?.key ?? null;
}

type AccessProfile = {
  role: "admin" | "viewer";
  permissions?: Partial<Record<string, boolean>> | null;
  hidden_pages?: readonly string[] | null;
};

export function hasPermission(profile: AccessProfile, permission: PermissionKey) {
  if (profile.role === "admin") return true;
  return profile.permissions?.[permission] === true;
}

export function canSeePage(profile: AccessProfile, page: PageKey) {
  if (profile.role === "admin") return true;
  return !(profile.hidden_pages ?? []).includes(page);
}

export function pageHref(page: PageKey) {
  return PAGE_CATALOG.find((item) => item.key === page)?.href ?? "/app";
}

// Primeira página visível, na ordem do menu, para onde levar quem tenta abrir
// uma página oculta.
export function firstVisiblePage(profile: AccessProfile) {
  const menuOrder: PageKey[] = [
    "overview",
    "me",
    "expenses",
    "chores",
    "shopping",
    "finance",
    "complaints",
    "members",
    "settings",
  ];
  const page = menuOrder.find((key) => canSeePage(profile, key));
  return page ? pageHref(page) : null;
}

// Página onde cada permissão é usada. A tela de permissões avisa quando uma
// permissão foi concedida mas a página correspondente está oculta.
export const PERMISSION_PAGE: Record<PermissionKey, PageKey> = {
  manage_expenses: "expenses",
  delete_expenses: "expenses",
  mark_expenses_paid: "expenses",
  record_payments_without_receipt: "expenses",
  view_wallet_balance: "finance",
  manage_wallet: "finance",
  manage_shopping: "shopping",
  manage_shopping_settlements: "shopping",
  manage_tasks: "shopping",
  manage_daily_rotation: "daily_rotation_admin",
  manage_laundry: "laundry",
  manage_water: "water",
  manage_stove_dish: "stove",
  manage_house_map: "house_map",
  manage_members: "members",
  manage_notifications: "settings",
  manage_storage: "settings",
};
