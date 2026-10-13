"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { CheckIcon, FireIcon, SettingsIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import {
  initialFormActionState,
  type FormActionState,
} from "@/lib/form-action-state";
import {
  changeStoveCleaningTurn,
  confirmStoveCleaning,
  saveStoveCleaningRotation,
} from "./stove-cleaning-actions";

export type StoveCleaningMember = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
};

export type StoveCleaningHistoryEntry = {
  id: string;
  member_id: string | null;
  member_name_snapshot: string;
  cleaned_at: string;
  next_member_id: string | null;
  next_member_name_snapshot: string | null;
  note: string | null;
};

const STOVE_CLIENT_TIMEOUT_MS = 20_000;

type StoveAction = (
  previousState: FormActionState,
  formData: FormData,
) => Promise<FormActionState>;

async function runStoveActionWithTimeout(
  action: StoveAction,
  previousState: FormActionState,
  formData: FormData,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FormActionState>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        status: "error",
        message: "A ação não respondeu a tempo. O rodízio será atualizado automaticamente para conferir o resultado.",
      });
    }, STOVE_CLIENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([action(previousState, formData), timeout]);
  } catch {
    return {
      status: "error" as const,
      message: "Não foi possível concluir a ação. O rodízio será atualizado automaticamente para conferir o estado atual.",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function saveStoveRotationWithTimeout(
  previousState: FormActionState,
  formData: FormData,
) {
  return runStoveActionWithTimeout(
    saveStoveCleaningRotation,
    previousState,
    formData,
  );
}

function changeStoveTurnWithTimeout(
  previousState: FormActionState,
  formData: FormData,
) {
  return runStoveActionWithTimeout(
    changeStoveCleaningTurn,
    previousState,
    formData,
  );
}

function confirmStoveCleaningWithTimeout(
  previousState: FormActionState,
  formData: FormData,
) {
  return runStoveActionWithTimeout(
    confirmStoveCleaning,
    previousState,
    formData,
  );
}

function isUncertainResult(state: FormActionState) {
  if (state.status !== "error") return false;
  const message = state.message.toLocaleLowerCase("pt-BR");
  return (
    message.includes("demorou") ||
    message.includes("não respondeu a tempo") ||
    message.includes("sincroniz") ||
    message.includes("conferir o estado")
  );
}

function useRefreshAfterResult(state: FormActionState) {
  const router = useRouter();

  useEffect(() => {
    if (state.status === "idle") return;

    const uncertain = isUncertainResult(state);
    if (state.status !== "success" && !uncertain) return;

    router.refresh();
    if (!uncertain) return;

    const retryIds = [2_000, 5_000, 10_000].map((delay) =>
      window.setTimeout(() => router.refresh(), delay),
    );
    return () => retryIds.forEach((retryId) => window.clearTimeout(retryId));
  }, [router, state.message, state.status]);
}

function formatStoveDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data não informada";

  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  });
}

function shortMemberName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const belo = parts.find((part) => part.toLocaleLowerCase("pt-BR") === "belo");
  return belo ?? parts[0] ?? name;
}

export function StoveCleaningManager({
  initialMembers,
  availableMembers,
  currentMemberId,
  currentSince,
  currentTurnNumber,
  history,
  canManage,
  configurationReady,
  loadError,
}: {
  initialMembers: StoveCleaningMember[];
  availableMembers: StoveCleaningMember[];
  currentMemberId: string | null;
  currentSince: string | null;
  currentTurnNumber: number | string | null;
  history: StoveCleaningHistoryEntry[];
  canManage: boolean;
  configurationReady: boolean;
  loadError: string | null;
}) {
  const [draftMembers, setDraftMembers] = useState(initialMembers);
  const [selectedCurrentId, setSelectedCurrentId] = useState(
    currentMemberId ?? initialMembers[0]?.id ?? "",
  );
  const confirmFormRef = useRef<HTMLFormElement>(null);
  const turnFormRef = useRef<HTMLFormElement>(null);
  const [orderState, orderAction] = useActionState(
    saveStoveRotationWithTimeout,
    initialFormActionState,
  );
  const [turnState, turnAction] = useActionState(
    changeStoveTurnWithTimeout,
    initialFormActionState,
  );
  const [confirmState, confirmAction] = useActionState(
    confirmStoveCleaningWithTimeout,
    initialFormActionState,
  );

  useEffect(() => setDraftMembers(initialMembers), [initialMembers]);
  useEffect(() => {
    setSelectedCurrentId(
      initialMembers.some((member) => member.id === currentMemberId)
        ? (currentMemberId ?? "")
        : (initialMembers[0]?.id ?? ""),
    );
  }, [currentMemberId, initialMembers]);
  useRefreshAfterResult(orderState);
  useRefreshAfterResult(turnState);
  useRefreshAfterResult(confirmState);

  useEffect(() => {
    if (turnState.status === "success") turnFormRef.current?.reset();
  }, [turnState]);
  useEffect(() => {
    if (confirmState.status === "success") confirmFormRef.current?.reset();
  }, [confirmState]);

  const currentMember = initialMembers.find(
    (member) => member.id === currentMemberId,
  );
  const nextMember = useMemo(() => {
    if (!configurationReady || !currentMemberId || initialMembers.length === 0) {
      return null;
    }

    const currentIndex = initialMembers.findIndex(
      (member) => member.id === currentMemberId,
    );
    return currentIndex < 0
      ? null
      : initialMembers[(currentIndex + 1) % initialMembers.length];
  }, [configurationReady, currentMemberId, initialMembers]);
  const membersOutsideRotation = useMemo(() => {
    const participantIds = new Set(draftMembers.map((member) => member.id));
    return availableMembers.filter((member) => !participantIds.has(member.id));
  }, [availableMembers, draftMembers]);

  function move(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draftMembers.length) return;

    setDraftMembers((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  function addMember(memberId: string) {
    const member = availableMembers.find((candidate) => candidate.id === memberId);
    if (!member || draftMembers.some((candidate) => candidate.id === memberId)) {
      return;
    }
    setDraftMembers((current) => [...current, member]);
  }

  function removeMember(memberId: string) {
    setDraftMembers((current) =>
      current.filter((member) => member.id !== memberId),
    );
  }

  return (
    <section className="card stove-cleaning-card" id="rodizio-fogao">
      <div className="card-head stove-cleaning-head">
        <div>
          <h2>Rodízio de limpeza do fogão</h2>
          <span className="muted-text">
            Sem prazo fixo: a vez só avança quando a limpeza é confirmada.
          </span>
        </div>
        <FireIcon />
      </div>

      <div className="stove-cleaning-body">
        {loadError && (
          <div className="message error stove-load-error" role="alert">
            {loadError}
          </div>
        )}

        <div className="stove-current-turn">
          {currentMember ? (
            <>
              <div className={`avatar avatar-${currentMember.color_key}`}>
                {currentMember.initials}
              </div>
              <div className="stove-current-copy">
                <span>Agora é a vez de</span>
                <strong>{currentMember.name}</strong>
                <small>
                  {currentSince
                    ? `Nesta posição desde ${formatStoveDate(currentSince)}`
                    : "Aguardando a primeira limpeza"}
                </small>
              </div>
              {nextMember && (
                <div className="stove-next-turn">
                  <span>Próxima pessoa</span>
                  <div>
                    <div className={`avatar avatar-${nextMember.color_key}`}>
                      {nextMember.initials}
                    </div>
                    <strong>{nextMember.name}</strong>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              {loadError
                ? "O estado atual do rodízio está indisponível."
                : "Aguardando a configuração inicial do rodízio."}
            </div>
          )}
        </div>

        {!loadError && !configurationReady && (
          <div className="message info stove-configuration-note">
            {canManage
              ? "Salve a ordem e defina a primeira pessoa para iniciar este rodízio."
              : "O administrador ainda precisa concluir a configuração deste rodízio."}
          </div>
        )}

        {configurationReady && currentMember && currentTurnNumber !== null && (
          <form
            ref={confirmFormRef}
            action={confirmAction}
            className="stove-confirm-form"
          >
            <input
              type="hidden"
              name="expected_member_id"
              value={currentMember.id}
            />
            <input
              type="hidden"
              name="expected_turn_number"
              value={String(currentTurnNumber)}
            />
            <div className="stove-confirm-copy">
              <strong>O fogão já foi limpo?</strong>
              <small>
                Qualquer morador pode confirmar. A vez passará para {nextMember
                  ? shortMemberName(nextMember.name)
                  : "a próxima pessoa"}.
              </small>
            </div>
            <label className="field stove-confirm-note">
              Observação
              <input
                name="note"
                maxLength={300}
                placeholder="Opcional"
              />
            </label>
            <SubmitButton pendingLabel="Confirmando...">
              <CheckIcon /> Confirmar que {shortMemberName(currentMember.name)} limpou
            </SubmitButton>
            <FormActionMessage state={confirmState} inline />
          </form>
        )}

        <div
          className="stove-rotation-strip"
          aria-label="Ordem do rodízio de limpeza do fogão"
          role="list"
        >
          {initialMembers.map((member, index) => (
            <div
              className={`stove-rotation-person ${member.id === currentMemberId ? "current" : ""}`}
              key={member.id}
              role="listitem"
              aria-current={member.id === currentMemberId ? "step" : undefined}
            >
              <span>{index + 1}</span>
              <div className={`avatar avatar-${member.color_key}`}>
                {member.initials}
              </div>
              <strong>{shortMemberName(member.name)}</strong>
            </div>
          ))}
        </div>

        {canManage && (
          <details
            className="details-editor stove-cleaning-settings"
            open={!configurationReady ? true : undefined}
          >
            <summary>
              <SettingsIcon /> Alterar ordem ou pessoa da vez
            </summary>
            <div className="editor-body stove-cleaning-settings-body">
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
                        <button
                          type="button"
                          className="icon-button stove-remove-member"
                          onClick={() => removeMember(member.id)}
                          aria-label={`Retirar ${member.name} do rodízio`}
                          title="Retirar do rodízio"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                  {draftMembers.length === 0 && (
                    <div className="empty stove-editor-empty">
                      Inclua pelo menos duas pessoas para montar a ordem.
                    </div>
                  )}
                </div>
                <div className="stove-available-members">
                  <div>
                    <strong>Fora do rodízio</strong>
                    <small>Use “Incluir” para adicionar uma pessoa ao fim da fila.</small>
                  </div>
                  <div className="stove-available-member-list">
                    {membersOutsideRotation.map((member) => (
                      <div className="stove-available-member" key={member.id}>
                        <div className={`avatar avatar-${member.color_key}`}>
                          {member.initials}
                        </div>
                        <strong>{member.name}</strong>
                        <button
                          type="button"
                          className="button ghost small"
                          onClick={() => addMember(member.id)}
                        >
                          + Incluir
                        </button>
                      </div>
                    ))}
                    {membersOutsideRotation.length === 0 && (
                      <small className="muted-text">
                        Todos os moradores ativos já estão nesta ordem.
                      </small>
                    )}
                  </div>
                </div>
                {draftMembers.length < 2 && (
                  <div className="message info stove-minimum-members">
                    O rodízio precisa ter pelo menos duas pessoas.
                  </div>
                )}
                <SubmitButton
                  className="button secondary"
                  pendingLabel="Salvando ordem..."
                  disabled={draftMembers.length < 2}
                >
                  Salvar ordem
                </SubmitButton>
                <FormActionMessage state={orderState} inline />
              </form>

              <form
                ref={turnFormRef}
                action={turnAction}
                className="stove-change-turn-form"
              >
                <label className="field">
                  Definir manualmente a pessoa da vez
                  <select
                    name="member_id"
                    required
                    value={selectedCurrentId}
                    onChange={(event) => setSelectedCurrentId(event.target.value)}
                    disabled={initialMembers.length === 0}
                  >
                    {initialMembers.length === 0 && (
                      <option value="">Salve uma ordem primeiro</option>
                    )}
                    {initialMembers.map((member) => (
                      <option value={member.id} key={member.id}>
                        {member.name}
                      </option>
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
                  disabled={!selectedCurrentId}
                >
                  Alterar pessoa da vez
                </SubmitButton>
                <FormActionMessage state={turnState} inline />
              </form>
            </div>
          </details>
        )}

        <details className="stove-cleaning-history" open={history.length > 0}>
          <summary>Últimas limpezas ({history.length})</summary>
          <div className="stove-cleaning-history-list">
            {history.map((entry) => (
              <div className="stove-cleaning-history-row" key={entry.id}>
                <div>
                  <strong>{entry.member_name_snapshot}</strong>
                  <small>{entry.note || "Limpeza confirmada"}</small>
                </div>
                <div className="item-value">
                  <strong>{formatStoveDate(entry.cleaned_at)}</strong>
                  <small>
                    {entry.next_member_name_snapshot
                      ? `Próxima: ${entry.next_member_name_snapshot}`
                      : "Sem próxima pessoa definida"}
                  </small>
                </div>
              </div>
            ))}
            {history.length === 0 && (
              <div className="empty">Nenhuma limpeza registrada.</div>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
