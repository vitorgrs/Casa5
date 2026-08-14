import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emailConfigured,
  openSettlementsEmail,
  sendEmail,
  type SettlementEmailAccount,
  type SettlementEmailPurchase,
} from "@/lib/email";

type Member = {
  id: string;
  name: string;
  email: string | null;
  pix_key: string | null;
};

type PairAccount = {
  firstMember: Member;
  secondMember: Member;
  firstOwesSecond: SettlementEmailPurchase[];
  secondOwesFirst: SettlementEmailPurchase[];
  firstOwesSecondCents: number;
  secondOwesFirstCents: number;
};

type DebtorEmail = {
  debtor: Member;
  accounts: SettlementEmailAccount[];
};

export type SettlementEmailRunResult = {
  ok: boolean;
  sent: number;
  debtors: number;
  settlements: number;
  skippedWithoutEmail: number;
  missingPix: number;
  failures: { to: string; error: string }[];
  message: string;
};

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toCents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function purchaseTitle(items: unknown) {
  if (!Array.isArray(items)) return "Compra de mercado";
  const names = items
    .map((item) => String((item as { name?: unknown }).name ?? "").trim())
    .filter(Boolean);
  if (names.length === 0) return "Compra de mercado";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} e mais ${names.length - 3} item(ns)`;
}

function emptyResult(message: string, ok = false): SettlementEmailRunResult {
  return {
    ok,
    sent: 0,
    debtors: 0,
    settlements: 0,
    skippedWithoutEmail: 0,
    missingPix: 0,
    failures: [],
    message,
  };
}

/**
 * Envia um único e-mail para cada devedor, reunindo todos os acertos líquidos
 * que ele ainda precisa pagar. Pessoas com saldo zero ou a receber não entram
 * na lista de destinatários.
 */
export async function runOpenSettlementEmails(
  supabase: SupabaseClient,
  householdId: string,
): Promise<SettlementEmailRunResult> {
  if (!emailConfigured()) {
    return emptyResult(
      "BREVO_API_KEY e/ou BREVO_FROM_EMAIL não estão definidos nas variáveis de ambiente.",
    );
  }

  const [{ data: shares, error: sharesError }, { data: pendingPayments, error: paymentsError }] =
    await Promise.all([
      supabase
        .from("shopping_purchase_shares")
        .select(
          "id,amount,settled_amount,member:household_members(id,name,email,pix_key),purchase:shopping_purchases!inner(id,household_id,bought_at,paid_by_member_id,paid_by:household_members!shopping_purchases_paid_by_member_id_fkey(id,name,email,pix_key),items:shopping_items(id,name))",
        )
        .eq("payment_status", "pending")
        .eq("purchase.household_id", householdId),
      supabase
        .from("shopping_settlement_payments")
        .select("debtor_member_id,creditor_member_id,amount")
        .eq("household_id", householdId)
        .eq("status", "pending"),
    ]);

  if (sharesError) {
    return emptyResult(`Erro ao buscar acertos em aberto: ${sharesError.message}`);
  }
  if (paymentsError) {
    return emptyResult(
      `Erro ao buscar pagamentos aguardando confirmação: ${paymentsError.message}`,
    );
  }

  const pairMap = new Map<string, PairAccount>();
  for (const rawShare of shares ?? []) {
    const share = rawShare as unknown as Record<string, unknown>;
    const debtor = firstRelation<Member>(
      share.member as Member | Member[] | null,
    );
    const purchase = firstRelation<Record<string, unknown>>(
      share.purchase as Record<string, unknown> | Record<string, unknown>[] | null,
    );
    const creditor = firstRelation<Member>(
      purchase?.paid_by as Member | Member[] | null | undefined,
    );
    if (!debtor || !creditor || debtor.id === creditor.id) continue;

    const openCents = Math.max(
      0,
      toCents(share.amount) - toCents(share.settled_amount),
    );
    if (openCents === 0) continue;

    const debtorComesFirst = debtor.id.localeCompare(creditor.id) < 0;
    const firstMember = debtorComesFirst ? debtor : creditor;
    const secondMember = debtorComesFirst ? creditor : debtor;
    const pairKey = `${firstMember.id}:${secondMember.id}`;
    const account = pairMap.get(pairKey) ?? {
      firstMember,
      secondMember,
      firstOwesSecond: [],
      secondOwesFirst: [],
      firstOwesSecondCents: 0,
      secondOwesFirstCents: 0,
    };
    const purchaseDetail: SettlementEmailPurchase = {
      title: purchaseTitle(purchase?.items),
      boughtAt:
        typeof purchase?.bought_at === "string" ? purchase.bought_at : null,
      amount: openCents / 100,
    };

    if (debtor.id === firstMember.id) {
      account.firstOwesSecond.push(purchaseDetail);
      account.firstOwesSecondCents += openCents;
    } else {
      account.secondOwesFirst.push(purchaseDetail);
      account.secondOwesFirstCents += openCents;
    }
    pairMap.set(pairKey, account);
  }

  const pendingByDirection = new Map<string, number>();
  for (const payment of pendingPayments ?? []) {
    const key = `${payment.debtor_member_id}:${payment.creditor_member_id}`;
    pendingByDirection.set(
      key,
      (pendingByDirection.get(key) ?? 0) + toCents(payment.amount),
    );
  }

  const debtorMap = new Map<string, DebtorEmail>();
  for (const pair of pairMap.values()) {
    const signedNetCents =
      pair.firstOwesSecondCents - pair.secondOwesFirstCents;
    if (signedNetCents === 0) continue;

    const firstIsDebtor = signedNetCents > 0;
    const debtor = firstIsDebtor ? pair.firstMember : pair.secondMember;
    const creditor = firstIsDebtor ? pair.secondMember : pair.firstMember;
    const grossOwedCents = firstIsDebtor
      ? pair.firstOwesSecondCents
      : pair.secondOwesFirstCents;
    const grossCreditCents = firstIsDebtor
      ? pair.secondOwesFirstCents
      : pair.firstOwesSecondCents;
    const pendingCents = pendingByDirection.get(`${debtor.id}:${creditor.id}`) ?? 0;
    const remainingCents = Math.max(0, Math.abs(signedNetCents) - pendingCents);

    // Um comprovante que cobre todo o saldo já está aguardando confirmação;
    // portanto não há valor adicional para cobrar por e-mail neste momento.
    if (remainingCents === 0) continue;

    const candidate: DebtorEmail = debtorMap.get(debtor.id) ?? {
      debtor,
      accounts: [],
    };
    candidate.accounts.push({
      creditorName: creditor.name,
      pixKey: creditor.pix_key,
      amount: remainingCents / 100,
      grossOwed: grossOwedCents / 100,
      grossCredit: grossCreditCents / 100,
      pendingPaymentAmount: pendingCents / 100,
      charges: firstIsDebtor
        ? pair.firstOwesSecond
        : pair.secondOwesFirst,
      credits: firstIsDebtor
        ? pair.secondOwesFirst
        : pair.firstOwesSecond,
    });
    debtorMap.set(debtor.id, candidate);
  }

  const candidates = [...debtorMap.values()];
  if (candidates.length === 0) {
    return emptyResult("Nenhum morador possui acerto com valor a pagar no momento.", true);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://casa5.vercel.app";
  let sent = 0;
  const failures: { to: string; error: string }[] = [];

  const settlements = candidates.reduce(
    (total, candidate) => total + candidate.accounts.length,
    0,
  );
  const skippedWithoutEmail = candidates.filter(
    (candidate) => !candidate.debtor.email?.trim(),
  ).length;
  const accountsWithoutPix = candidates.flatMap((candidate) =>
    candidate.accounts.filter((account) => !account.pixKey?.trim()),
  );
  const missingPix = accountsWithoutPix.length;

  // O pedido exige valor e PIX corretos para todos. Evita um disparo parcial
  // ou mensagens incompletas quando algum cadastro ainda não está pronto.
  if (skippedWithoutEmail > 0 || missingPix > 0) {
    const missingPixNames = [
      ...new Set(accountsWithoutPix.map((account) => account.creditorName)),
    ];
    let message = "Envio cancelado antes de disparar qualquer e-mail.";
    if (skippedWithoutEmail > 0) {
      message += ` ${skippedWithoutEmail} devedor(es) estão sem e-mail cadastrado.`;
    }
    if (missingPix > 0) {
      message += ` ${missingPix} acerto(s) estão sem a chave PIX de ${missingPixNames.join(", ")}.`;
    }
    message += " Atualize os dados em Moradores e tente novamente.";
    return {
      ok: false,
      sent: 0,
      debtors: candidates.length,
      settlements,
      skippedWithoutEmail,
      missingPix,
      failures,
      message,
    };
  }

  for (const candidate of candidates) {
    candidate.accounts.sort((a, b) => a.creditorName.localeCompare(b.creditorName, "pt-BR"));

    const { subject, html } = openSettlementsEmail({
      debtorName: candidate.debtor.name,
      accounts: candidate.accounts,
      appUrl,
    });
    try {
      await sendEmail({ to: candidate.debtor.email!, subject, html });
      sent += 1;
    } catch (error) {
      failures.push({
        to: candidate.debtor.email!,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  let message = `${sent} de ${candidates.length} devedor(es) avisado(s), com ${settlements} acerto(s) detalhado(s).`;
  if (failures.length > 0) {
    message += ` ${failures.length} envio(s) falharam — ${failures[0].error}`;
  }

  return {
    ok: failures.length === 0,
    sent,
    debtors: candidates.length,
    settlements,
    skippedWithoutEmail,
    missingPix,
    failures,
    message,
  };
}
