"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { PlusIcon } from "@/components/icons";
import { SubmitButton } from "@/components/submit-button";
import { currency } from "@/lib/format";
import { initialFormActionState, type FormActionState } from "@/lib/form-action-state";
import {
  addShoppingItem,
  deleteShoppingItem,
  recordShoppingPurchase,
  removeItemFromShoppingPurchase,
  resetShoppingPurchase,
  toggleShoppingChecked,
  updateShoppingItem,
} from "./actions";

type Member = {
  id: string;
  name: string;
};

type ShoppingItem = {
  id: string;
  name: string;
  note: string | null;
  category: string | null;
  status: "list" | "checked";
  quantity_planned: number | string | null;
  unit_price: number | string | null;
};

type PurchaseScope = "household" | "group" | "individual";
type SplitMode = "equal" | "custom";

const PURCHASE_CLIENT_TIMEOUT_MS = 20_000;
const PURCHASE_MUTATION_CLIENT_TIMEOUT_MS = 20_000;

type ShoppingMutationAction = (
  previousState: FormActionState,
  formData: FormData,
) => Promise<FormActionState>;

async function runShoppingMutationWithTimeout(
  action: ShoppingMutationAction,
  previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FormActionState>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        status: "error",
        message: "A ação não respondeu a tempo. O histórico será atualizado automaticamente para conferir se ela foi concluída.",
      });
    }, PURCHASE_MUTATION_CLIENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([action(previousState, formData), timeout]);
  } catch {
    return {
      status: "error",
      message: "Não foi possível concluir a ação. O histórico será atualizado automaticamente para conferir o estado da compra.",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function removeShoppingItemWithTimeout(
  previousState: FormActionState,
  formData: FormData,
) {
  return runShoppingMutationWithTimeout(
    removeItemFromShoppingPurchase,
    previousState,
    formData,
  );
}

function resetShoppingPurchaseWithTimeout(
  previousState: FormActionState,
  formData: FormData,
) {
  return runShoppingMutationWithTimeout(
    resetShoppingPurchase,
    previousState,
    formData,
  );
}

async function recordShoppingPurchaseWithTimeout(
  previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FormActionState>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        status: "error",
        message: "Não recebemos uma resposta a tempo. Os itens e valores foram mantidos; aguarde alguns segundos e tente novamente.",
      });
    }, PURCHASE_CLIENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      recordShoppingPurchase(previousState, formData),
      timeout,
    ]);
  } catch {
    return {
      status: "error",
      message: "Não foi possível falar com o servidor. Os itens e valores foram mantidos; tente novamente.",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function hundredthsFromInput(value: string) {
  let normalized = value.trim().replace(/\s/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }
  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) return 0;
  const fraction = `${match[3] ?? ""}000`;
  let hundredths = Number(match[2]) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) hundredths += 1;
  if (!Number.isSafeInteger(hundredths)) return 0;
  return match[1] === "-" ? -hundredths : hundredths;
}

export function ShoppingItemCreateForm({ redirectTo }: { redirectTo: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(addShoppingItem, initialFormActionState);

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="form-grid cols-3">
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <label className="field">
        Item
        <input name="name" required placeholder="Ex.: Arroz" />
      </label>
      <label className="field">
        Quantidade planejada
        <input name="quantity_planned" inputMode="decimal" placeholder="Ex.: 2" />
      </label>
      <label className="field">
        Valor unitário previsto
        <input name="unit_price" inputMode="decimal" placeholder="Ex.: 12,50" />
      </label>
      <label className="field">
        Categoria
        <input name="category" placeholder="Ex.: Mercearia" />
      </label>
      <label className="field span-2">
        Observação
        <input name="note" placeholder="Opcional" />
      </label>
      <div className="span-3">
        <FormActionMessage state={state} />
      </div>
      <div className="form-actions span-3">
        <SubmitButton className="button secondary" pendingLabel="Adicionando...">
          <PlusIcon /> Adicionar à lista
        </SubmitButton>
      </div>
    </form>
  );
}

export function ShoppingListManager({
  items,
  members,
  canManage,
  redirectTo,
}: {
  items: ShoppingItem[];
  members: Member[];
  canManage: boolean;
  redirectTo: string;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    const availableIds = new Set(items.map((item) => item.id));
    setSelectedIds((current) => {
      const next = current.filter((id) => availableIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [items]);

  const selectedItems = items.filter((item) => selectedIds.includes(item.id));

  function toggleSelected(itemId: string) {
    setSelectedIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    );
  }

  return (
    <>
      <div className="shopping-toolbar">
        <div className="shopping-selection-count">
          <strong>{selectedIds.length}</strong>
          <span>item(ns) selecionado(s)</span>
        </div>
      </div>

      <div className="shopping-select-list">
        {items.length === 0 && <div className="empty">Nenhum item na lista.</div>}
        {items.map((item) => (
          <article className={`shopping-select-row ${selectedIds.includes(item.id) ? "selected" : ""}`} key={item.id}>
            <label className="shopping-select-main">
              <input
                type="checkbox"
                checked={selectedIds.includes(item.id)}
                onChange={() => toggleSelected(item.id)}
                disabled={!canManage}
              />
              <span className="item-title">
                <strong>{item.name}</strong>
                <small>
                  {item.quantity_planned ? `${item.quantity_planned} planejado(s) • ` : ""}
                  {item.category ?? "Sem categoria"}
                  {item.unit_price !== null
                    ? ` • ${currency.format(Number(item.unit_price))} por unidade`
                    : " • valor a definir"}
                </small>
              </span>
            </label>

            <span className={`status-pill ${item.status === "checked" ? "success" : "info"}`}>
              {item.status === "checked" ? "No carrinho" : "Falta comprar"}
            </span>

            {canManage && (
              <ShoppingItemToggleForm item={item} redirectTo={redirectTo} />
            )}

            {canManage && (
              <details className="shopping-inline-editor">
                <summary>Editar</summary>
                <ShoppingItemEditForm item={item} redirectTo={redirectTo} />
              </details>
            )}

            {canManage && (
              <ShoppingItemDeleteForm itemId={item.id} redirectTo={redirectTo} />
            )}
          </article>
        ))}
      </div>

      {canManage && selectedItems.length > 0 && (
        <PurchaseCheckoutForm
          items={selectedItems}
          members={members}
          redirectTo={redirectTo}
          onCancel={() => setSelectedIds([])}
          onSuccess={() => setSelectedIds([])}
        />
      )}
    </>
  );
}

function ShoppingItemToggleForm({
  item,
  redirectTo,
}: {
  item: ShoppingItem;
  redirectTo: string;
}) {
  const [state, formAction] = useActionState(
    toggleShoppingChecked,
    initialFormActionState,
  );

  return (
    <form action={formAction} className="inline-mutation-form">
      <input type="hidden" name="item_id" value={item.id} />
      <input
        type="hidden"
        name="next_status"
        value={item.status === "checked" ? "list" : "checked"}
      />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <SubmitButton className="button ghost small" pendingLabel="Salvando...">
        {item.status === "checked" ? "Desmarcar carrinho" : "Marcar no carrinho"}
      </SubmitButton>
      {state.status === "error" && <FormActionMessage state={state} inline />}
    </form>
  );
}

function ShoppingItemEditForm({
  item,
  redirectTo,
}: {
  item: ShoppingItem;
  redirectTo: string;
}) {
  const [state, formAction] = useActionState(updateShoppingItem, initialFormActionState);

  return (
    <form action={formAction} className="stack-form">
      <input type="hidden" name="item_id" value={item.id} />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <label>
        Nome
        <input name="name" defaultValue={item.name} required />
      </label>
      <label>
        Quantidade planejada
        <input
          name="quantity_planned"
          inputMode="decimal"
          defaultValue={item.quantity_planned ?? ""}
        />
      </label>
      <label>
        Valor unitário previsto
        <input
          name="unit_price"
          inputMode="decimal"
          defaultValue={item.unit_price ?? ""}
          placeholder="0,00"
        />
      </label>
      <SubmitButton className="button secondary small" pendingLabel="Salvando...">
        Salvar
      </SubmitButton>
      <FormActionMessage state={state} inline />
    </form>
  );
}

function ShoppingItemDeleteForm({
  itemId,
  redirectTo,
}: {
  itemId: string;
  redirectTo: string;
}) {
  const [state, formAction] = useActionState(deleteShoppingItem, initialFormActionState);

  return (
    <form action={formAction} className="inline-mutation-form">
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <SubmitButton className="button danger small" pendingLabel="Excluindo...">
        Excluir
      </SubmitButton>
      {state.status === "error" && <FormActionMessage state={state} inline />}
    </form>
  );
}

function PurchaseCheckoutForm({
  items,
  members,
  redirectTo,
  onCancel,
  onSuccess,
}: {
  items: ShoppingItem[];
  members: Member[];
  redirectTo: string;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const [state, formAction] = useActionState(
    recordShoppingPurchaseWithTimeout,
    initialFormActionState,
  );
  const [scope, setScope] = useState<PurchaseScope>("household");
  const [splitMode, setSplitMode] = useState<SplitMode>("equal");
  const [payerMemberId, setPayerMemberId] = useState("");
  const [participants, setParticipants] = useState<string[]>(members.map((member) => member.id));
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((item) => [item.id, String(item.quantity_planned ?? 1)])),
  );
  const [unitPrices, setUnitPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      items.map((item) => [item.id, String(item.unit_price ?? "")]),
    ),
  );
  const [customShares, setCustomShares] = useState<Record<string, string>>({});

  useEffect(() => {
    setQuantities((current) =>
      Object.fromEntries(
        items.map((item) => [
          item.id,
          current[item.id] ?? String(item.quantity_planned ?? 1),
        ]),
      ),
    );
    setUnitPrices((current) =>
      Object.fromEntries(
        items.map((item) => [
          item.id,
          current[item.id] ?? String(item.unit_price ?? ""),
        ]),
      ),
    );
  }, [items]);

  useEffect(() => {
    if (state.status !== "success") return;
    onSuccess();
  }, [state, onSuccess]);

  const purchaseTotalCents = items.reduce(
    (sum, item) =>
      sum +
      Math.round(
        (hundredthsFromInput(quantities[item.id] ?? "0") *
          hundredthsFromInput(unitPrices[item.id] ?? "0")) /
          100,
      ),
    0,
  );
  const purchaseTotal = purchaseTotalCents / 100;
  const selectedMembers = members.filter((member) => participants.includes(member.id));
  const customTotalCents = selectedMembers.reduce(
    (sum, member) => sum + hundredthsFromInput(customShares[member.id] ?? "0"),
    0,
  );

  function changeScope(nextScope: PurchaseScope) {
    setScope(nextScope);
    setParticipants(nextScope === "household" ? members.map((member) => member.id) : []);
  }

  function toggleParticipant(memberId: string) {
    setParticipants((current) => {
      if (scope === "individual") return [memberId];
      return current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId];
    });
  }

  return (
    <div className="purchase-form-wrap" id="compra">
      <form action={formAction} className="stack-form purchase-form">
        <input type="hidden" name="redirect_to" value={redirectTo} />
        <input type="hidden" name="split_mode" value={splitMode} />
        {items.map((item) => (
          <input key={item.id} type="hidden" name="selected_item_ids" value={item.id} />
        ))}

        <div>
          <span className="eyebrow">Registrar compra</span>
          <h3 style={{ margin: "5px 0 0" }}>Valores dos itens selecionados</h3>
        </div>

        <div className="purchase-item-values">
          {items.map((item) => {
            const subtotal =
              Math.round(
                (hundredthsFromInput(quantities[item.id] ?? "0") *
                  hundredthsFromInput(unitPrices[item.id] ?? "0")) /
                  100,
              ) / 100;
            return (
              <div className="purchase-item-value-row" key={item.id}>
                <strong>{item.name}</strong>
                <label className="field">
                  Quantidade comprada
                  <input
                    name={`quantity_${item.id}`}
                    inputMode="decimal"
                    value={quantities[item.id] ?? ""}
                    onChange={(event) =>
                      setQuantities((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label className="field">
                  Valor unitário
                  <input
                    name={`unit_price_${item.id}`}
                    inputMode="decimal"
                    value={unitPrices[item.id] ?? ""}
                    onChange={(event) =>
                      setUnitPrices((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))
                    }
                    placeholder="0,00"
                    required
                  />
                </label>
                <div className="item-value">
                  <strong>
                    {subtotal.toLocaleString("pt-BR", {
                      style: "currency",
                      currency: "BRL",
                    })}
                  </strong>
                  <small>subtotal</small>
                </div>
              </div>
            );
          })}
        </div>

        <div className="purchase-total-preview">
          <span>Total desta compra</span>
          <strong>
            {purchaseTotal.toLocaleString("pt-BR", {
              style: "currency",
              currency: "BRL",
            })}
          </strong>
        </div>

        <label className="field">
          Quem pagou a compra inteira?
          <select
            name="paid_by_member_id"
            required
            value={payerMemberId}
            onChange={(event) => setPayerMemberId(event.target.value)}
          >
            <option value="" disabled>Selecione o pagador</option>
            {members.map((member) => (
              <option value={member.id} key={member.id}>{member.name}</option>
            ))}
          </select>
        </label>

        <div className="form-section">
          <h4>Para quem foi esta compra?</h4>
          <div className="purchase-scope-grid">
            {([
              ["household", "Casa toda", "Divide entre todos os moradores ativos."],
              ["group", "Grupo", "Escolha duas ou mais pessoas."],
              ["individual", "Individual", "O valor fica para uma única pessoa."],
            ] as const).map(([value, title, detail]) => (
              <label className={`purchase-scope ${scope === value ? "selected" : ""}`} key={value}>
                <input
                  type="radio"
                  name="purchase_scope"
                  value={value}
                  checked={scope === value}
                  onChange={() => changeScope(value)}
                />
                <span><strong>{title}</strong><small>{detail}</small></span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-section">
          <h4>{scope === "household" ? "Participantes incluídos" : "Selecione os participantes"}</h4>
          <div className="member-check-grid">
            {members.map((member) => {
              const checked = participants.includes(member.id);
              return (
                <label className={`member-check ${checked ? "selected" : ""}`} key={member.id}>
                  <input
                    type={scope === "individual" ? "radio" : "checkbox"}
                    name={scope === "individual" ? "participant_choice" : undefined}
                    checked={checked}
                    disabled={scope === "household"}
                    onChange={() => toggleParticipant(member.id)}
                  />
                  <span>{member.name}</span>
                  {checked && <input type="hidden" name="participant_ids" value={member.id} />}
                </label>
              );
            })}
          </div>
        </div>

        <div className="form-section">
          <label className="field">
            Como dividir o valor?
            <select
              value={splitMode}
              onChange={(event) => setSplitMode(event.target.value as SplitMode)}
            >
              <option value="equal">Igualmente entre os participantes</option>
              <option value="custom">Valores personalizados</option>
            </select>
          </label>

          {splitMode === "equal" ? (
            <p className="note">
              O total será dividido igualmente, com ajuste automático dos centavos.
            </p>
          ) : (
            <>
              <div className="form-grid cols-3" style={{ marginTop: 12 }}>
                {selectedMembers.map((member) => (
                  <label className="field" key={member.id}>
                    {member.name}
                    <input
                      name={`share_${member.id}`}
                      inputMode="decimal"
                      value={customShares[member.id] ?? ""}
                      onChange={(event) =>
                        setCustomShares((current) => ({
                          ...current,
                          [member.id]: event.target.value,
                        }))
                      }
                      placeholder="0,00"
                      required
                    />
                  </label>
                ))}
              </div>
              <div
                className={`message ${customTotalCents === purchaseTotalCents ? "success" : "info"}`}
                style={{ marginTop: 12 }}
              >
                Distribuído: {(customTotalCents / 100).toLocaleString("pt-BR", {
                  style: "currency",
                  currency: "BRL",
                })} de {purchaseTotal.toLocaleString("pt-BR", {
                  style: "currency",
                  currency: "BRL",
                })}
              </div>
            </>
          )}
        </div>

        <FormActionMessage state={state} />
        <div className="form-actions">
          <SubmitButton pendingLabel="Salvando compra...">Registrar compra</SubmitButton>
          <button className="button ghost" type="button" onClick={onCancel}>Cancelar seleção</button>
        </div>
      </form>
    </div>
  );
}

export function ShoppingPurchaseMutationForm({
  mode,
  purchaseId,
  itemId,
  redirectTo,
}: {
  mode: "remove-item" | "reset-purchase";
  purchaseId: string;
  itemId?: string;
  redirectTo: string;
}) {
  const router = useRouter();
  const action = mode === "remove-item"
    ? removeShoppingItemWithTimeout
    : resetShoppingPurchaseWithTimeout;
  const [state, formAction] = useActionState(action, initialFormActionState);

  useEffect(() => {
    if (state.status !== "idle") router.refresh();
  }, [router, state]);

  return (
    <form action={formAction} className="purchase-mutation-form">
      <input type="hidden" name="purchase_id" value={purchaseId} />
      {itemId && <input type="hidden" name="item_id" value={itemId} />}
      <input type="hidden" name="redirect_to" value={redirectTo} />
      <SubmitButton
        className={`button ${mode === "remove-item" ? "danger" : "ghost"} small`}
        pendingLabel={mode === "remove-item" ? "Retirando..." : "Devolvendo..."}
      >
        {mode === "remove-item" ? "Retirar da compra" : "Voltar itens à lista"}
      </SubmitButton>
      <FormActionMessage state={state} inline />
    </form>
  );
}
