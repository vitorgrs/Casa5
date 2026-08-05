"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import { createExpense, updateExpense } from "./actions";

type Member = { id: string; name: string; initials: string; color_key: string };
type Share = { member_id: string; amount: number; payment_status?: string };
type Expense = {
  id: string;
  title: string;
  category: string;
  description: string | null;
  reference_month: string;
  due_date: string | null;
  amount: number | null;
  estimated: boolean;
  split_mode: "equal" | "custom";
  recurrence: "once" | "monthly";
  expense_shares: Share[];
};

const categories = [
  "Moradia",
  "Energia",
  "Gás",
  "Internet",
  "Supermercado",
  "Limpeza",
  "Manutenção",
  "Lazer",
  "Outros",
];

function parseMoney(value: string) {
  let text = value.trim().replace(/\s/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

export function ExpenseForm({
  members,
  defaultMonth,
  expense,
}: {
  members: Member[];
  defaultMonth: string;
  expense?: Expense;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const allowMismatchInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState(expense?.split_mode ?? "equal");
  const [amount, setAmount] = useState(expense?.amount?.toFixed(2) ?? "");
  const selectedInitially = useMemo(
    () =>
      new Set(
        expense?.expense_shares?.map((share) => share.member_id) ??
          members.map((member) => member.id),
      ),
    [expense, members],
  );
  const [selected, setSelected] = useState(selectedInitially);
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (expense?.expense_shares ?? []).map((share) => [
        share.member_id,
        Number(share.amount).toFixed(2),
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [showMismatchModal, setShowMismatchModal] = useState(false);
  const action = expense ? updateExpense : createExpense;
  const parsedAmount = Number(amount.replace(",", ".")) || 0;
  const equalValue = selected.size ? parsedAmount / selected.size : 0;
  const customMembers = members.filter((member) => selected.has(member.id));
  const customTotal = customMembers.reduce(
    (sum, member) => sum + (parseMoney(custom[member.id] ?? "") ?? 0),
    0,
  );
  const hardValidationError =
    mode === "custom" && parsedAmount <= 0
      ? "Informe o valor total antes de usar divisão personalizada."
      : mode === "custom" && selected.size === 0
        ? "Selecione ao menos um morador para a divisão personalizada."
        : null;
  const splitMismatchMessage =
    mode === "custom" && Math.abs(customTotal - parsedAmount) > 0.01
      ? `A divisão personalizada soma R$ ${customTotal.toFixed(2)}, mas o valor total é R$ ${parsedAmount.toFixed(2)}. Deseja salvar mesmo assim?`
      : null;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const allowCustomMismatch = allowMismatchInputRef.current?.value === "1";
    if (hardValidationError) {
      event.preventDefault();
      if (allowMismatchInputRef.current)
        allowMismatchInputRef.current.value = "0";
      setError(hardValidationError);
      return;
    }
    if (splitMismatchMessage && !allowCustomMismatch) {
      event.preventDefault();
      if (allowMismatchInputRef.current)
        allowMismatchInputRef.current.value = "0";
      setError(splitMismatchMessage);
      setShowMismatchModal(true);
      return;
    }
    setError(null);
  }

  function confirmMismatch() {
    setShowMismatchModal(false);
    if (allowMismatchInputRef.current)
      allowMismatchInputRef.current.value = "1";
    formRef.current?.requestSubmit();
  }

  return (
    <>
      <form ref={formRef} action={action} onSubmit={handleSubmit}>
        <input
          ref={allowMismatchInputRef}
          type="hidden"
          name="allow_custom_mismatch"
          defaultValue="0"
        />
        {expense && (
          <input type="hidden" name="expense_id" value={expense.id} />
        )}
        <div className="form-grid cols-3">
          <label className="field span-2">
            Nome da despesa
            <input
              name="title"
              required
              defaultValue={expense?.title}
              placeholder="Ex.: Compra do supermercado"
            />
          </label>
          <label className="field">
            Categoria
            <select
              name="category"
              defaultValue={expense?.category ?? "Outros"}
            >
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Mês de referência
            <input
              name="reference_month"
              type="month"
              required
              defaultValue={(
                expense?.reference_month ?? `${defaultMonth}-01`
              ).slice(0, 7)}
            />
          </label>
          <label className="field">
            Vencimento
            <input
              name="due_date"
              type="date"
              defaultValue={expense?.due_date ?? ""}
            />
          </label>
          <label className="field">
            Valor total
            <input
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0,00"
            />
          </label>
          <label className="field">
            Divisão
            <select
              name="split_mode"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as "equal" | "custom")
              }
            >
              <option value="equal">Igual entre selecionados</option>
              <option value="custom">Valores personalizados</option>
            </select>
          </label>
          <label className="field">
            Recorrência
            <select
              name="recurrence"
              defaultValue={expense?.recurrence ?? "once"}
            >
              <option value="once">Somente este mês</option>
              <option value="monthly">Repetir mensalmente</option>
            </select>
          </label>
          <label className="field span-3">
            Observações
            <textarea
              name="description"
              defaultValue={expense?.description ?? ""}
              placeholder="Detalhes úteis sobre esta despesa"
            />
          </label>
        </div>
        <div className="form-section">
          <h4>Quem participa desta divisão?</h4>
          <div className="member-check-grid">
            {members.map((member) => (
              <label className="member-check" key={member.id}>
                <input
                  name="members"
                  type="checkbox"
                  value={member.id}
                  checked={selected.has(member.id)}
                  onChange={() => toggle(member.id)}
                />
                <span>{member.name}</span>
              </label>
            ))}
          </div>
        </div>
        {parsedAmount > 0 && (
          <div className="form-section">
            <h4>
              {mode === "equal"
                ? `Divisão automática: aproximadamente R$ ${equalValue.toFixed(2)} por pessoa`
                : "Informe o valor de cada pessoa"}
            </h4>
            {mode === "custom" && (
              <div className="form-grid cols-3">
                {customMembers.map((member) => (
                  <label className="field" key={member.id}>
                    {member.name}
                    <input
                      name={`share_${member.id}`}
                      inputMode="decimal"
                      required
                      value={custom[member.id] ?? ""}
                      onChange={(event) =>
                        setCustom({
                          ...custom,
                          [member.id]: event.target.value,
                        })
                      }
                      placeholder="0,00"
                    />
                  </label>
                ))}
              </div>
            )}
            {mode === "custom" && error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        <div className="form-section">
          <label className="inline-check">
            <input
              name="estimated"
              type="checkbox"
              defaultChecked={expense?.estimated}
            />{" "}
            O valor ainda é uma estimativa
          </label>
        </div>
        <div className="form-actions">
          <button className="button primary" type="submit">
            {expense ? "Salvar alterações" : "Adicionar despesa"}
          </button>
        </div>
      </form>

      {showMismatchModal && splitMismatchMessage && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShowMismatchModal(false)}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="split-mismatch-title"
            aria-describedby="split-mismatch-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-icon">!</div>
            <div>
              <h3 id="split-mismatch-title">Divisão não bateu no centavo</h3>
              <p id="split-mismatch-description">{splitMismatchMessage}</p>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  if (allowMismatchInputRef.current) {
                    allowMismatchInputRef.current.value = "0";
                  }
                  setShowMismatchModal(false);
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="button primary"
                onClick={confirmMismatch}
              >
                Salvar assim mesmo
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
