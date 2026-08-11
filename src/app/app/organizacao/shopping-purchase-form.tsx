"use client";

import Link from "next/link";
import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { recordShoppingPurchase } from "./actions";

type Member = {
  id: string;
  name: string;
};

type PurchaseScope = "household" | "group" | "individual";

export function ShoppingPurchaseForm({
  itemId,
  itemName,
  members,
  currentMemberId,
  redirectTo,
}: {
  itemId: string;
  itemName: string;
  members: Member[];
  currentMemberId: string | null;
  redirectTo: string;
}) {
  const [scope, setScope] = useState<PurchaseScope>("household");
  const [participants, setParticipants] = useState<string[]>(members.map((member) => member.id));

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
    <form action={recordShoppingPurchase} className="stack-form purchase-form">
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="redirect_to" value={redirectTo} />

      <div>
        <span className="eyebrow">Lançar compra</span>
        <h3 style={{ margin: "5px 0 0" }}>{itemName}</h3>
      </div>

      <div className="form-grid cols-3">
        <label className="field">
          Quantidade comprada
          <input name="quantity_bought" inputMode="decimal" required placeholder="Ex.: 2" />
        </label>
        <label className="field">
          Valor unitário
          <input name="unit_price" inputMode="decimal" required placeholder="0,00" />
        </label>
        <label className="field">
          Quem pagou?
          <select name="paid_by_member_id" required defaultValue={currentMemberId ?? ""}>
            <option value="" disabled>Selecione o pagador</option>
            {members.map((member) => (
              <option value={member.id} key={member.id}>{member.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-section">
        <h4>Para quem foi esta compra?</h4>
        <div className="purchase-scope-grid">
          <label className={`purchase-scope ${scope === "household" ? "selected" : ""}`}>
            <input
              type="radio"
              name="purchase_scope"
              value="household"
              checked={scope === "household"}
              onChange={() => changeScope("household")}
            />
            <span><strong>Casa toda</strong><small>Divide entre todos os moradores ativos.</small></span>
          </label>
          <label className={`purchase-scope ${scope === "group" ? "selected" : ""}`}>
            <input
              type="radio"
              name="purchase_scope"
              value="group"
              checked={scope === "group"}
              onChange={() => changeScope("group")}
            />
            <span><strong>Grupo</strong><small>Escolha duas ou mais pessoas.</small></span>
          </label>
          <label className={`purchase-scope ${scope === "individual" ? "selected" : ""}`}>
            <input
              type="radio"
              name="purchase_scope"
              value="individual"
              checked={scope === "individual"}
              onChange={() => changeScope("individual")}
            />
            <span><strong>Individual</strong><small>O valor fica para uma única pessoa.</small></span>
          </label>
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
          O total será dividido igualmente entre os participantes. Se o pagador estiver
          entre eles, a parte dele já ficará quitada; os demais receberão uma dívida com
          a chave PIX do pagador.
        </p>
      </div>

      <div className="form-actions">
        <SubmitButton pendingLabel="Calculando rateio...">Salvar compra e dividir</SubmitButton>
        <Link className="button ghost" href={redirectTo}>Cancelar</Link>
      </div>
    </form>
  );
}
