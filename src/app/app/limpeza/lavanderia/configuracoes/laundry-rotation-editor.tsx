"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { SubmitButton } from "@/components/submit-button";
import { addDays, formatHouseDate, isIsoDate, todayIso } from "@/lib/chore-rotation";
import { initialFormActionState } from "@/lib/form-action-state";
import {
  laundryMemberNames,
  laundryRotationGroups,
  type LaundryRotationVersion,
} from "@/lib/laundry-rotation";
import { saveLaundryRotation } from "../actions";

type Member = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
};

type AnchorOption = {
  id: string;
  label: string;
};

export function LaundryRotationEditor({
  initialMembers,
  anchorDate,
  anchorMemberId,
  gapDays,
  peoplePerDay,
  allowIncompleteLastGroup,
}: {
  initialMembers: Member[];
  anchorDate: string;
  anchorMemberId: string;
  gapDays: number;
  peoplePerDay: number;
  allowIncompleteLastGroup: boolean;
}) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [firstWashDate, setFirstWashDate] = useState(anchorDate);
  const [interval, setInterval] = useState(gapDays);
  const [groupSize, setGroupSize] = useState(
    Math.max(1, Math.min(peoplePerDay, initialMembers.length || 1)),
  );
  const [allowIncomplete, setAllowIncomplete] = useState(
    allowIncompleteLastGroup,
  );
  const [anchorId, setAnchorId] = useState(anchorMemberId);
  const [state, formAction] = useActionState(
    saveLaundryRotation,
    initialFormActionState,
  );

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state]);

  const safeGroupSize = Math.max(1, Math.min(groupSize, members.length || 1));
  const anchorOptions = useMemo<AnchorOption[]>(() => {
    if (members.length === 0) return [];
    if (allowIncomplete) {
      const options: AnchorOption[] = [];
      for (let index = 0; index < members.length; index += safeGroupSize) {
        const group = members.slice(index, index + safeGroupSize);
        options.push({
          id: group[0].id,
          label: group.map((member) => member.name.split(" ")[0]).join(" + "),
        });
      }
      return options;
    }

    return members.map((member, startIndex) => ({
      id: member.id,
      label: Array.from(
        { length: safeGroupSize },
        (_, offset) => members[(startIndex + offset) % members.length].name.split(" ")[0],
      ).join(" + "),
    }));
  }, [allowIncomplete, members, safeGroupSize]);

  const selectedAnchorId = anchorOptions.some((option) => option.id === anchorId)
    ? anchorId
    : anchorOptions[0]?.id ?? "";
  const previewVersion = useMemo<LaundryRotationVersion | null>(() => {
    if (!selectedAnchorId || members.length === 0) return null;
    return {
      id: "preview",
      effective_from: todayIso(),
      anchor_date: firstWashDate,
      anchor_member_id: selectedAnchorId,
      gap_days: interval,
      people_per_day: safeGroupSize,
      allow_incomplete_last_group: allowIncomplete,
      members: members.map((member, index) => ({
        ...member,
        rotation_order: index + 1,
      })),
    };
  }, [allowIncomplete, firstWashDate, interval, members, safeGroupSize, selectedAnchorId]);
  const previewGroups = previewVersion
    ? laundryRotationGroups(previewVersion)
    : [];

  function move(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= members.length) return;
    setMembers((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  return (
    <form action={formAction} className="stack-form laundry-config-form">
      {members.map((member) => (
        <input type="hidden" name="member_ids" value={member.id} key={member.id} />
      ))}

      <div className="form-grid cols-3">
        <label className="field">
          Primeira lavagem da nova regra
          <input
            name="anchor_date"
            type="date"
            required
            min={todayIso()}
            value={firstWashDate}
            onChange={(event) => setFirstWashDate(event.target.value)}
          />
        </label>
        <label className="field">
          Pessoas por dia
          <input
            name="people_per_day"
            type="number"
            required
            min={1}
            max={Math.max(members.length, 1)}
            value={groupSize}
            onChange={(event) => setGroupSize(Number(event.target.value))}
          />
        </label>
        <label className="field">
          Dias livres entre lavagens
          <input
            name="gap_days"
            type="number"
            required
            min={0}
            max={30}
            value={interval}
            onChange={(event) => setInterval(Number(event.target.value))}
          />
        </label>
        <label className="field span-3">
          Grupo da primeira lavagem
          <select
            name="anchor_member_id"
            required
            value={selectedAnchorId}
            onChange={(event) => setAnchorId(event.target.value)}
          >
            {anchorOptions.map((option) => (
              <option value={option.id} key={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="inline-check laundry-incomplete-check">
        <input
          name="allow_incomplete_last_group"
          type="checkbox"
          value="true"
          checked={allowIncomplete}
          onChange={(event) => setAllowIncomplete(event.target.checked)}
        />
        <span>
          Permitir que o último grupo da rodada tenha menos pessoas
          <small>
            Ligado: com cinco moradores e grupos de dois, o último fica sozinho.
            Desligado: o rodízio continua circularmente e mantém sempre a
            quantidade configurada.
          </small>
        </span>
      </label>

      <div className="laundry-group-preview" aria-live="polite">
        <span className="eyebrow">Prévia da rodada</span>
        <div className="laundry-group-preview-list">
          {previewGroups.map((group, index) => (
            <div className="laundry-group-preview-item" key={`${index}-${group[0]?.id}`}>
              <small>
                {isIsoDate(firstWashDate)
                  ? formatHouseDate(addDays(firstWashDate, index * (interval + 1)))
                  : "Escolha a data"}
              </small>
              <strong>{laundryMemberNames(group)}</strong>
            </div>
          ))}
        </div>
        {!allowIncomplete && members.length % safeGroupSize !== 0 && (
          <p className="note">
            O fluxo circular repete moradores entre rodadas para manter exatamente
            {` ${safeGroupSize} ${safeGroupSize === 1 ? "pessoa" : "pessoas"}`} em cada data.
          </p>
        )}
      </div>

      <div className="laundry-order-list">
        {members.map((member, index) => (
          <div className="laundry-order-row" key={member.id}>
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
        “Dias livres” não conta o dia da lavagem. Com 2 dias livres, uma lavagem
        no dia 5 libera a próxima para o dia 8. Ao salvar, a nova regra começa
        hoje e a data escolhida será a primeira lavagem; dias anteriores
        permanecem exatamente como estavam.
      </p>
      <FormActionMessage state={state} />
      <SubmitButton pendingLabel="Salvando escala...">Salvar nova escala</SubmitButton>
    </form>
  );
}
