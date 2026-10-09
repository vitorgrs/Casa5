"use client";

import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { CheckIcon, SettingsIcon, WaterIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { formatHouseDate, todayIso } from "@/lib/chore-rotation";
import { currency } from "@/lib/format";
import {
  initialFormActionState,
  type FormActionState,
} from "@/lib/form-action-state";
import {
  changeWaterGallonTurn,
  recordWaterGallonManualPayment,
  reviewWaterGallonPurchase,
  saveWaterGallonRotation,
} from "./water-gallon-actions";

export type WaterGallonMember = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
};

export type WaterGallonSuggestion = {
  purchase_id: string;
  paid_by_member_id: string;
  bought_at: string;
  total_amount: number | string;
  item_names: string[];
};

export type WaterGallonPayment = {
  id: string;
  member_id: string | null;
  member_name_snapshot: string;
  paid_on: string;
  source: "initial" | "manual" | "shopping_purchase";
  purchase_id: string | null;
  next_member_id: string | null;
  next_member_name_snapshot: string | null;
  note: string | null;
};

const sourceLabels: Record<WaterGallonPayment["source"], string> = {
  initial: "Registro inicial",
  manual: "Confirmado manualmente",
  shopping_purchase: "Compra identificada",
};

function useRefreshAfterSuccess(state: FormActionState) {
  const router = useRouter();
  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state]);
}

function WaterGallonSuggestionCard({
  suggestion,
  payer,
  canManage,
}: {
  suggestion: WaterGallonSuggestion;
  payer: WaterGallonMember | undefined;
  canManage: boolean;
}) {
  const [confirmState, confirmAction, confirmPending] = useActionState(
    reviewWaterGallonPurchase,
    initialFormActionState,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState(
    reviewWaterGallonPurchase,
    initialFormActionState,
  );
  const [lastDecision, setLastDecision] = useState<"confirm" | "reject" | null>(
    null,
  );
  useRefreshAfterSuccess(confirmState);
  useRefreshAfterSuccess(rejectState);
  const visibleState =
    lastDecision === "confirm"
      ? confirmState
      : lastDecision === "reject"
        ? rejectState
        : initialFormActionState;

  return (
    <article className="water-suggestion-card">
      <div className="water-suggestion-copy">
        <span className="eyebrow bright">Possível pagamento encontrado</span>
        <strong>{suggestion.item_names.join(", ") || "Galão de água"}</strong>
        <small>
          Pago por {payer?.name ?? "morador da vez"} em{" "}
          {new Date(suggestion.bought_at).toLocaleDateString("pt-BR", {
            timeZone: "America/Sao_Paulo",
          })}
          {" • "}
          {currency.format(Number(suggestion.total_amount))}
        </small>
        <p>
          A pessoa que registrou esta compra é a mesma pessoa da vez. {canManage
            ? "Deseja confirmar que este foi o pagamento do galão?"
            : "A confirmação está aguardando o administrador."}
        </p>
      </div>
      {canManage ? (
        <div className="water-suggestion-actions">
          <form action={confirmAction} onSubmit={() => setLastDecision("confirm")}>
            <input
              type="hidden"
              name="purchase_id"
              value={suggestion.purchase_id}
            />
            <input type="hidden" name="decision" value="confirm" />
            <SubmitButton
              className="button primary small"
              pendingLabel="Confirmando..."
              disabled={rejectPending}
            >
              <CheckIcon /> Sim, confirmar
            </SubmitButton>
          </form>
          <form action={rejectAction} onSubmit={() => setLastDecision("reject")}>
            <input
              type="hidden"
              name="purchase_id"
              value={suggestion.purchase_id}
            />
            <input type="hidden" name="decision" value="reject" />
            <SubmitButton
              className="button ghost small"
              pendingLabel="Recusando..."
              disabled={confirmPending}
            >
              Não, manter a vez
            </SubmitButton>
          </form>
        </div>
      ) : (
        <span className="status-pill warning">Aguardando o administrador</span>
      )}
      <FormActionMessage state={visibleState} inline />
    </article>
  );
}

export function WaterGallonManager({
  initialMembers,
  currentMemberId,
  currentSince,
  suggestions,
  payments,
  canManage,
  configurationReady,
  loadError,
}: {
  initialMembers: WaterGallonMember[];
  currentMemberId: string | null;
  currentSince: string | null;
  suggestions: WaterGallonSuggestion[];
  payments: WaterGallonPayment[];
  canManage: boolean;
  configurationReady: boolean;
  loadError: string | null;
}) {
  const [draftMembers, setDraftMembers] = useState(initialMembers);
  const [selectedCurrentId, setSelectedCurrentId] = useState(
    currentMemberId ?? initialMembers[0]?.id ?? "",
  );
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const paymentFormRef = useRef<HTMLFormElement>(null);
  const turnFormRef = useRef<HTMLFormElement>(null);
  const [orderState, orderAction] = useActionState(
    saveWaterGallonRotation,
    initialFormActionState,
  );
  const [turnState, turnAction] = useActionState(
    changeWaterGallonTurn,
    initialFormActionState,
  );
  const [paymentState, paymentAction] = useActionState(
    recordWaterGallonManualPayment,
    initialFormActionState,
  );

  useEffect(() => setDraftMembers(initialMembers), [initialMembers]);
  useEffect(() => {
    setSelectedCurrentId(currentMemberId ?? initialMembers[0]?.id ?? "");
  }, [currentMemberId, initialMembers]);
  useRefreshAfterSuccess(orderState);
  useRefreshAfterSuccess(turnState);
  useRefreshAfterSuccess(paymentState);
  useEffect(() => {
    if (turnState.status === "success") {
      turnFormRef.current?.reset();
    }
  }, [turnState]);
  useEffect(() => {
    if (paymentState.status === "success") {
      paymentFormRef.current?.reset();
      setPaymentDate(todayIso());
    }
  }, [paymentState]);

  const currentMember = initialMembers.find(
    (member) => member.id === currentMemberId,
  );
  const latestPayment = payments[0] ?? null;
  const nextMember = useMemo(() => {
    if (!configurationReady || !currentMemberId || initialMembers.length === 0) {
      return null;
    }
    const index = initialMembers.findIndex(
      (member) => member.id === currentMemberId,
    );
    return index < 0
      ? null
      : initialMembers[(index + 1) % initialMembers.length];
  }, [configurationReady, currentMemberId, initialMembers]);

  function move(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draftMembers.length) return;
    setDraftMembers((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  return (
    <section className="card water-gallon-card" id="rodizio-galao">
      <div className="card-head water-gallon-head">
        <div>
          <h2>Rodízio do galão de água</h2>
          <span className="muted-text">
            A vez avança somente depois de um pagamento confirmado.
          </span>
        </div>
        <WaterIcon />
      </div>

      <div className="water-gallon-body">
        {loadError && (
          <div className="message error water-load-error" role="alert">
            {loadError}
          </div>
        )}

        <div className="water-current-turn">
          {currentMember ? (
            <>
              <div className={`avatar avatar-${currentMember.color_key}`}>
                {currentMember.initials}
              </div>
              <div>
                <span>Agora é a vez de</span>
                <strong>{currentMember.name}</strong>
                <small>
                  {currentSince
                    ? `Nesta posição desde ${new Date(currentSince).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
                    : "Aguardando o primeiro registro"}
                  {nextMember ? ` • Depois: ${nextMember.name}` : ""}
                </small>
                {latestPayment && (
                  <small className="water-last-payment">
                    Último pagamento: {latestPayment.member_name_snapshot} •{" "}
                    {formatHouseDate(latestPayment.paid_on)}
                  </small>
                )}
              </div>
            </>
          ) : (
            <div className="empty">
              {loadError
                ? "O estado atual do rodízio está indisponível."
                : "Configure a ordem inicial do rodízio."}
            </div>
          )}
        </div>

        {!canManage && (
          <div className="message info water-viewer-note">
            Apenas o administrador pode confirmar pagamentos e alterar o rodízio.
          </div>
        )}

        {!loadError && !configurationReady && (
          <div className="message info water-configuration-note">
            {canManage
              ? "A ordem precisa ser salva com todos os moradores ativos antes de registrar pagamentos."
              : "O administrador precisa concluir a configuração deste rodízio."}
          </div>
        )}

        {canManage && configurationReady && currentMember && (
          <form
            ref={paymentFormRef}
            action={paymentAction}
            className="water-manual-payment-form"
          >
            <input
              type="hidden"
              name="expected_member_id"
              value={currentMember.id}
            />
            <label className="field">
              Data do pagamento
              <input
                type="date"
                name="paid_on"
                required
                max={todayIso()}
                value={paymentDate}
                onChange={(event) => setPaymentDate(event.target.value)}
              />
            </label>
            <label className="field water-payment-note">
              Observação
              <input
                name="note"
                maxLength={300}
                placeholder="Opcional"
              />
            </label>
            <SubmitButton pendingLabel="Confirmando...">
              <CheckIcon /> Confirmar que {currentMember.name.split(" ")[0]} pagou
            </SubmitButton>
            <FormActionMessage state={paymentState} inline />
          </form>
        )}

        {configurationReady && suggestions.length > 0 && (
          <div className="water-suggestions">
            {suggestions.map((suggestion) => (
              <WaterGallonSuggestionCard
                key={suggestion.purchase_id}
                suggestion={suggestion}
                payer={initialMembers.find(
                  (member) => member.id === suggestion.paid_by_member_id,
                )}
                canManage={canManage}
              />
            ))}
          </div>
        )}

        <div
          className="water-rotation-strip"
          aria-label="Ordem do rodízio"
          role="list"
        >
          {initialMembers.map((member, index) => (
            <div
              className={`water-rotation-person ${member.id === currentMemberId ? "current" : ""}`}
              key={member.id}
              role="listitem"
              aria-current={member.id === currentMemberId ? "step" : undefined}
            >
              <span>{index + 1}</span>
              <div className={`avatar avatar-${member.color_key}`}>
                {member.initials}
              </div>
              <strong>{member.name.split(" ")[0]}</strong>
            </div>
          ))}
        </div>

        {canManage && (
          <details className="details-editor water-gallon-settings">
            <summary><SettingsIcon /> Alterar ordem ou pessoa da vez</summary>
            <div className="editor-body water-gallon-settings-body">
              <form action={orderAction} className="stack-form">
                {draftMembers.map((member) => (
                  <input
                    type="hidden"
                    name="member_ids"
                    value={member.id}
                    key={member.id}
                  />
                ))}
                <div className="rotation-order-list">
                  {draftMembers.map((member, index) => (
                    <div className="rotation-order-row" key={member.id}>
                      <span className="rotation-position">{index + 1}</span>
                      <div className={`avatar avatar-${member.color_key}`}>
                        {member.initials}
                      </div>
                      <strong>{member.name}</strong>
                      <div className="rotation-order-actions">
                        <button
                          type="button"
                          className="icon-button"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          aria-label={`Mover ${member.name} para cima`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          disabled={index === draftMembers.length - 1}
                          onClick={() => move(index, 1)}
                          aria-label={`Mover ${member.name} para baixo`}
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <SubmitButton className="button secondary" pendingLabel="Salvando ordem...">
                  Salvar ordem
                </SubmitButton>
                <FormActionMessage state={orderState} inline />
              </form>

              <form
                ref={turnFormRef}
                action={turnAction}
                className="water-change-turn-form"
              >
                <label className="field">
                  Definir manualmente a pessoa da vez
                  <select
                    name="member_id"
                    required
                    value={selectedCurrentId}
                    onChange={(event) => setSelectedCurrentId(event.target.value)}
                  >
                    {initialMembers.map((member) => (
                      <option value={member.id} key={member.id}>{member.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Motivo da alteração
                  <input name="note" maxLength={300} placeholder="Opcional" />
                </label>
                <SubmitButton
                  className="button ghost"
                  pendingLabel="Alterando..."
                >
                  Alterar pessoa da vez
                </SubmitButton>
                <FormActionMessage state={turnState} inline />
              </form>
            </div>
          </details>
        )}

        <details className="water-payment-history">
          <summary>Últimos pagamentos ({payments.length})</summary>
          <div className="water-payment-history-list">
            {payments.map((payment) => (
              <div className="water-payment-history-row" key={payment.id}>
                <div>
                  <strong>{payment.member_name_snapshot}</strong>
                  <small>
                    {sourceLabels[payment.source]}
                    {payment.note ? ` • ${payment.note}` : ""}
                  </small>
                </div>
                <div className="item-value">
                  <strong>{formatHouseDate(payment.paid_on)}</strong>
                  <small>
                    {payment.next_member_name_snapshot
                      ? `Próximo: ${payment.next_member_name_snapshot}`
                      : "Sem próximo definido"}
                  </small>
                </div>
              </div>
            ))}
            {payments.length === 0 && (
              <div className="empty">Nenhum pagamento registrado.</div>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
