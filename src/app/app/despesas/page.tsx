import Link from "next/link";
import {
  CalendarIcon,
  EditIcon,
  PlusIcon,
  WalletIcon,
} from "@/components/icons";
import { StatusPill } from "@/components/status-pill";
import { AttachmentUploadForm } from "@/components/attachment-upload-form";
import { MarkPaidControl } from "@/components/mark-paid-control";
import { SubmitButton } from "@/components/submit-button";
import { can, requirePage } from "@/lib/auth";
import { todayIso } from "@/lib/chore-rotation";
import { asNumber, currency, monthLabel } from "@/lib/format";
import {
  deleteExpense,
  deleteExpenseBoleto,
  deleteExpensePaymentReceipt,
  deleteShareReceipt,
  setExpensePaymentAsAdmin,
  setPaymentStatus,
  setReimbursementStatus,
} from "./actions";
import { ExpenseForm } from "./expense-form";

type Search = { month?: string; novo?: string; success?: string };

function validMonth(value?: string) {
  if (value && /^\d{4}-\d{2}$/.test(value)) return value;
  // O mês atual segue o fuso da casa, não o UTC do servidor.
  const current = todayIso().slice(0, 7);
  return current < "2026-08" ? "2026-08" : current;
}

function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00`);
  date.setMonth(date.getMonth() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const selectedMonth = validMonth(params.month);
  const baseRoute = `/app/despesas?month=${selectedMonth}`;
  const { profile, supabase } = await requirePage("expenses");
  const canManageExpenses = can(profile, "manage_expenses");
  const canMarkPaid = can(profile, "mark_expenses_paid");
  const [{ data: members }, { data: expenses }] = await Promise.all([
    supabase
      .from("household_members")
      .select("id,name,initials,color_key")
      .eq("household_id", profile.household_id)
      .eq("active", true)
      .order("display_order"),
    supabase
      .from("expenses")
      .select(
        "id,title,category,description,reference_month,due_date,amount,estimated,split_mode,status,recurrence,has_reimbursement,reimbursement_amount,boleto_path,boleto_name,payment_receipt_path,payment_receipt_name,expense_shares(id,member_id,amount,paid_amount,payment_status,paid_at,reimbursement_status,reimbursement_paid_at,receipt_path,receipt_name,member:household_members(id,name,initials,color_key))",
      )
      .eq("household_id", profile.household_id)
      .eq("reference_month", `${selectedMonth}-01`)
      .order("due_date", { ascending: true, nullsFirst: false }),
  ]);

  const total = (expenses ?? []).reduce(
    (sum, expense) => sum + asNumber(expense.amount),
    0,
  );
  const paid = (expenses ?? [])
    .flatMap((expense) => expense.expense_shares ?? [])
    .filter((share) => share.payment_status === "paid")
    .reduce(
      (sum, share) => sum + asNumber(share.paid_amount ?? share.amount),
      0,
    );

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Controle financeiro</span>
          <h1>Despesas da casa</h1>
          <p>
            Cadastre previsões, divida valores e acompanhe o pagamento de cada
            morador.
          </p>
        </div>
        <div className="page-actions">
          <div className="month-nav">
            <Link href={`/app/despesas?month=${shiftMonth(selectedMonth, -1)}`}>
              ‹
            </Link>
            <strong>
              {monthLabel.format(new Date(`${selectedMonth}-01T00:00:00`))}
            </strong>
            <Link href={`/app/despesas?month=${shiftMonth(selectedMonth, 1)}`}>
              ›
            </Link>
          </div>
          {canManageExpenses && (
            <Link
              className="button primary"
              href={`/app/despesas?month=${selectedMonth}&novo=1`}
            >
              <PlusIcon /> Nova despesa
            </Link>
          )}
        </div>
      </div>

      {params.success && <div className="message success">{params.success}</div>}

      {can(profile, "record_payments_without_receipt") && (
        <div className="message info">
          Com a sua permissão, você pode informar o valor recebido e marcar a
          parcela como paga mesmo sem comprovante. O anexo continua opcional.
        </div>
      )}

      <div className="grid cols-3">
        <div className="card metric-card">
          <div className="metric-top">
            <span>Total previsto</span>
            <span className="metric-icon">
              <WalletIcon />
            </span>
          </div>
          <strong className="metric-value">{currency.format(total)}</strong>
          <span className="metric-foot">
            {expenses?.length ?? 0} despesas no mês
          </span>
        </div>
        <div className="card metric-card">
          <div className="metric-top">
            <span>Já recebido</span>
            <span className="metric-icon">
              <WalletIcon />
            </span>
          </div>
          <strong className="metric-value">{currency.format(paid)}</strong>
          <span className="metric-foot good">
            {total ? Math.round((paid / total) * 100) : 0}% do total
          </span>
        </div>
        <div className="card metric-card">
          <div className="metric-top">
            <span>Falta receber</span>
            <span className="metric-icon">
              <CalendarIcon />
            </span>
          </div>
          <strong className="metric-value">
            {currency.format(Math.max(0, total - paid))}
          </strong>
          <span className="metric-foot warn">
            Acompanhe os status individuais
          </span>
        </div>
      </div>

      {params.novo === "1" && canManageExpenses && (
        <section className="card pad" style={{ marginTop: 16 }}>
          <div
            className="card-head"
            style={{ padding: 0, paddingBottom: 16, marginBottom: 18 }}
          >
            <h2>Adicionar nova despesa</h2>
            <Link href={baseRoute} className="button ghost small">
              Fechar
            </Link>
          </div>
          <ExpenseForm
            members={members ?? []}
            defaultMonth={selectedMonth}
            redirectTo={baseRoute}
            cancelHref={baseRoute}
          />
        </section>
      )}

      <div className="grid" style={{ marginTop: 16 }}>
        {(expenses ?? []).map((expense) => {
          const shares = expense.expense_shares ?? [];
          const paidShares = shares.filter(
            (share) => share.payment_status === "paid",
          ).length;
          return (
            <article className="card expense-card" key={expense.id}>
              <div className="expense-main">
                <div className="expense-title-group">
                  <div className="category-icon">
                    <WalletIcon />
                  </div>
                  <div>
                    <h3>{expense.title}</h3>
                    <p>
                      {expense.category} •{" "}
                      {expense.split_mode === "equal"
                        ? "divisão igual"
                        : "divisão personalizada"}
                      {expense.estimated ? " • estimativa" : ""}
                    </p>
                  </div>
                </div>
                <div className="item-value">
                  <small>Valor</small>
                  <strong>
                    {expense.amount === null
                      ? "A definir"
                      : currency.format(asNumber(expense.amount))}
                  </strong>
                </div>
                <div className="item-value">
                  <small>Vencimento</small>
                  <strong>
                    {expense.due_date
                      ? new Date(
                          `${expense.due_date}T00:00:00`,
                        ).toLocaleDateString("pt-BR")
                      : "A definir"}
                  </strong>
                </div>
                <div>
                  <StatusPill status={expense.status} />
                </div>
              </div>
              {shares.length > 0 ? (
                <div className="expense-shares">
                  {shares.map((share) => {
                    const member = Array.isArray(share.member)
                      ? share.member[0]
                      : share.member;
                    const isPaid = share.payment_status === "paid";
                    const paidAmount = asNumber(share.paid_amount ?? share.amount);
                    return (
                      <div className="share-card" key={share.id}>
                        <div className="share-card-top">
                          <div
                            className={`avatar avatar-${member?.color_key ?? "violet"}`}
                          >
                            {member?.initials ?? "?"}
                          </div>
                          <div>
                            <strong>{member?.name ?? "Morador"}</strong>
                            <small>
                              {currency.format(asNumber(share.amount))}
                            </small>
                          </div>
                        </div>
                        <div className="share-actions">
                          <StatusPill status={share.payment_status} />
                          {isPaid && (
                            <span className="admin-paid-amount">
                              Pago: {currency.format(paidAmount)}
                            </span>
                          )}
                          {can(profile, "record_payments_without_receipt") ? (
                            <div className="admin-expense-payment-control">
                              <form action={setExpensePaymentAsAdmin}>
                                <input type="hidden" name="share_id" value={share.id} />
                                <input type="hidden" name="status" value="paid" />
                                <input type="hidden" name="redirect_to" value={baseRoute} />
                                <label>
                                  Valor pago
                                  <input
                                    type="number"
                                    name="paid_amount"
                                    min="0.01"
                                    max={asNumber(share.amount).toFixed(2)}
                                    step="0.01"
                                    defaultValue={paidAmount.toFixed(2)}
                                    inputMode="decimal"
                                    required
                                  />
                                </label>
                                <SubmitButton
                                  className="button primary small"
                                  pendingLabel="Registrando..."
                                >
                                  {isPaid ? "Atualizar valor" : "Marcar como pago"}
                                </SubmitButton>
                              </form>
                              {isPaid && (
                                <form action={setExpensePaymentAsAdmin}>
                                  <input type="hidden" name="share_id" value={share.id} />
                                  <input type="hidden" name="status" value="pending" />
                                  <input type="hidden" name="redirect_to" value={baseRoute} />
                                  <SubmitButton
                                    className="button ghost small"
                                    pendingLabel="Desfazendo..."
                                  >
                                    Desfazer
                                  </SubmitButton>
                                </form>
                              )}
                              <small>Comprovante opcional para o administrador.</small>
                            </div>
                          ) : canMarkPaid ? (
                            <MarkPaidControl
                              action={setPaymentStatus}
                              shareId={share.id}
                              redirectTo={baseRoute}
                              hasReceipt={Boolean(share.receipt_path)}
                              isPaid={isPaid}
                            />
                          ) : null}
                        </div>
                        <div style={{ marginTop: 8 }}>
                          {share.receipt_path ? (
                            <div className="attachment-row">
                              <span>📎 {share.receipt_name ?? "comprovante"}</span>
                              <a
                                href={`/app/despesas/anexos/parcela/${share.id}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Ver
                              </a>
                              {(profile.member_id === share.member_id || canManageExpenses) &&
                                share.payment_status !== "paid" && (
                                <form action={deleteShareReceipt}>
                                  <input type="hidden" name="share_id" value={share.id} />
                                  <input type="hidden" name="redirect_to" value={baseRoute} />
                                  <button className="button ghost small" type="submit">
                                    Remover
                                  </button>
                                </form>
                              )}
                            </div>
                          ) : (
                            (profile.member_id === share.member_id || canManageExpenses || canMarkPaid) && (
                              <AttachmentUploadForm
                                target={{ kind: "share_receipt", id: share.id }}
                                label="Anexar comprovante"
                              />
                            )
                          )}
                        </div>
                        {share.reimbursement_status !== "not_applicable" && (
                          <div className="share-actions" style={{ marginTop: 6 }}>
                            <span
                              className={`status-pill ${share.reimbursement_status === "paid" ? "success" : "warn"}`}
                            >
                              Reembolso {share.reimbursement_status === "paid" ? "pago" : "pendente"}
                            </span>
                            {canMarkPaid && (
                              <form action={setReimbursementStatus}>
                                <input type="hidden" name="share_id" value={share.id} />
                                <input
                                  type="hidden"
                                  name="status"
                                  value={share.reimbursement_status === "paid" ? "pending" : "paid"}
                                />
                                <input type="hidden" name="redirect_to" value={baseRoute} />
                                <button className="button ghost small" type="submit">
                                  {share.reimbursement_status === "paid" ? "Desfazer reembolso" : "Marcar reembolso pago"}
                                </button>
                              </form>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">
                  A divisão individual ainda não foi definida.
                </div>
              )}
              <div style={{ padding: "0 20px 14px" }}>
                {expense.boleto_path ? (
                  <div className="attachment-row">
                    <span>📄 Boleto: {expense.boleto_name ?? "arquivo"}</span>
                    <a
                      href={`/app/despesas/anexos/boleto/${expense.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ver
                    </a>
                    {canManageExpenses && (
                      <form action={deleteExpenseBoleto}>
                        <input type="hidden" name="expense_id" value={expense.id} />
                        <input type="hidden" name="redirect_to" value={baseRoute} />
                        <button className="button ghost small" type="submit">
                          Remover
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                  canManageExpenses && (
                    <AttachmentUploadForm
                      target={{ kind: "expense_boleto", id: expense.id }}
                      label="Anexar boleto da despesa"
                    />
                  )
                )}
              </div>
              <div style={{ padding: "0 20px 14px" }}>
                {expense.payment_receipt_path ? (
                  <div className="attachment-row">
                    <span>
                      ✅ Comprovante do pagamento total: {expense.payment_receipt_name ?? "arquivo"}
                    </span>
                    <a
                      href={`/app/despesas/anexos/comprovante-geral/${expense.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ver
                    </a>
                    {canManageExpenses && (
                      <form action={deleteExpensePaymentReceipt}>
                        <input type="hidden" name="expense_id" value={expense.id} />
                        <input type="hidden" name="redirect_to" value={baseRoute} />
                        <button className="button ghost small" type="submit">
                          Remover
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                  canManageExpenses && (
                    <AttachmentUploadForm
                      target={{
                        kind: "expense_payment_receipt",
                        id: expense.id,
                      }}
                      label="Anexar comprovante do pagamento total"
                    />
                  )
                )}
              </div>
              <div style={{ padding: "0 20px 14px" }}>
                <div className="progress-track">
                  <span
                    style={{
                      width: `${shares.length ? (paidShares / shares.length) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="progress-label">
                  <span>
                    {paidShares} de {shares.length} pagamentos confirmados
                  </span>
                  <span>
                    {shares.length
                      ? Math.round((paidShares / shares.length) * 100)
                      : 0}
                    %
                  </span>
                </div>
              </div>
              {canManageExpenses && (
                <details className="details-editor">
                  <summary>
                    <EditIcon
                      style={{ verticalAlign: "middle", marginRight: 7 }}
                    />{" "}
                    Editar despesa e divisão
                  </summary>
                  <div className="editor-body">
                    <ExpenseForm
                      members={members ?? []}
                      defaultMonth={selectedMonth}
                      expense={expense as never}
                      redirectTo={baseRoute}
                      cancelHref={baseRoute}
                    />
                    {can(profile, "delete_expenses") && (
                      <form action={deleteExpense} style={{ marginTop: 12 }}>
                        <input
                          type="hidden"
                          name="expense_id"
                          value={expense.id}
                        />
                        <input
                          type="hidden"
                          name="redirect_to"
                          value={baseRoute}
                        />
                        <SubmitButton className="button danger small" pendingLabel="Excluindo...">
                          Excluir despesa
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                </details>
              )}
            </article>
          );
        })}
        {(expenses ?? []).length === 0 && (
          <div className="card empty">
            Nenhuma despesa cadastrada para este mês.
          </div>
        )}
      </div>
    </>
  );
}
