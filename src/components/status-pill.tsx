export function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    paid: { label: "Pago", className: "success" },
    pending: { label: "Pendente", className: "warning" },
    late: { label: "Atrasado", className: "danger" },
    waived: { label: "Dispensado", className: "muted" },
    planned: { label: "Previsto", className: "info" },
    open: { label: "Em aberto", className: "warning" },
    cancelled: { label: "Cancelado", className: "muted" },
    active: { label: "Ativo", className: "success" },
    admin: { label: "Administrador", className: "violet" },
    viewer: { label: "Leitura", className: "info" }
  };
  const item = map[status] ?? { label: status, className: "muted" };
  return <span className={`status-pill ${item.className}`}>{item.label}</span>;
}
