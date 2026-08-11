import Link from "next/link";
import { AttachmentUploadForm } from "@/components/attachment-upload-form";
import { StatusPill } from "@/components/status-pill";
import { CalendarIcon, ChecklistIcon, UsersIcon, WalletIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { asNumber, currency, monthLabel } from "@/lib/format";
import { signedReceiptUrl } from "@/lib/storage";
import {
  confirmShoppingNetPayment,
  settleZeroShoppingBalance,
  uploadShoppingNetReceipt,
} from "@/app/app/organizacao/actions";

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
      .from("shopping_purchase_shares")
      .select(
        "id,member_id,amount,payment_status,paid_at,receipt_path,receipt_name,receipt_uploaded_at,purchase:shopping_purchases(id,bought_at,paid_by_member_id,paid_by:household_members!shopping_purchases_paid_by_member_id_fkey(id,name,pix_key))",
      )
      .eq("member_id", memberId)
      .eq("payment_status", "pending")
      .order("created_at", { ascending: false }),
    supabase
      .from("shopping_purchases")
      .select("id,shopping_purchase_shares(id,member_id,amount,payment_status,receipt_path,receipt_name,receipt_uploaded_at,member:household_members(id,name,pix_key))")
      .eq("paid_by_member_id", memberId)
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
  type NetAccount = {
    memberId: string;
    memberName: string;
    pixKey: string | null;
    outgoingShares: Array<Record<string, any>>;
    incomingShares: Array<Record<string, any>>;
  };
  const accountMap = new Map<string, NetAccount>();

  for (const share of shoppingShares ?? []) {
    const purchase = Array.isArray(share.purchase) ? share.purchase[0] : share.purchase;
    const paidBy = Array.isArray(purchase?.paid_by) ? purchase?.paid_by[0] : purchase?.paid_by;
    if (!purchase || !paidBy || purchase.paid_by_member_id === memberId) continue;
    const account = accountMap.get(paidBy.id) ?? {
      memberId: paidBy.id,
      memberName: paidBy.name,
      pixKey: paidBy.pix_key,
      outgoingShares: [],
      incomingShares: [],
    };
    account.outgoingShares.push(share);
    accountMap.set(paidBy.id, account);
  }

  for (const purchase of shoppingPaidByMe ?? []) {
    for (const share of purchase.shopping_purchase_shares ?? []) {
      if (share.member_id === memberId || share.payment_status !== "pending") continue;
      const member = Array.isArray(share.member) ? share.member[0] : share.member;
      if (!member) continue;
      const account = accountMap.get(member.id) ?? {
        memberId: member.id,
        memberName: member.name,
        pixKey: member.pix_key,
        outgoingShares: [],
        incomingShares: [],
      };
      account.incomingShares.push(share);
      accountMap.set(member.id, account);
    }
  }

  const netShoppingAccounts = await Promise.all(
    Array.from(accountMap.values()).map(async (account) => {
      const grossOutgoing = account.outgoingShares.reduce(
        (sum, share) => sum + asNumber(share.amount), 0,
      );
      const grossIncoming = account.incomingShares.reduce(
        (sum, share) => sum + asNumber(share.amount), 0,
      );
      const net = Math.round((grossOutgoing - grossIncoming) * 100) / 100;
      const receiptShare = account.outgoingShares.find((share) => share.receipt_path);
      const incomingReceiptShare = account.incomingShares.find((share) => share.receipt_path);
      const representativeShare = receiptShare ?? account.outgoingShares[0];
      return {
        ...account,
        grossOutgoing,
        grossIncoming,
        net,
        representativeShare,
        receiptUrl: await signedReceiptUrl(supabase, receiptShare?.receipt_path ?? null),
        incomingReceiptShare,
        incomingReceiptUrl: await signedReceiptUrl(supabase, incomingReceiptShare?.receipt_path ?? null),
      };
    }),
  );
  const totalUnpaid =
    unpaid.reduce((sum, s) => sum + asNumber(s.amount), 0)
    + netShoppingAccounts.filter((account) => account.net > 0).reduce((sum, account) => sum + account.net, 0);
  const totalUnpaidCount = unpaid.length + netShoppingAccounts.filter((account) => account.net > 0).length;
  const pendingReimbursements = (reimbursements ?? []).filter((r) => r.reimbursement_status === "pending");
  const pendingReceivableCount = pendingReimbursements.length
    + netShoppingAccounts.filter((account) => account.net < 0).length;

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
              <h2>Acertos de compras entre moradores</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                Envie o comprovante por aqui. O recebedor só poderá marcar o
                pagamento como pago depois que o arquivo for anexado.
              </span>
            </div>
            <WalletIcon />
          </div>
          <div className="purchase-list">
            {netShoppingAccounts.length === 0 && (
              <div className="empty">Você não possui acertos de compras pendentes.</div>
            )}
            {netShoppingAccounts.map((account) => {
              const hasReceipt = Boolean(account.representativeShare?.receipt_path);
              const hasIncomingReceipt = Boolean(account.incomingReceiptShare?.receipt_path);
              const netAmount = Math.abs(account.net);
              return (
                <article className="purchase-card net-account-card" key={account.memberId}>
                  <div className="purchase-summary personal-purchase-summary">
                    <div className="item-title">
                      <strong>Acerto com {account.memberName}</strong>
                      <small>Compensação automática das dívidas nos dois sentidos</small>
                    </div>
                    <div className="item-value">
                      <strong>{currency.format(netAmount)}</strong>
                      <small>{account.net > 0 ? "você paga" : account.net < 0 ? "você recebe" : "saldo final"}</small>
                    </div>
                    <span className={`status-pill ${account.net < 0 ? hasIncomingReceipt ? "info" : "success" : account.net === 0 ? "violet" : hasReceipt ? "info" : "warning"}`}>
                      {account.net < 0 ? hasIncomingReceipt ? "Comprovante recebido" : "A receber" : account.net === 0 ? "Compensado" : hasReceipt ? "Aguardando confirmação" : "PIX pendente"}
                    </span>
                  </div>

                  <div className="netting-explanation">
                    <span>Você deve a {account.memberName}: <strong>{currency.format(account.grossOutgoing)}</strong></span>
                    <span>{account.memberName} deve a você: <strong>{currency.format(account.grossIncoming)}</strong></span>
                    <p>
                      {account.net > 0
                        ? `Como os dois possuem dívidas, subtraímos ${currency.format(account.grossIncoming)} de ${currency.format(account.grossOutgoing)}. Você só precisa pagar ${currency.format(account.net)}.`
                        : account.net < 0
                          ? `Como os dois possuem dívidas, subtraímos ${currency.format(account.grossOutgoing)} de ${currency.format(account.grossIncoming)}. ${account.memberName} só precisa pagar ${currency.format(Math.abs(account.net))} a você.`
                          : "As dívidas têm o mesmo valor e se compensam totalmente. Ninguém precisa fazer Pix."}
                    </p>
                  </div>

                  {account.net > 0 && (
                    <div className="purchase-payer">
                      <div>
                        <span>Enviar para</span>
                        <strong>{account.memberName}</strong>
                      </div>
                      <div>
                        <span>Chave PIX</span>
                        <strong>{account.pixKey ?? "Chave PIX não cadastrada"}</strong>
                      </div>
                    </div>
                  )}

                  {account.net < 0 && (
                    <div className="purchase-payer">
                      <div>
                        <span>Quem deve pagar</span>
                        <strong>{account.memberName}</strong>
                      </div>
                      <div>
                        <span>Valor líquido a receber</span>
                        <strong>{currency.format(Math.abs(account.net))}</strong>
                      </div>
                    </div>
                  )}

                  {account.net > 0 && account.representativeShare && !hasReceipt && (
                    <div style={{ padding: "4px 16px 14px" }}>
                      <AttachmentUploadForm
                        action={uploadShoppingNetReceipt}
                        hiddenFields={{ share_id: account.representativeShare.id }}
                        redirectTo="/app/eu"
                        label="Enviar comprovante do PIX"
                      />
                    </div>
                  )}

                  {hasReceipt && account.receiptUrl && (
                    <div style={{ padding: "12px 16px" }}>
                      <div className="attachment-row">
                        <a href={account.receiptUrl} target="_blank" rel="noreferrer">
                          Ver {account.representativeShare?.receipt_name ?? "comprovante enviado"}
                        </a>
                      </div>
                    </div>
                  )}

                  {account.net < 0 && hasIncomingReceipt && (
                    <div className="purchase-proof-actions" style={{ padding: "12px 16px" }}>
                      {account.incomingReceiptUrl && (
                        <div className="attachment-row">
                          <a href={account.incomingReceiptUrl} target="_blank" rel="noreferrer">
                            Ver {account.incomingReceiptShare?.receipt_name ?? "comprovante recebido"}
                          </a>
                        </div>
                      )}
                      <form action={confirmShoppingNetPayment}>
                        <input type="hidden" name="share_id" value={account.incomingReceiptShare?.id} />
                        <input type="hidden" name="redirect_to" value="/app/eu" />
                        <button className="button secondary small" type="submit">Marcar como pago</button>
                      </form>
                    </div>
                  )}

                  {account.net === 0 && (
                    <div>
                      <form action={settleZeroShoppingBalance} style={{ padding: "0 16px 14px" }}>
                        <input type="hidden" name="counterparty_member_id" value={account.memberId} />
                        <input type="hidden" name="redirect_to" value="/app/eu" />
                        <button className="button secondary small" type="submit">Quitar por compensação</button>
                      </form>
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
