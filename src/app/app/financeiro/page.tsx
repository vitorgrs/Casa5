import Link from "next/link";
import { BankIcon, CheckIcon, WalletIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { can, requirePage } from "@/lib/auth";
import { todayIso } from "@/lib/chore-rotation";
import {
  asNumber,
  currency,
  formatHouseDateTime,
  formatHouseTimestamp,
  monthLabel,
} from "@/lib/format";
import { suggestReconciliation } from "@/lib/wallet-reconciliation";
import { syncMercadoPago } from "../configuracoes/actions";
import { reconcileMovement, setMovementIgnored, undoReconciliation } from "./actions";

export const dynamic = "force-dynamic";

type Search = { mes?: string; tipo?: string; success?: string; error?: string };

type MovementRow = {
  id: string;
  occurred_at: string;
  record_type: string | null;
  description: string | null;
  payment_method: string | null;
  net_credit: number | string;
  net_debit: number | string;
  balance_after: number | string | null;
  payer_name: string | null;
  payer_email: string | null;
  payer_document: string | null;
  payer_lookup_status: string;
  ignored: boolean;
};

type LinkRow = { movement_id: string; share_id: string; amount: number | string };

type OpenShareRow = {
  id: string;
  amount: number | string;
  member_id: string;
  payment_status: string;
  expense: { title: string; due_date: string | null; reference_month: string } | null;
};

const MONTHS_OF_HISTORY = 6;
const RECONCILE_WINDOW_DAYS = 60;

// Descrições do relatório de liberações em linguagem de casa.
const DESCRIPTION_LABELS: Record<string, string> = {
  payment: "Pagamento recebido",
  payout: "Saque ou transferência",
  refund: "Estorno",
  chargeback: "Contestação",
  shipping: "Frete",
  fee: "Tarifa",
};

function describe(movement: MovementRow) {
  const key = movement.description?.toLowerCase() ?? "";
  if (DESCRIPTION_LABELS[key]) return DESCRIPTION_LABELS[key];
  if (key.startsWith("reserve")) return "Valor reservado";
  return movement.description || movement.record_type || "Movimentação";
}

function validMonth(value?: string) {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : todayIso().slice(0, 7);
}

function shiftMonth(month: string, delta: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Limites do mês no fuso da casa (UTC-3, sem horário de verão).
function monthRange(month: string) {
  return {
    start: `${month}-01T00:00:00-03:00`,
    end: `${shiftMonth(month, 1)}-01T00:00:00-03:00`,
  };
}

function maskDocument(value: string | null) {
  if (!value) return null;
  const digitsOnly = value.replace(/\D/g, "");
  return digitsOnly.length >= 11 ? `CPF •••.${digitsOnly.slice(3, 6)}.•••-${digitsOnly.slice(-2)}` : null;
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const { profile, supabase } = await requirePage("finance");
  const canView = can(profile, "view_wallet_balance");
  const canManage = can(profile, "manage_wallet");
  const selectedMonth = validMonth(params.mes);
  const filter = params.tipo === "entradas" || params.tipo === "saidas" ? params.tipo : "todos";
  const returnQuery = `?mes=${selectedMonth}&tipo=${filter}`;

  if (!canView) {
    return (
      <>
        <div className="page-head">
          <div>
            <span className="eyebrow">Mercado Pago</span>
            <h1>Conta da casa</h1>
          </div>
        </div>
        <div className="card pad">
          <div className="empty">
            Você não tem permissão para ver o saldo e o extrato. Peça ao
            administrador para liberar “Ver saldo e extrato”.
          </div>
        </div>
      </>
    );
  }

  const historyStart = monthRange(shiftMonth(todayIso().slice(0, 7), -(MONTHS_OF_HISTORY - 1))).start;
  const reconcileStart = Date.now() - RECONCILE_WINDOW_DAYS * 86_400_000;

  const [snapshotResult, movementsResult, linksResult, sharesResult, membersResult] =
    await Promise.all([
      supabase
        .from("wallet_snapshots")
        .select("balance,source,observed_at")
        .eq("household_id", profile.household_id)
        .order("observed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("wallet_movements")
        .select(
          "id,occurred_at,record_type,description,payment_method,net_credit,net_debit,balance_after,payer_name,payer_email,payer_document,payer_lookup_status,ignored",
        )
        .eq("household_id", profile.household_id)
        .gte("occurred_at", historyStart)
        .order("occurred_at", { ascending: false })
        .limit(1000),
      supabase.from("wallet_movement_shares").select("movement_id,share_id,amount"),
      canManage
        ? supabase
            .from("expense_shares")
            .select(
              "id,amount,member_id,payment_status,expense:expenses!inner(title,due_date,reference_month,household_id)",
            )
            .eq("expense.household_id", profile.household_id)
            .in("payment_status", ["pending", "late"])
            .gt("amount", 0)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("household_members")
        .select("*")
        .eq("household_id", profile.household_id)
        .eq("active", true)
        .order("display_order"),
    ]);

  const loadError = [movementsResult.error, linksResult.error, sharesResult.error, membersResult.error].find(Boolean);
  const movements = (movementsResult.data ?? []) as MovementRow[];
  // O banco devolve "+00:00" e o JS gera "Z": comparar como número, não texto.
  const occurredAt = (movement: MovementRow) => Date.parse(movement.occurred_at);
  const inMonth = (movement: MovementRow, month: string) => {
    const range = monthRange(month);
    const timestamp = occurredAt(movement);
    return timestamp >= Date.parse(range.start) && timestamp < Date.parse(range.end);
  };
  const links = (linksResult.data ?? []) as LinkRow[];
  const members = (membersResult.data ?? []) as {
    id: string;
    name: string;
    email: string | null;
    initials: string;
    color_key: string;
    payer_identifiers?: string[] | null;
  }[];
  const memberById = new Map(members.map((member) => [member.id, member]));
  const linkedShareIds = new Set(links.map((link) => link.share_id));
  const openShares = ((sharesResult.data ?? []) as unknown as OpenShareRow[])
    .map((share) => ({
      ...share,
      expense: Array.isArray(share.expense) ? share.expense[0] : share.expense,
      amount: asNumber(share.amount),
    }))
    .filter((share) => !linkedShareIds.has(share.id))
    .sort((a, b) => (a.expense?.due_date ?? "9999").localeCompare(b.expense?.due_date ?? "9999"));
  const shareById = new Map(openShares.map((share) => [share.id, share]));

  const linksByMovement = new Map<string, LinkRow[]>();
  for (const link of links) {
    linksByMovement.set(link.movement_id, [...(linksByMovement.get(link.movement_id) ?? []), link]);
  }
  const linkedTotal = (movementId: string) =>
    (linksByMovement.get(movementId) ?? []).reduce((total, link) => total + asNumber(link.amount), 0);

  const toReconcile = canManage
    ? movements.filter(
        (movement) =>
          !movement.ignored &&
          asNumber(movement.net_credit) > 0 &&
          occurredAt(movement) >= reconcileStart &&
          asNumber(movement.net_credit) - linkedTotal(movement.id) >= 0.01,
      )
    : [];

  const monthMovements = movements.filter((movement) => inMonth(movement, selectedMonth));
  const visibleMovements = monthMovements.filter((movement) =>
    filter === "entradas"
      ? asNumber(movement.net_credit) > 0
      : filter === "saidas"
        ? asNumber(movement.net_debit) > 0
        : true,
  );
  const monthCredits = monthMovements.reduce((total, movement) => total + asNumber(movement.net_credit), 0);
  const monthDebits = monthMovements.reduce((total, movement) => total + asNumber(movement.net_debit), 0);

  const summary = Array.from({ length: MONTHS_OF_HISTORY }, (_, index) => {
    const month = shiftMonth(todayIso().slice(0, 7), -index);
    const rows = movements.filter((movement) => inMonth(movement, month));
    const credits = rows.reduce((total, movement) => total + asNumber(movement.net_credit), 0);
    const debits = rows.reduce((total, movement) => total + asNumber(movement.net_debit), 0);
    return { month, credits, debits, count: rows.length };
  });

  const snapshot = snapshotResult.data;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Mercado Pago • somente recursos gratuitos</span>
          <h1>Conta da casa</h1>
          <p>
            Extrato importado do relatório diário do Mercado Pago. Os Pix
            recebidos podem ser conciliados com as parcelas das despesas.
          </p>
        </div>
        {canManage && (
          <form action={syncMercadoPago} className="page-actions">
            <input type="hidden" name="redirect_to" value="/app/financeiro" />
            <SubmitButton
              className="button secondary"
              disabled={!process.env.MERCADO_PAGO_ACCESS_TOKEN}
              pendingLabel="Sincronizando..."
            >
              <WalletIcon /> Sincronizar agora
            </SubmitButton>
          </form>
        )}
      </div>

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}
      {loadError && (
        <div className="message error">
          Não foi possível carregar o extrato. Confira se a migration 037 foi aplicada.
        </div>
      )}

      <div className="finance-kpis">
        <div className="card pad finance-kpi">
          <span>Saldo atual</span>
          <strong>{snapshot ? currency.format(asNumber(snapshot.balance)) : "—"}</strong>
          <small>
            {snapshot
              ? `${snapshot.source === "mercado_pago" ? "Mercado Pago" : "Manual"} • ${formatHouseDateTime(snapshot.observed_at)}`
              : "Ainda sem sincronização"}
          </small>
        </div>
        <div className="card pad finance-kpi">
          <span>Entradas em {monthLabel.format(new Date(`${selectedMonth}-01T12:00:00Z`))}</span>
          <strong className="finance-credit">{currency.format(monthCredits)}</strong>
          <small>{monthMovements.filter((movement) => asNumber(movement.net_credit) > 0).length} movimentações</small>
        </div>
        <div className="card pad finance-kpi">
          <span>Saídas no mês</span>
          <strong className="finance-debit">{currency.format(monthDebits)}</strong>
          <small>{monthMovements.filter((movement) => asNumber(movement.net_debit) > 0).length} movimentações</small>
        </div>
        <div className="card pad finance-kpi">
          <span>Pix a conciliar</span>
          <strong>{canManage ? toReconcile.length : "—"}</strong>
          <small>Entradas dos últimos {RECONCILE_WINDOW_DAYS} dias</small>
        </div>
      </div>

      {canManage && toReconcile.length > 0 && (
        <section className="card finance-section">
          <div className="card-head">
            <div>
              <h2>Pix recebidos a conciliar</h2>
              <span className="muted-text">
                Marque as parcelas que este Pix pagou. Elas ficam pagas com o
                Pix como comprovante; dá para desfazer depois.
              </span>
            </div>
            <CheckIcon />
          </div>
          <div className="finance-reconcile-list">
            {toReconcile.map((movement) => {
              const available = asNumber(movement.net_credit) - linkedTotal(movement.id);
              const suggestion = suggestReconciliation(
                {
                  available,
                  payer_name: movement.payer_name,
                  payer_email: movement.payer_email,
                  payer_document: movement.payer_document,
                },
                members.map((member) => ({
                  id: member.id,
                  name: member.name,
                  email: member.email,
                  payer_identifiers: member.payer_identifiers ?? [],
                })),
                openShares.map((share) => ({ id: share.id, member_id: share.member_id, amount: share.amount })),
              );
              const suggestedMember = suggestion.memberId ? memberById.get(suggestion.memberId) : null;
              const document = maskDocument(movement.payer_document);
              return (
                <article className="finance-reconcile-item" key={movement.id}>
                  <div className="finance-reconcile-head">
                    <div>
                      <strong className="finance-credit">{currency.format(available)}</strong>
                      {available < asNumber(movement.net_credit) && (
                        <small> de {currency.format(asNumber(movement.net_credit))}</small>
                      )}
                      <small>{formatHouseDateTime(movement.occurred_at)} • {describe(movement)}</small>
                    </div>
                    <div className="finance-payer">
                      {movement.payer_name || movement.payer_email || document ? (
                        <>
                          <strong>{movement.payer_name ?? movement.payer_email}</strong>
                          <small>{[movement.payer_name ? movement.payer_email : null, document].filter(Boolean).join(" • ")}</small>
                        </>
                      ) : (
                        <small>
                          {movement.payer_lookup_status === "pending"
                            ? "Pagador ainda não consultado"
                            : "Pagador não informado pelo Mercado Pago"}
                        </small>
                      )}
                    </div>
                  </div>
                  {suggestedMember && (
                    <div className="message info finance-suggestion">
                      Provavelmente de <strong>{suggestedMember.name}</strong>
                      {suggestion.reason === "identifier"
                        ? " (e-mail ou CPF cadastrado)."
                        : suggestion.reason === "name"
                          ? " (nome do pagador)."
                          : " (única parcela com este valor)."}
                    </div>
                  )}
                  {suggestion.candidateShareIds.length > 0 ? (
                    <form action={reconcileMovement} className="finance-reconcile-form">
                      <input type="hidden" name="movement_id" value={movement.id} />
                      <input type="hidden" name="return_query" value={returnQuery} />
                      <div className="finance-share-options">
                        {suggestion.candidateShareIds.slice(0, 12).map((shareId) => {
                          const share = shareById.get(shareId);
                          if (!share) return null;
                          const member = memberById.get(share.member_id);
                          return (
                            <label className="finance-share-option" key={shareId}>
                              <input
                                type="checkbox"
                                name="share_ids"
                                value={shareId}
                                defaultChecked={suggestion.suggestedShareIds.includes(shareId)}
                              />
                              <span>
                                <strong>{member?.name ?? "Morador"} • {currency.format(share.amount)}</strong>
                                <small>
                                  {share.expense?.title ?? "Despesa"}
                                  {share.expense?.due_date ? ` • vence ${formatHouseTimestamp(share.expense.due_date)}` : ""}
                                  {share.payment_status === "late" ? " • atrasada" : ""}
                                </small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <SubmitButton className="button secondary small" pendingLabel="Conciliando...">
                        Conciliar parcelas marcadas
                      </SubmitButton>
                    </form>
                  ) : (
                    <div className="empty">Nenhuma parcela em aberto cabe neste valor.</div>
                  )}
                  <form action={setMovementIgnored}>
                    <input type="hidden" name="movement_id" value={movement.id} />
                    <input type="hidden" name="ignored" value="true" />
                    <input type="hidden" name="return_query" value={returnQuery} />
                    <SubmitButton className="button ghost small" pendingLabel="Salvando...">
                      Não é pagamento de despesa
                    </SubmitButton>
                  </form>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="card finance-section">
        <div className="card-head finance-statement-head">
          <div>
            <h2>Extrato</h2>
            <span className="muted-text">
              {monthLabel.format(new Date(`${selectedMonth}-01T12:00:00Z`))}
            </span>
          </div>
          <div className="finance-filters">
            <Link className="button ghost small" href={`?mes=${shiftMonth(selectedMonth, -1)}&tipo=${filter}`}>
              ← Mês anterior
            </Link>
            <Link className="button ghost small" href={`?mes=${shiftMonth(selectedMonth, 1)}&tipo=${filter}`}>
              Próximo mês →
            </Link>
            {(["todos", "entradas", "saidas"] as const).map((option) => (
              <Link
                key={option}
                className={`button small ${filter === option ? "secondary" : "ghost"}`}
                href={`?mes=${selectedMonth}&tipo=${option}`}
                aria-current={filter === option ? "page" : undefined}
              >
                {option === "todos" ? "Tudo" : option === "entradas" ? "Entradas" : "Saídas"}
              </Link>
            ))}
          </div>
        </div>
        <div className="list">
          {visibleMovements.map((movement) => {
            const credit = asNumber(movement.net_credit);
            const debit = asNumber(movement.net_debit);
            const movementLinks = linksByMovement.get(movement.id) ?? [];
            return (
              <div className="list-row finance-row" key={movement.id}>
                <div className="item-title">
                  <strong>{describe(movement)}</strong>
                  <small>
                    {formatHouseDateTime(movement.occurred_at)}
                    {movement.payer_name ? ` • ${movement.payer_name}` : ""}
                    {movement.payment_method ? ` • ${movement.payment_method}` : ""}
                  </small>
                  {movementLinks.length > 0 && (
                    <small className="finance-linked">
                      Conciliado com {movementLinks.length} parcela(s)
                    </small>
                  )}
                  {movement.ignored && <small className="muted-text">Marcado como não relacionado a despesas</small>}
                </div>
                <div className="item-value">
                  <strong className={credit > 0 ? "finance-credit" : "finance-debit"}>
                    {credit > 0 ? `+ ${currency.format(credit)}` : `− ${currency.format(debit)}`}
                  </strong>
                  <small>
                    {movement.balance_after !== null
                      ? `saldo ${currency.format(asNumber(movement.balance_after))}`
                      : ""}
                  </small>
                </div>
                {canManage && movementLinks.length > 0 && (
                  <form action={undoReconciliation}>
                    <input type="hidden" name="movement_id" value={movement.id} />
                    <input type="hidden" name="return_query" value={returnQuery} />
                    <SubmitButton className="button ghost small" pendingLabel="Desfazendo...">
                      Desfazer conciliação
                    </SubmitButton>
                  </form>
                )}
                {canManage && movement.ignored && (
                  <form action={setMovementIgnored}>
                    <input type="hidden" name="movement_id" value={movement.id} />
                    <input type="hidden" name="ignored" value="false" />
                    <input type="hidden" name="return_query" value={returnQuery} />
                    <SubmitButton className="button ghost small" pendingLabel="Salvando...">
                      Voltar para conciliação
                    </SubmitButton>
                  </form>
                )}
              </div>
            );
          })}
          {visibleMovements.length === 0 && (
            <div className="empty">
              Nenhuma movimentação neste mês. O extrato é preenchido a cada
              relatório importado do Mercado Pago (um por dia).
            </div>
          )}
        </div>
      </section>

      <section className="card finance-section">
        <div className="card-head">
          <div>
            <h2>Resumo mensal</h2>
            <span className="muted-text">Últimos {MONTHS_OF_HISTORY} meses do extrato importado.</span>
          </div>
          <BankIcon />
        </div>
        <div className="finance-table-wrap">
          <table className="finance-table">
            <thead>
              <tr>
                <th scope="col">Mês</th>
                <th scope="col">Entradas</th>
                <th scope="col">Saídas</th>
                <th scope="col">Resultado</th>
                <th scope="col">Movimentações</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.month}>
                  <th scope="row">
                    <Link href={`?mes=${row.month}&tipo=todos`}>
                      {monthLabel.format(new Date(`${row.month}-01T12:00:00Z`))}
                    </Link>
                  </th>
                  <td className="finance-credit">{currency.format(row.credits)}</td>
                  <td className="finance-debit">{currency.format(row.debits)}</td>
                  <td className={row.credits - row.debits >= 0 ? "finance-credit" : "finance-debit"}>
                    {currency.format(row.credits - row.debits)}
                  </td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
