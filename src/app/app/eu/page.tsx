import Link from "next/link";
import { StatusPill } from "@/components/status-pill";
import { CalendarIcon, ChecklistIcon, UsersIcon, WalletIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { asNumber, currency, monthLabel } from "@/lib/format";
import { signedReceiptUrl } from "@/lib/storage";
import {
  settleZeroShoppingBalance,
  settleZeroShoppingBalanceAsAdmin,
} from "@/app/app/organizacao/actions";
import {
  SettlementDetailsModal,
  type SettlementDetails,
} from "./settlement-details-modal";
import {
  ShoppingPaymentConfirmationForm,
  ShoppingReceiptUploadForm,
} from "./shopping-payment-forms";

type SettlementMember = {
  id: string;
  name: string;
  pix_key: string | null;
};

type SettlementPaymentRow = {
  id: string;
  debtor_member_id: string;
  creditor_member_id: string;
  amount: number | string;
  payment_kind: "pix" | "compensation";
  status: "pending" | "confirmed";
  receipt_path: string | null;
  receipt_name: string | null;
  submitted_at: string;
  confirmed_at: string | null;
  debtor: SettlementMember | SettlementMember[] | null;
  creditor: SettlementMember | SettlementMember[] | null;
};

type SettlementPaymentWithReceipt = SettlementPaymentRow & {
  receiptUrl: string | null;
};

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
    { data: personalSettlementPayments },
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
        "id,member_id,amount,settled_amount,payment_status,paid_at,purchase:shopping_purchases(id,total_amount,bought_at,paid_by_member_id,paid_by:household_members!shopping_purchases_paid_by_member_id_fkey(id,name,pix_key),items:shopping_items(id,name,quantity_bought,unit_price),shopping_purchase_shares(id,member_id,amount,settled_amount,payment_status,member:household_members(id,name,pix_key)))",
      )
      .eq("member_id", memberId)
      .eq("payment_status", "pending")
      .order("created_at", { ascending: false }),
    supabase
      .from("shopping_purchases")
      .select("id,total_amount,bought_at,paid_by_member_id,paid_by:household_members!shopping_purchases_paid_by_member_id_fkey(id,name,pix_key),items:shopping_items(id,name,quantity_bought,unit_price),shopping_purchase_shares(id,member_id,amount,settled_amount,payment_status,member:household_members(id,name,pix_key))")
      .eq("paid_by_member_id", memberId),
    supabase
      .from("shopping_settlement_payments")
      .select(
        "id,debtor_member_id,creditor_member_id,amount,payment_kind,status,receipt_path,receipt_name,submitted_at,confirmed_at,debtor:household_members!shopping_settlement_payments_debtor_member_id_fkey(id,name,pix_key),creditor:household_members!shopping_settlement_payments_creditor_member_id_fkey(id,name,pix_key)",
      )
      .or(`debtor_member_id.eq.${memberId},creditor_member_id.eq.${memberId}`)
      .order("submitted_at", { ascending: false }),
  ]);

  let adminPendingShoppingShares: Array<Record<string, any>> = [];
  let adminSettlementPayments: SettlementPaymentRow[] = [];
  if (profile.role === "admin") {
    const [{ data: pendingShares }, { data: settlementPayments }] = await Promise.all([
      supabase
        .from("shopping_purchase_shares")
        .select(
          "id,member_id,amount,settled_amount,payment_status,member:household_members(id,name,pix_key),purchase:shopping_purchases!inner(id,household_id,total_amount,bought_at,paid_by_member_id,paid_by:household_members!shopping_purchases_paid_by_member_id_fkey(id,name,pix_key),items:shopping_items(id,name,quantity_bought,unit_price),shopping_purchase_shares(id,member_id,amount,settled_amount,payment_status,member:household_members(id,name,pix_key)))",
        )
        .eq("payment_status", "pending"),
      supabase
        .from("shopping_settlement_payments")
        .select(
          "id,debtor_member_id,creditor_member_id,amount,payment_kind,status,receipt_path,receipt_name,submitted_at,confirmed_at,debtor:household_members!shopping_settlement_payments_debtor_member_id_fkey(id,name,pix_key),creditor:household_members!shopping_settlement_payments_creditor_member_id_fkey(id,name,pix_key)",
        )
        .order("submitted_at", { ascending: false }),
    ]);
    adminPendingShoppingShares = (pendingShares ?? []) as Array<Record<string, any>>;
    adminSettlementPayments = (settlementPayments ?? []) as unknown as SettlementPaymentRow[];
  }

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
  const outstandingAmount = (share: Record<string, any>) =>
    Math.max(0, asNumber(share.amount) - asNumber(share.settled_amount));
  const purchaseDetail = (
    share: Record<string, any>,
    debtorName: string,
  ): SettlementDetails["sections"][number]["purchases"][number] => {
    const purchase = Array.isArray(share.purchase) ? share.purchase[0] : share.purchase;
    const paidBy = Array.isArray(purchase?.paid_by) ? purchase.paid_by[0] : purchase?.paid_by;
    const items = (purchase?.items ?? []).map((item: Record<string, any>) => {
      const quantity = asNumber(item.quantity_bought);
      const unitPrice = asNumber(item.unit_price);
      return {
        id: String(item.id),
        name: String(item.name ?? "Item"),
        quantity,
        unitPrice,
        subtotal: Math.round(quantity * unitPrice * 100) / 100,
      };
    });
    const participants = (purchase?.shopping_purchase_shares ?? []).map(
      (purchaseShare: Record<string, any>) => {
        const member = Array.isArray(purchaseShare.member)
          ? purchaseShare.member[0]
          : purchaseShare.member;
        const amount = asNumber(purchaseShare.amount);
        const isClosed = ["paid", "waived"].includes(purchaseShare.payment_status);
        const settledAmount = isClosed
          ? amount
          : Math.min(amount, asNumber(purchaseShare.settled_amount));
        return {
          id: String(purchaseShare.id),
          name: String(member?.name ?? "Morador"),
          amount,
          settledAmount,
          openAmount: Math.max(0, amount - settledAmount),
        };
      },
    );

    return {
      id: String(purchase?.id ?? share.id),
      boughtAt: purchase?.bought_at ?? null,
      payerName: paidBy?.name ?? "Morador",
      debtorName,
      purchaseTotal: asNumber(purchase?.total_amount),
      originalShareAmount: asNumber(share.amount),
      settledShareAmount: asNumber(share.settled_amount),
      openShareAmount: outstandingAmount(share),
      items,
      participants,
    };
  };
  const personalPaymentRows: SettlementPaymentWithReceipt[] = await Promise.all(
    ((personalSettlementPayments ?? []) as unknown as SettlementPaymentRow[]).map(async (payment) => ({
      ...payment,
      receiptUrl: await signedReceiptUrl(supabase, payment.receipt_path),
    })),
  );
  const personalPendingPayments = personalPaymentRows.filter(
    (payment) => payment.status === "pending",
  );
  const personalClosedPayments = personalPaymentRows.filter(
    (payment) => payment.status === "confirmed",
  );
  const adminPaymentRows: SettlementPaymentWithReceipt[] = await Promise.all(
    adminSettlementPayments.map(async (payment) => ({
      ...payment,
      receiptUrl: await signedReceiptUrl(supabase, payment.receipt_path),
    })),
  );
  const adminPendingPayments = adminPaymentRows.filter(
    (payment) => payment.status === "pending",
  );
  const adminClosedPayments = adminPaymentRows.filter(
    (payment) => payment.status === "confirmed",
  );

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
      account.incomingShares.push({ ...share, purchase });
      accountMap.set(member.id, account);
    }
  }

  const netShoppingAccounts = await Promise.all(
    Array.from(accountMap.values()).map(async (account) => {
      const grossOutgoing = account.outgoingShares.reduce(
        (sum, share) => sum + outstandingAmount(share), 0,
      );
      const grossIncoming = account.incomingShares.reduce(
        (sum, share) => sum + outstandingAmount(share), 0,
      );
      const net = Math.round((grossOutgoing - grossIncoming) * 100) / 100;
      const outgoingPendingPayment = personalPendingPayments.find(
        (payment) =>
          payment.debtor_member_id === memberId &&
          payment.creditor_member_id === account.memberId,
      );
      const incomingPendingPayment = personalPendingPayments.find(
        (payment) =>
          payment.debtor_member_id === account.memberId &&
          payment.creditor_member_id === memberId,
      );
      const pendingPayment = net > 0 ? outgoingPendingPayment : incomingPendingPayment;
      const remainingNet = Math.max(0, Math.abs(net) - asNumber(pendingPayment?.amount));
      const details: SettlementDetails = {
        title: `Como foi calculado o acerto com ${account.memberName}`,
        sections: [
          {
            title: `Compras pagas por ${account.memberName} que geraram cobrança para você`,
            total: grossOutgoing,
            purchases: account.outgoingShares.map((share) =>
              purchaseDetail(share, profile.full_name),
            ),
          },
          {
            title: "Compras pagas por você que reduzem a cobrança",
            total: grossIncoming,
            purchases: account.incomingShares.map((share) =>
              purchaseDetail(share, account.memberName),
            ),
          },
        ],
        calculation: {
          firstLabel: `Você deve a ${account.memberName}`,
          firstAmount: grossOutgoing,
          secondLabel: `${account.memberName} deve a você`,
          secondAmount: grossIncoming,
          netAmount: Math.abs(net),
          pendingPaymentAmount: asNumber(pendingPayment?.amount),
          remainingAmount: remainingNet,
          resultLabel: net > 0
            ? `Você paga a ${account.memberName}`
            : net < 0
              ? `${account.memberName} paga a você`
              : "Dívidas compensadas",
        },
      };
      return {
        ...account,
        grossOutgoing,
        grossIncoming,
        net,
        remainingNet,
        representativeShare: account.outgoingShares[0],
        outgoingPendingPayment,
        incomingPendingPayment,
        details,
      };
    }),
  );

  type AdminPairAccount = {
    firstMember: { id: string; name: string; pix_key: string | null };
    secondMember: { id: string; name: string; pix_key: string | null };
    firstOwesSecond: Array<Record<string, any>>;
    secondOwesFirst: Array<Record<string, any>>;
  };
  const adminPairMap = new Map<string, AdminPairAccount>();

  for (const share of adminPendingShoppingShares) {
    const purchase = Array.isArray(share.purchase) ? share.purchase[0] : share.purchase;
    const debtor = Array.isArray(share.member) ? share.member[0] : share.member;
    const creditor = Array.isArray(purchase?.paid_by) ? purchase.paid_by[0] : purchase?.paid_by;
    if (!purchase || !debtor || !creditor || debtor.id === creditor.id) continue;

    const debtorComesFirst = debtor.id.localeCompare(creditor.id) < 0;
    const firstMember = debtorComesFirst ? debtor : creditor;
    const secondMember = debtorComesFirst ? creditor : debtor;
    const pairKey = `${firstMember.id}:${secondMember.id}`;
    const account = adminPairMap.get(pairKey) ?? {
      firstMember,
      secondMember,
      firstOwesSecond: [],
      secondOwesFirst: [],
    };
    if (debtor.id === firstMember.id) account.firstOwesSecond.push(share);
    else account.secondOwesFirst.push(share);
    adminPairMap.set(pairKey, account);
  }

  const adminNetShoppingAccounts = await Promise.all(
    Array.from(adminPairMap.values()).map(async (account) => {
      const grossFirstOwesSecond = account.firstOwesSecond.reduce(
        (sum, share) => sum + outstandingAmount(share),
        0,
      );
      const grossSecondOwesFirst = account.secondOwesFirst.reduce(
        (sum, share) => sum + outstandingAmount(share),
        0,
      );
      const signedNet = Math.round((grossFirstOwesSecond - grossSecondOwesFirst) * 100) / 100;
      const debtor = signedNet >= 0 ? account.firstMember : account.secondMember;
      const creditor = signedNet >= 0 ? account.secondMember : account.firstMember;
      const debtorShares = signedNet >= 0 ? account.firstOwesSecond : account.secondOwesFirst;
      const pendingPayment = adminPendingPayments.find(
        (payment) =>
          payment.debtor_member_id === debtor.id &&
          payment.creditor_member_id === creditor.id,
      );
      const netAmount = Math.abs(signedNet);
      const remainingNet = Math.max(0, netAmount - asNumber(pendingPayment?.amount));
      const details: SettlementDetails = {
        title: `Como foi calculado: ${account.firstMember.name} × ${account.secondMember.name}`,
        sections: [
          {
            title: `Compras pagas por ${account.secondMember.name} cobradas de ${account.firstMember.name}`,
            total: grossFirstOwesSecond,
            purchases: account.firstOwesSecond.map((share) =>
              purchaseDetail(share, account.firstMember.name),
            ),
          },
          {
            title: `Compras pagas por ${account.firstMember.name} cobradas de ${account.secondMember.name}`,
            total: grossSecondOwesFirst,
            purchases: account.secondOwesFirst.map((share) =>
              purchaseDetail(share, account.secondMember.name),
            ),
          },
        ],
        calculation: {
          firstLabel: `${account.firstMember.name} deve a ${account.secondMember.name}`,
          firstAmount: grossFirstOwesSecond,
          secondLabel: `${account.secondMember.name} deve a ${account.firstMember.name}`,
          secondAmount: grossSecondOwesFirst,
          netAmount,
          pendingPaymentAmount: asNumber(pendingPayment?.amount),
          remainingAmount: remainingNet,
          resultLabel: signedNet > 0
            ? `${account.firstMember.name} paga a ${account.secondMember.name}`
            : signedNet < 0
              ? `${account.secondMember.name} paga a ${account.firstMember.name}`
              : "Dívidas compensadas",
        },
      };
      return {
        ...account,
        grossFirstOwesSecond,
        grossSecondOwesFirst,
        net: netAmount,
        remainingNet,
        debtor,
        creditor,
        representativeShare: debtorShares[0],
        pendingPayment,
        details,
      };
    }),
  );
  const totalUnpaid =
    unpaid.reduce((sum, s) => sum + asNumber(s.amount), 0)
    + netShoppingAccounts
      .filter((account) => account.net > 0)
      .reduce((sum, account) => sum + account.remainingNet, 0);
  const totalUnpaidCount = unpaid.length
    + netShoppingAccounts.filter((account) => account.net > 0 && account.remainingNet > 0).length;
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
              <h2>Acertos de compras — em aberto</h2>
              <span className="muted-text" style={{ fontSize: 10 }}>
                Envie o comprovante por aqui. O recebedor ou o administrador
                só poderá marcar como pago depois que o arquivo for anexado.
              </span>
            </div>
            <WalletIcon />
          </div>
          <div className="purchase-list">
            {netShoppingAccounts.length === 0 && (
              <div className="empty">Você não possui acertos de compras pendentes.</div>
            )}
            {netShoppingAccounts.map((account) => {
              const pendingPayment = account.net > 0
                ? account.outgoingPendingPayment
                : account.incomingPendingPayment;
              return (
                <SettlementDetailsModal key={account.memberId} details={account.details}>
                <article className="purchase-card net-account-card">
                  <div className="purchase-summary personal-purchase-summary">
                    <div className="item-title">
                      <strong>Acerto com {account.memberName}</strong>
                      <small>Compensação automática das dívidas nos dois sentidos</small>
                    </div>
                    <div className="item-value">
                      <strong>{currency.format(account.remainingNet)}</strong>
                      <small>{account.net > 0 ? "ainda falta pagar" : account.net < 0 ? "ainda falta receber" : "saldo final"}</small>
                    </div>
                    <span className={`status-pill ${account.net === 0 ? "violet" : pendingPayment ? "info" : "warning"}`}>
                      {account.net === 0 ? "Compensação total" : pendingPayment ? "Aguardando confirmação" : "Em aberto"}
                    </span>
                  </div>

                  <div className="netting-explanation">
                    <span>Você deve a {account.memberName}: <strong>{currency.format(account.grossOutgoing)}</strong></span>
                    <span>{account.memberName} deve a você: <strong>{currency.format(account.grossIncoming)}</strong></span>
                    <p>
                      {account.net > 0
                        ? pendingPayment
                          ? `O saldo líquido era ${currency.format(account.net)}. Foi informado um pagamento de ${currency.format(asNumber(pendingPayment.amount))}; restam ${currency.format(account.remainingNet)} em aberto enquanto o comprovante aguarda confirmação.`
                          : `Como os dois possuem dívidas, subtraímos ${currency.format(account.grossIncoming)} de ${currency.format(account.grossOutgoing)}. Você precisa pagar ${currency.format(account.net)}.`
                        : account.net < 0
                          ? pendingPayment
                            ? `${account.memberName} informou um pagamento de ${currency.format(asNumber(pendingPayment.amount))}. Depois desse valor, ainda restam ${currency.format(account.remainingNet)} para você receber.`
                            : `Como os dois possuem dívidas, subtraímos ${currency.format(account.grossOutgoing)} de ${currency.format(account.grossIncoming)}. ${account.memberName} precisa pagar ${currency.format(Math.abs(account.net))} a você.`
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
                        <strong>{currency.format(account.remainingNet)}</strong>
                      </div>
                    </div>
                  )}

                  {account.net > 0 && account.representativeShare && !pendingPayment && (
                    <div style={{ padding: "4px 16px 14px" }}>
                      <ShoppingReceiptUploadForm
                        shareId={account.representativeShare.id}
                        redirectTo="/app/eu"
                        label="Enviar comprovante do PIX"
                        defaultValue={account.remainingNet}
                        max={account.remainingNet}
                      />
                    </div>
                  )}

                  {pendingPayment && (
                    <div className="purchase-proof-actions" style={{ padding: "12px 16px" }}>
                      <div className="attachment-row">
                        <span>📎 Pagamento informado: {currency.format(asNumber(pendingPayment.amount))}</span>
                        {pendingPayment.receiptUrl && (
                          <a href={pendingPayment.receiptUrl} target="_blank" rel="noreferrer">
                            Ver {pendingPayment.receipt_name ?? "comprovante"}
                          </a>
                        )}
                      </div>
                      <div className="pending-payment-guidance">
                        <strong>Aguardando confirmação deste pagamento.</strong>
                        <span>
                          {account.remainingNet > 0
                            ? `Depois de confirmar, será liberado outro comprovante para o saldo restante de ${currency.format(account.remainingNet)}.`
                            : "Depois de confirmar, este acerto será totalmente quitado."}
                        </span>
                      </div>
                      {(account.net < 0 || profile.role === "admin") && (
                        <ShoppingPaymentConfirmationForm
                          paymentId={pendingPayment.id}
                          redirectTo="/app/eu"
                          label={profile.role === "admin" ? "Confirmar como administrador" : "Confirmar pagamento"}
                        />
                      )}
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
                </SettlementDetailsModal>
              );
            })}
          </div>

          <details className="details-editor" style={{ margin: "0 20px 16px" }}>
            <summary>Fechados ({personalClosedPayments.length})</summary>
            <div className="editor-body purchase-list">
              {personalClosedPayments.length === 0 && (
                <div className="empty">Nenhum acerto fechado encontrado.</div>
              )}
              {personalClosedPayments.map((payment) => {
                const debtor = Array.isArray(payment.debtor) ? payment.debtor[0] : payment.debtor;
                const creditor = Array.isArray(payment.creditor) ? payment.creditor[0] : payment.creditor;
                return (
                  <article className="purchase-card" key={payment.id}>
                    <div className="purchase-summary personal-purchase-summary">
                      <div className="item-title">
                        <strong>{debtor?.name ?? "Morador"} → {creditor?.name ?? "Morador"}</strong>
                        <small>
                          Fechado em {new Date(payment.confirmed_at ?? payment.submitted_at).toLocaleDateString("pt-BR")}
                        </small>
                      </div>
                      <div className="item-value">
                        <strong>
                          {payment.payment_kind === "compensation"
                            ? "Sem PIX"
                            : currency.format(asNumber(payment.amount))}
                        </strong>
                        <small>{payment.payment_kind === "compensation" ? "compensação" : "valor pago"}</small>
                      </div>
                      <span className="status-pill success">Pago</span>
                    </div>
                    {payment.receiptUrl && (
                      <div className="attachment-row" style={{ margin: "0 16px 14px" }}>
                        <span>📎 {payment.receipt_name ?? "comprovante"}</span>
                        <a href={payment.receiptUrl} target="_blank" rel="noreferrer">Ver</a>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </details>
        </section>

        {profile.role === "admin" && (
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Administração dos acertos — em aberto</h2>
                <span className="muted-text" style={{ fontSize: 10 }}>
                  Veja quem deve pagar, anexe o comprovante pelo morador e
                  marque como pago somente depois do arquivo.
                </span>
              </div>
              <UsersIcon />
            </div>
            <div className="purchase-list">
              {adminNetShoppingAccounts.length === 0 && (
                <div className="empty">Nenhum acerto entre moradores está pendente.</div>
              )}
              {adminNetShoppingAccounts.map((account) => {
                const pairKey = `${account.firstMember.id}:${account.secondMember.id}`;
                return (
                  <SettlementDetailsModal key={pairKey} details={account.details}>
                  <article className="purchase-card net-account-card">
                    <div className="purchase-summary personal-purchase-summary">
                      <div className="item-title">
                        <strong>{account.firstMember.name} × {account.secondMember.name}</strong>
                        <small>Visão administrativa do saldo líquido</small>
                      </div>
                      <div className="item-value">
                        <strong>{currency.format(account.remainingNet)}</strong>
                        <small>{account.net > 0 ? "saldo ainda em aberto" : "saldo compensado"}</small>
                      </div>
                      <span className={`status-pill ${account.net === 0 ? "violet" : account.pendingPayment ? "info" : "warning"}`}>
                        {account.net === 0 ? "Compensação total" : account.pendingPayment ? "Aguardando confirmação" : "Em aberto"}
                      </span>
                    </div>

                    <div className="netting-explanation">
                      <span>
                        {account.firstMember.name} deve a {account.secondMember.name}:{" "}
                        <strong>{currency.format(account.grossFirstOwesSecond)}</strong>
                      </span>
                      <span>
                        {account.secondMember.name} deve a {account.firstMember.name}:{" "}
                        <strong>{currency.format(account.grossSecondOwesFirst)}</strong>
                      </span>
                      <p>
                        {account.net > 0
                          ? account.pendingPayment
                            ? `${account.debtor.name} informou ${currency.format(asNumber(account.pendingPayment.amount))}. Restam ${currency.format(account.remainingNet)} em aberto.`
                            : `${account.debtor.name} deve fazer um PIX de ${currency.format(account.net)} para ${account.creditor.name}.`
                          : "Os valores são iguais e podem ser quitados por compensação, sem PIX."}
                      </p>
                    </div>

                    {account.net > 0 && (
                      <div className="purchase-payer">
                        <div>
                          <span>Quem deve pagar</span>
                          <strong>{account.debtor.name}</strong>
                        </div>
                        <div>
                          <span>PIX de {account.creditor.name}</span>
                          <strong>{account.creditor.pix_key ?? "Chave PIX não cadastrada"}</strong>
                        </div>
                      </div>
                    )}

                    {account.net > 0 && account.representativeShare && !account.pendingPayment && (
                      <div style={{ padding: "4px 16px 14px" }}>
                        <ShoppingReceiptUploadForm
                          shareId={account.representativeShare.id}
                          redirectTo="/app/eu"
                          label={`Anexar comprovante de ${account.debtor.name}`}
                          defaultValue={account.remainingNet}
                          max={account.remainingNet}
                        />
                      </div>
                    )}

                    {account.net > 0 && account.pendingPayment && (
                      <div className="purchase-proof-actions" style={{ padding: "12px 16px" }}>
                        <div className="attachment-row">
                          <span>📎 {currency.format(asNumber(account.pendingPayment.amount))}</span>
                          {account.pendingPayment.receiptUrl && (
                            <a href={account.pendingPayment.receiptUrl} target="_blank" rel="noreferrer">
                              Ver {account.pendingPayment.receipt_name ?? "comprovante"}
                            </a>
                          )}
                        </div>
                        <div className="pending-payment-guidance">
                          <strong>Aguardando confirmação deste pagamento.</strong>
                          <span>
                            {account.remainingNet > 0
                              ? `Ao confirmar, será possível anexar outro comprovante para os ${currency.format(account.remainingNet)} restantes.`
                              : "Ao confirmar, este acerto será totalmente quitado."}
                          </span>
                        </div>
                        <ShoppingPaymentConfirmationForm
                          paymentId={account.pendingPayment.id}
                          redirectTo="/app/eu"
                          label="Marcar como pago"
                        />
                      </div>
                    )}

                    {account.net === 0 && (
                      <form action={settleZeroShoppingBalanceAsAdmin} style={{ padding: "0 16px 14px" }}>
                        <input type="hidden" name="first_member_id" value={account.firstMember.id} />
                        <input type="hidden" name="second_member_id" value={account.secondMember.id} />
                        <input type="hidden" name="redirect_to" value="/app/eu" />
                        <button className="button secondary small" type="submit">
                          Quitar por compensação
                        </button>
                      </form>
                    )}
                  </article>
                  </SettlementDetailsModal>
                );
              })}
            </div>

            <details className="details-editor" style={{ margin: "0 20px 16px" }}>
              <summary>Fechados de todos ({adminClosedPayments.length})</summary>
              <div className="editor-body purchase-list">
                {adminClosedPayments.length === 0 && (
                  <div className="empty">Nenhum acerto fechado encontrado.</div>
                )}
                {adminClosedPayments.map((payment) => {
                  const debtor = Array.isArray(payment.debtor) ? payment.debtor[0] : payment.debtor;
                  const creditor = Array.isArray(payment.creditor) ? payment.creditor[0] : payment.creditor;
                  return (
                    <article className="purchase-card" key={payment.id}>
                      <div className="purchase-summary personal-purchase-summary">
                        <div className="item-title">
                          <strong>{debtor?.name ?? "Morador"} → {creditor?.name ?? "Morador"}</strong>
                          <small>
                            Fechado em {new Date(payment.confirmed_at ?? payment.submitted_at).toLocaleDateString("pt-BR")}
                          </small>
                        </div>
                        <div className="item-value">
                          <strong>
                            {payment.payment_kind === "compensation"
                              ? "Sem PIX"
                              : currency.format(asNumber(payment.amount))}
                          </strong>
                          <small>{payment.payment_kind === "compensation" ? "compensação" : "valor pago"}</small>
                        </div>
                        <span className="status-pill success">Pago</span>
                      </div>
                      {payment.receiptUrl && (
                        <div className="attachment-row" style={{ margin: "0 16px 14px" }}>
                          <span>📎 {payment.receipt_name ?? "comprovante"}</span>
                          <a href={payment.receiptUrl} target="_blank" rel="noreferrer">Ver</a>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </details>
          </section>
        )}

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
