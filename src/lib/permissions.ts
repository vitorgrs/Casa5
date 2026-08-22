import type { PermissionKey } from "@/lib/auth";

export const PERMISSION_CATALOG: { key: PermissionKey; label: string; description: string }[] = [
  {
    key: "manage_expenses",
    label: "Cadastrar e editar despesas",
    description: "Criar novas despesas, editar valores, categorias e a divisão entre moradores.",
  },
  {
    key: "mark_expenses_paid",
    label: "Marcar despesas como pagas",
    description: "Alterar o status de pagamento de cada parcela (pendente, pago, atrasado, dispensado) e o reembolso.",
  },
  {
    key: "view_wallet_balance",
    label: "Ver saldo do Mercado Pago",
    description: "Visualizar o saldo consolidado da conta compartilhada e o histórico de sincronizações.",
  },
  {
    key: "manage_tasks",
    label: "Gerenciar organização e calendário",
    description: "Criar, editar e apagar tarefas do calendário e da página de organização (pendências gerais).",
  },
  {
    key: "manage_members",
    label: "Gerenciar moradores",
    description: "Editar e-mail de acesso e chave PIX de cada morador.",
  },
];
