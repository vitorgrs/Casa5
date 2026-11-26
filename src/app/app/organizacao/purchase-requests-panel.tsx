"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { SubmitButton } from "@/components/submit-button";
import { currency } from "@/lib/format";
import { initialFormActionState } from "@/lib/form-action-state";
import { cancelShoppingPurchaseRequest, reviewShoppingPurchaseRequest } from "./actions";

export type PurchaseRequestItem = {
  source: "list" | "extra";
  name: string;
  quantity: number;
  unit_price: number;
};

export type PurchaseRequestRow = {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  total_amount: number | string;
  items: PurchaseRequestItem[];
  purchase_scope: "household" | "group" | "individual";
  split_mode: "equal" | "custom";
  participant_member_ids: string[];
  custom_share_cents: Record<string, number> | null;
  note: string | null;
  review_note: string | null;
  created_at: string;
  requested_by_member_id: string;
};

type Member = { id: string; name: string };

const STATUS_LABELS: Record<PurchaseRequestRow["status"], { label: string; tone: string }> = {
  pending: { label: "Aguardando aprovação", tone: "warning" },
  approved: { label: "Aprovada", tone: "success" },
  rejected: { label: "Recusada", tone: "danger" },
  cancelled: { label: "Cancelada", tone: "muted" },
};

const SCOPE_LABELS: Record<PurchaseRequestRow["purchase_scope"], string> = {
  household: "Casa toda",
  group: "Grupo",
  individual: "Individual",
};

function firstName(name: string | undefined) {
  return (name ?? "Morador").split(" ")[0];
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function splitSummary(request: PurchaseRequestRow, membersById: Map<string, Member>) {
  const participants =
    request.purchase_scope === "household"
      ? "todos os moradores"
      : request.participant_member_ids.map((id) => firstName(membersById.get(id)?.name)).join(", ");
  if (request.split_mode === "custom" && request.custom_share_cents) {
    const parts = Object.entries(request.custom_share_cents).map(
      ([memberId, cents]) => `${firstName(membersById.get(memberId)?.name)} ${currency.format(cents / 100)}`,
    );
    return `${SCOPE_LABELS[request.purchase_scope]} • ${parts.join(" • ")}`;
  }
  return `${SCOPE_LABELS[request.purchase_scope]} • divisão igual entre ${participants}`;
}

function useRefreshOnSuccess(status: string) {
  const router = useRouter();
  useEffect(() => {
    if (status === "success") router.refresh();
  }, [router, status]);
}

function RequestSummary({
  request,
  membersById,
}: {
  request: PurchaseRequestRow;
  membersById: Map<string, Member>;
}) {
  return (
    <>
      <ul className="request-items">
        {request.items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            <span>
              {item.name}
              {item.source === "extra" && <small className="tag">fora da lista</small>}
            </span>
            <span className="request-item-value">
              {Number(item.quantity).toLocaleString("pt-BR")} × {currency.format(Number(item.unit_price))}
            </span>
          </li>
        ))}
      </ul>
      <p className="request-split">{splitSummary(request, membersById)}</p>
      {request.note && <p className="request-note">“{request.note}”</p>}
    </>
  );
}

function ReviewForms({ request, redirectTo }: { request: PurchaseRequestRow; redirectTo: string }) {
  const [state, action] = useActionState(reviewShoppingPurchaseRequest, initialFormActionState);
  useRefreshOnSuccess(state.status);

  return (
    <div className="request-actions">
      <form action={action}>
        <input type="hidden" name="request_id" value={request.id} />
        <input type="hidden" name="decision" value="approve" />
        <input type="hidden" name="redirect_to" value={redirectTo} />
        <SubmitButton className="button primary" pendingLabel="Aprovando…">
          Aprovar e lançar
        </SubmitButton>
      </form>
      <details className="disclosure">
        <summary>Recusar</summary>
        <form action={action} className="stack-form disclosure-body">
          <input type="hidden" name="request_id" value={request.id} />
          <input type="hidden" name="decision" value="reject" />
          <input type="hidden" name="redirect_to" value={redirectTo} />
          <label className="field">
            Motivo (opcional, aparece para quem enviou)
            <input name="review_note" maxLength={300} autoComplete="off" placeholder="Ex.: item já foi comprado…" />
          </label>
          <SubmitButton className="button danger" pendingLabel="Recusando…">
            Confirmar recusa
          </SubmitButton>
        </form>
      </details>
      <FormActionMessage state={state} inline />
    </div>
  );
}

function CancelForm({ requestId, redirectTo }: { requestId: string; redirectTo: string }) {
  const [state, action] = useActionState(cancelShoppingPurchaseRequest, initialFormActionState);
  useRefreshOnSuccess(state.status);
  return (
    <form action={action} className="request-actions">
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <SubmitButton className="button ghost small" pendingLabel="Cancelando…">
        Cancelar envio
      </SubmitButton>
      <FormActionMessage state={state} inline />
    </form>
  );
}

/** Compras enviadas por moradores que aguardam quem pode aprovar. */
export function PendingPurchaseRequests({
  requests,
  members,
  redirectTo,
}: {
  requests: PurchaseRequestRow[];
  members: Member[];
  redirectTo: string;
}) {
  const membersById = new Map(members.map((member) => [member.id, member]));
  return (
    <ul className="request-list">
      {requests.map((request) => (
        <li className="request-card" key={request.id}>
          <div className="request-head">
            <div>
              <strong>{membersById.get(request.requested_by_member_id)?.name ?? "Morador"}</strong>
              <small>enviou em {formatDateTime(request.created_at)}</small>
            </div>
            <strong className="request-total">{currency.format(Number(request.total_amount))}</strong>
          </div>
          <RequestSummary request={request} membersById={membersById} />
          <ReviewForms request={request} redirectTo={redirectTo} />
        </li>
      ))}
    </ul>
  );
}

/** Compras que o próprio morador enviou, com o resultado da revisão. */
export function MyPurchaseRequests({
  requests,
  members,
  redirectTo,
}: {
  requests: PurchaseRequestRow[];
  members: Member[];
  redirectTo: string;
}) {
  const membersById = new Map(members.map((member) => [member.id, member]));
  return (
    <ul className="request-list">
      {requests.map((request) => {
        const status = STATUS_LABELS[request.status];
        return (
          <li className="request-card" key={request.id}>
            <div className="request-head">
              <div>
                <span className={`status-pill ${status.tone}`}>{status.label}</span>
                <small>{formatDateTime(request.created_at)}</small>
              </div>
              <strong className="request-total">{currency.format(Number(request.total_amount))}</strong>
            </div>
            <RequestSummary request={request} membersById={membersById} />
            {request.status === "rejected" && request.review_note && (
              <p className="message error">Motivo: {request.review_note}</p>
            )}
            {request.status === "pending" && (
              <CancelForm requestId={request.id} redirectTo={redirectTo} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
