"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import {
  deleteShoppingItem,
  recordShoppingPurchase,
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
};

type PurchaseScope = "household" | "group" | "individual";

function numberFromInput(value: string) {
  let normalized = value.trim().replace(/\s/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [scope, setScope] = useState<PurchaseScope>("household");
  const [participants, setParticipants] = useState<string[]>(members.map((member) => member.id));
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((item) => [item.id, String(item.quantity_planned ?? 1)])),
  );
  const [unitPrices, setUnitPrices] = useState<Record<string, string>>({});

  const visibleItems = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("pt-BR");
    if (!term) return items;
    return items.filter((item) =>
      [item.name, item.category, item.note]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("pt-BR").includes(term)),
    );
  }, [items, search]);

  const selectedItems = items.filter((item) => selectedIds.includes(item.id));
  const purchaseTotal = selectedItems.reduce(
    (sum, item) => sum + numberFromInput(quantities[item.id] ?? "0") * numberFromInput(unitPrices[item.id] ?? "0"),
    0,
  );

  function toggleSelected(itemId: string) {
    setSelectedIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    );
  }

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
    <>
      <div className="shopping-toolbar">
        <label className="field shopping-search">
          Buscar na lista
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Digite o nome, categoria ou observação"
          />
        </label>
        <div className="shopping-selection-count">
          <strong>{selectedIds.length}</strong>
          <span>item(ns) selecionado(s)</span>
        </div>
      </div>

      <div className="shopping-select-list">
        {visibleItems.length === 0 && <div className="empty">Nenhum item encontrado.</div>}
        {visibleItems.map((item) => (
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
                </small>
              </span>
            </label>

            <span className={`status-pill ${item.status === "checked" ? "success" : "info"}`}>
              {item.status === "checked" ? "No carrinho" : "Falta comprar"}
            </span>

            {canManage && (
              <form action={toggleShoppingChecked}>
                <input type="hidden" name="item_id" value={item.id} />
                <input type="hidden" name="next_status" value={item.status === "checked" ? "list" : "checked"} />
                <input type="hidden" name="redirect_to" value={redirectTo} />
                <button className="button ghost small" type="submit">
                  {item.status === "checked" ? "Desmarcar carrinho" : "Marcar no carrinho"}
                </button>
              </form>
            )}

            {canManage && (
              <details className="shopping-inline-editor">
                <summary>Editar</summary>
                <form action={updateShoppingItem} className="stack-form">
                  <input type="hidden" name="item_id" value={item.id} />
                  <input type="hidden" name="redirect_to" value={redirectTo} />
                  <label>
                    Nome
                    <input name="name" defaultValue={item.name} required />
                  </label>
                  <label>
                    Quantidade planejada
                    <input name="quantity_planned" inputMode="decimal" defaultValue={item.quantity_planned ?? ""} />
                  </label>
                  <SubmitButton className="button secondary small" pendingLabel="Salvando...">Salvar</SubmitButton>
                </form>
              </details>
            )}

            {canManage && (
              <form action={deleteShoppingItem}>
                <input type="hidden" name="item_id" value={item.id} />
                <input type="hidden" name="redirect_to" value={redirectTo} />
                <button className="button danger small" type="submit">Excluir</button>
              </form>
            )}
          </article>
        ))}
      </div>

      {canManage && selectedItems.length > 0 && (
        <div className="purchase-form-wrap" id="compra">
          <form action={recordShoppingPurchase} className="stack-form purchase-form">
            <input type="hidden" name="redirect_to" value={redirectTo} />
            {selectedItems.map((item) => (
              <input key={item.id} type="hidden" name="selected_item_ids" value={item.id} />
            ))}

            <div>
              <span className="eyebrow">Fechar compra</span>
              <h3 style={{ margin: "5px 0 0" }}>Valores dos itens selecionados</h3>
            </div>

            <div className="purchase-item-values">
              {selectedItems.map((item) => {
                const subtotal = numberFromInput(quantities[item.id] ?? "0") * numberFromInput(unitPrices[item.id] ?? "0");
                return (
                  <div className="purchase-item-value-row" key={item.id}>
                    <strong>{item.name}</strong>
                    <label className="field">
                      Quantidade comprada
                      <input
                        name={`quantity_${item.id}`}
                        inputMode="decimal"
                        value={quantities[item.id] ?? ""}
                        onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                        required
                      />
                    </label>
                    <label className="field">
                      Valor unitário
                      <input
                        name={`unit_price_${item.id}`}
                        inputMode="decimal"
                        value={unitPrices[item.id] ?? ""}
                        onChange={(event) => setUnitPrices((current) => ({ ...current, [item.id]: event.target.value }))}
                        placeholder="0,00"
                        required
                      />
                    </label>
                    <div className="item-value">
                      <strong>{subtotal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong>
                      <small>subtotal</small>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="purchase-total-preview">
              <span>Total desta compra</span>
              <strong>{purchaseTotal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong>
            </div>

            <label className="field">
              Quem pagou a compra inteira?
              <select name="paid_by_member_id" required defaultValue="">
                <option value="" disabled>Selecione o pagador</option>
                {members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
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
              <p className="note">
                Primeiro somamos todos os itens. Depois o total é dividido igualmente entre os participantes.
              </p>
            </div>

            <div className="form-actions">
              <SubmitButton pendingLabel="Calculando rateio...">Salvar compra e dividir</SubmitButton>
              <button className="button ghost" type="button" onClick={() => setSelectedIds([])}>Cancelar seleção</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
