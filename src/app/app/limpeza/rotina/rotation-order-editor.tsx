"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { saveDailyRotation } from "../actions";

type Member = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
};

export function RotationOrderEditor({
  initialMembers,
  startDate,
}: {
  initialMembers: Member[];
  startDate: string;
}) {
  const [members, setMembers] = useState(initialMembers);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= members.length) return;
    setMembers((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <form action={saveDailyRotation} className="stack-form rotation-config-form">
      <input type="hidden" name="redirect_to" value="/app/limpeza/rotina" />
      {members.map((member) => (
        <input type="hidden" name="member_ids" value={member.id} key={member.id} />
      ))}

      <label>
        Início da escala
        <input name="start_date" type="date" required defaultValue={startDate} />
      </label>

      <div className="rotation-order-list">
        {members.map((member, index) => (
          <div className="rotation-order-row" key={member.id}>
            <span className="rotation-position">{index + 1}</span>
            <div className={`avatar avatar-${member.color_key}`}>{member.initials}</div>
            <strong>{member.name}</strong>
            <div className="rotation-order-actions">
              <button
                className="icon-button"
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`Mover ${member.name} para cima`}
              >
                ↑
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === members.length - 1}
                aria-label={`Mover ${member.name} para baixo`}
              >
                ↓
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="note">
        Depois do último morador, a escala recomeça pelo primeiro. Alterar a
        ordem cancela solicitações de troca que ainda estiverem pendentes.
      </p>
      <SubmitButton pendingLabel="Salvando escala...">Salvar ordem</SubmitButton>
    </form>
  );
}
