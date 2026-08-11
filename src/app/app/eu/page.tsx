import Link from "next/link";
import { AttachmentUploadForm } from "@/components/attachment-upload-form";
import { StatusPill } from "@/components/status-pill";
import { CalendarIcon, ChecklistIcon, UsersIcon, WalletIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { asNumber, currency, monthLabel } from "@/lib/format";
import { signedReceiptUrl } from "@/lib/storage";
import { uploadShoppingShareReceipt } from "@/app/app/organizacao/actions";

export default async function MyPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string }>;
}) {
  const params = await searchParams;
  const { profile, supabase } = await requireActiveProfile();

  if (!profile.member_id) {
    return (
      <div className="card pad">
        <div className="empty">
          Seu usuário ainda não está vinculado a um morador da casa. Peça ao
          administrador para te vincular em Moradores.
        </div>
      </div>
    );
  }

  const memberId = profile.member_id;
  const currentMonth = new Date();
  const monthsBack = 5;
  const months = Array.from({ length: monthsBack + 1 }, (_, i) => {
    const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - (monthsBack - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  });

  const [
    { data: shares },
    { data: reimbursements },
    { data: choreRotation },
    { data: myTasks },
    { data: shoppingShares },
    { data: shoppingPaidByMe },
  ] = await Promise.all([
    supabase
      .from("expense_shares")
      .select(
        "id,amount,payment_status,paid_at,expense:expenses(id,title,category,due_date,reference_month)",
      )
      .eq("member_id", memberId)
      .gte("expense.reference_month", months[0])
      .order("id"),
    supabase
      .from("expense_shares")
      .select("id,reimbursement_status,expense:expenses(id,title,reimbursement_amount)")
      .eq("member_id", memberId)
      .neq("reimbursement_status", "not_applicable"),
    supabase
      .from("chore_assignments")
      .select("id,active,chore:chores(id,title,frequency,points,active)")
      .eq("member_id", memberId)
      .eq("active", true),
    supabase
      .from("task_assignees")
      .select("id,done,task:tasks(id,title,description,due_date,scope)")
      .eq("member_id", memberId)
      .order("id"),
    supabase
      .from("shopping_item_shares")
      .select(
        "id,amount,payment_status,paid_at,receipt_path,receipt_name,receipt_uploaded_at,item:shopping_items(id,name,category,bought_at,paid_by_member_id,paid_by:household_members!shopping_items_paid_by_member_id_fkey(id,name,pix_key))",
      )
      .eq("member_id", memberId)
      .order("created_at", { ascending: false }),
    supabase
      .from("shopping_items")
      .select("id,shopping_item_shares(member_id,amount,payment_status)")
      .eq("paid_by_member_id", memberId)
      .eq("status", "bought"),
  ]);

  const shareRows = (shares ?? []).filter((s) => s.expense);
  const grouped = new Map<string, typeof shareRows>();
  for (const share of shareRows) {
    const expense = Array.isArray(share.expense) ? share.expense[0] : share.expense;
    const key = expense?.reference_month ?? "sem-mes";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(share);
  }
  const sortedMonths = Array.from(grouped.keys()).sort().reverse();

  const unpaid = shareRows.filter((s) => !["paid", "waived"].includes(s.payment_status));
  const myShoppingShares = await Promise.all(
    (shoppingShares ?? [])
      .filter((share) => {
        const item = Array.isArray(share.item) ? share.item[0] : share.item;
        return item && item.paid_by_member_id !== memberId;
      })
      .map(async (share) => ({
        ...share,
        receipt_url: await signedReceiptUrl(supabase, share.receipt_path),
      })),
  );
  const unpaidShoppingShares = myShoppingShares.filter(
    (share) => !["paid", "waived"].includes(share.payment_status),
  );
  const totalUnpaid =
    unpaid.reduce((sum, s) => sum + asNumber(s.amount), 0)
    + unpaidShoppingShares.reduce((sum, share) => sum + asNumber(share.amount), 0);
  const totalUnpaidCount = unpaid.length + unpaidShoppingShares.length;
  const pendingReimbursements = (reimbursements ?? []).filter((r) => r.reimbursement_status === "pending");
  const pendingShoppingReceivables = (shoppingPaidByMe ?? [])
    .flatMap((item) => item.shopping_item_shares ?? [])
    .filter((share) => share.member_id !== memberId && share.payment_status !== "paid");
  const pendingReceivableCount = pendingReimbursements.length + pendingShoppingReceivables.length;

  const openTasks = (myTasks ?? []).filter((t) => !t.done && t.task);
  const casaTasks = openTasks.filter((t) => {
    const task = Array.isArray(t.task) ? t.task[0] : t.task;
    return task?.scope === "casa";
  });
  const geralTasks = openTasks.filter((t) => {
    const task = Array.isArray(t.task) ? t.task[0] : t.task;
    return task?.scope === "geral";
  });

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Minha página</span>
          <h1>Olá, {profile.full_name.split(" ")[0]}!</h1>
          <p>Um resumo só seu: despesas, reembolsos e tarefas designadas a você.</p>
        </div>
      </div>

      {params.success && <div className="message success">{params.success}</div>}

      <div className="grid cols-3">
        <div className="card metric-card">
          <div className="metric-top">
            <span>Você deve (não pago)</span>
            <span className="metric-icon"><WalletIcon /></span>
          </div>
          <strong className="metric-value">{currency.format(totalUnpaid)}</strong>
          <span className="metric-foot warn">{totalUnpaidCount} parcela(s) em aberto</span>
        </div>
        <div className="card metric-card">
          <div className="metric-top">
            <span>Reembolsos a receber</span>
            <span className="metric-icon"><WalletIcon /></span>
          </div>
          <strong className="metric-value">{pendingReceivableCount}</strong>
          <span className="metric-foot">pendente(s) de pagamento</span>
        </div>
        <div className="card metric-card">
          <div className="metric-top">
            <span>Tarefas em aberto</span>
            <span className="metric-icon"><ChecklistIcon /></span>
          </div>
          <strong className="metric-value">{casaTasks.length + geralTasks.length}</strong>
          <span className="metric-foot">no calendário e na organização</span>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Compras que você precisa reembolsar</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                Faça o Pix para quem pagou e envie o comprovante por aqui.
              </span>
            </div>
            <WalletIcon />
          </div>
          <div className="purchase-list">
            {myShoppingShares.length === 0 && (
              <div className="empty">Você não possui débitos de compras.</div>
            )}
            {myShoppingShares.map((share) => {
              const item = Array.isArray(share.item) ? share.item[0] : share.item;
              const paidBy = Array.isArray(item?.paid_by) ? item?.paid_by[0] : item?.paid_by;
              const hasReceipt = Boolean(share.receipt_path);
              const isConfirmed = share.payment_status === "paid";
              return (
                <article className="purchase-card" key={share.id}>
                  <div className="purchase-summary personal-purchase-summary">
                    <div className="item-title">
                      <strong>{item?.name ?? "Compra"}</strong>
                      <small>
                        {item?.category ?? "Sem categoria"}
                        {item?.bought_at ? ` • ${new Date(item.bought_at).toLocaleDateString("pt-BR")}` : ""}
                      </small>
                    </div>
                    <div className="item-value">
                      <strong>{currency.format(asNumber(share.amount))}</strong>
                      <small>você deve</small>
                    </div>
                    <span className={`status-pill ${isConfirmed ? "success" : hasReceipt ? "info" : "warning"}`}>
                      {isConfirmed ? "Quitado" : hasReceipt ? "Comprovante enviado" : "PIX pendente"}
                    </span>
                  </div>
                  <div className="purchase-payer">
                    <div>
                      <span>Enviar para</span>
                      <strong>{paidBy?.name ?? "Pagador não informado"}</strong>
                    </div>
                    <div>
                      <span>Chave PIX</span>
                      <strong>{paidBy?.pix_key ?? "Chave PIX não cadastrada"}</strong>
                    </div>
                  </div>
                  {!isConfirmed && !hasReceipt && (
                    <div style={{ padding: "4px 16px 14px" }}>
                      <AttachmentUploadForm
                        action={uploadShoppingShareReceipt}
                        hiddenFields={{ share_id: share.id }}
                        redirectTo="/app/eu"
                        label="Enviar comprovante"
                      />
                    </div>
                  )}
                  {hasReceipt && share.receipt_url && (
                    <div style={{ padding: "12px 16px" }}>
                      <div className="attachment-row">
                        <a href={share.receipt_url} target="_blank" rel="noreferrer">
                          Ver {share.receipt_name ?? "comprovante enviado"}
                        </a>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Suas despesas por mês</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                As parcelas ainda não pagas aparecem destacadas.
              </span>
            </div>
            <WalletIcon />
          </div>
          <div className="list">
            {sortedMonths.length === 0 && <div className="empty">Nenhuma despesa encontrada nos últimos meses.</div>}
            {sortedMonths.map((month) => {
              const rows = grouped.get(month)!;
              return (
                <div key={month} style={{ padding: "10px 20px" }}>
                  <strong style={{ fontSize: 13 }}>
                    {monthLabel.format(new Date(`${month}T00:00:00`))}
                  </strong>
                  <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                    {rows.map((share) => {
                      const expense = Array.isArray(share.expense) ? share.expense[0] : share.expense;
                      const isUnpaid = !["paid", "waived"].includes(share.payment_status);
                      return (
                        <div
                          className="list-row"
                          key={share.id}
                          style={isUnpaid ? { borderColor: "rgba(248,113,113,0.35)" } : undefined}
                        >
                          <div className="item-title">
                            <strong>{expense?.title ?? "Despesa"}</strong>
                            <small>{expense?.category}</small>
                          </div>
                          <div className="item-value">
                            <strong>{currency.format(asNumber(share.amount))}</strong>
                            <small>valor</small>
                          </div>
                          <div className="item-value">
                            <strong>
                              {expense?.due_date
                                ? new Date(`${expense.due_date}T00:00:00`).toLocaleDateString("pt-BR")
                                : "—"}
                            </strong>
                            <small>vencimento</small>
                          </div>
                          <StatusPill status={share.payment_status} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Suas tarefas de casa</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                Vindas do calendário do Casa em dia.
              </span>
            </div>
            <CalendarIcon />
          </div>
          <div className="list">
            {casaTasks.length === 0 && <div className="empty">Nenhuma tarefa de casa pendente para você.</div>}
            {casaTasks.map((t) => {
              const task = Array.isArray(t.task) ? t.task[0] : t.task;
              return (
                <div className="list-row" key={t.id}>
                  <div className="item-title">
                    <strong>{task?.title}</strong>
                    <small>{task?.description ?? ""}</small>
                  </div>
                  <div className="item-value">
                    <strong>
                      {task?.due_date ? new Date(`${task.due_date}T00:00:00`).toLocaleDateString("pt-BR") : "sem data"}
                    </strong>
                    <small>data</small>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: "0 20px 16px" }}>
            <Link className="button ghost small" href="/app/limpeza">
              Ver calendário completo
            </Link>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Suas pendências gerais</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                Tarefas delegadas a você na Organização (inclui pedidos de reembolso).
              </span>
            </div>
            <UsersIcon />
          </div>
          <div className="list">
            {geralTasks.length === 0 && <div className="empty">Nenhuma pendência geral para você.</div>}
            {geralTasks.map((t) => {
              const task = Array.isArray(t.task) ? t.task[0] : t.task;
              return (
                <div className="list-row" key={t.id}>
                  <div className="item-title">
                    <strong>{task?.title}</strong>
                    <small>{task?.description ?? ""}</small>
                  </div>
                  <div className="item-value">
                    <strong>
                      {task?.due_date ? new Date(`${task.due_date}T00:00:00`).toLocaleDateString("pt-BR") : "sem prazo"}
                    </strong>
                    <small>prazo</small>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: "0 20px 16px" }}>
            <Link className="button ghost small" href="/app/organizacao">
              Ver organização completa
            </Link>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Suas responsabilidades fixas</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                Tarefas de rodízio do Casa em dia em que você participa.
              </span>
            </div>
            <ChecklistIcon />
          </div>
          <div className="list">
            {(choreRotation ?? []).length === 0 && <div className="empty">Você não está em nenhum rodízio ativo.</div>}
            {(choreRotation ?? []).map((c) => {
              const chore = Array.isArray(c.chore) ? c.chore[0] : c.chore;
              if (!chore?.active) return null;
              return (
                <div className="list-row" key={c.id}>
                  <div className="item-title">
                    <strong>{chore?.title}</strong>
                    <small>{chore?.frequency}</small>
                  </div>
                  <div className="item-value">
                    <strong>{chore?.points}</strong>
                    <small>pontos</small>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </>
  );
}
