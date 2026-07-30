"use client";

import { useMemo, useState } from "react";
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

const categories = ["Moradia", "Energia", "Gás", "Internet", "Supermercado", "Limpeza", "Manutenção", "Lazer", "Outros"];

export function ExpenseForm({ members, defaultMonth, expense }: { members: Member[]; defaultMonth: string; expense?: Expense }) {
  const [mode, setMode] = useState(expense?.split_mode ?? "equal");
  const [amount, setAmount] = useState(expense?.amount?.toFixed(2) ?? "");
  const selectedInitially = useMemo(() => new Set(expense?.expense_shares?.map((share) => share.member_id) ?? members.map((member) => member.id)), [expense, members]);
  const [selected, setSelected] = useState(selectedInitially);
  const [custom, setCustom] = useState<Record<string, string>>(() => Object.fromEntries((expense?.expense_shares ?? []).map((share) => [share.member_id, Number(share.amount).toFixed(2)])));
  const action = expense ? updateExpense : createExpense;
  const parsedAmount = Number(amount.replace(",", ".")) || 0;
  const equalValue = selected.size ? parsedAmount / selected.size : 0;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <form action={action}>
      {expense && <input type="hidden" name="expense_id" value={expense.id} />}
      <div className="form-grid cols-3">
        <label className="field span-2">Nome da despesa<input name="title" required defaultValue={expense?.title} placeholder="Ex.: Compra do supermercado" /></label>
        <label className="field">Categoria<select name="category" defaultValue={expense?.category ?? "Outros"}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label className="field">Mês de referência<input name="reference_month" type="month" required defaultValue={(expense?.reference_month ?? `${defaultMonth}-01`).slice(0, 7)} /></label>
        <label className="field">Vencimento<input name="due_date" type="date" defaultValue={expense?.due_date ?? ""} /></label>
        <label className="field">Valor total<input name="amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0,00" /></label>
        <label className="field">Divisão<select name="split_mode" value={mode} onChange={(event) => setMode(event.target.value as "equal" | "custom")}><option value="equal">Igual entre selecionados</option><option value="custom">Valores personalizados</option></select></label>
        <label className="field">Recorrência<select name="recurrence" defaultValue={expense?.recurrence ?? "once"}><option value="once">Somente este mês</option><option value="monthly">Repetir mensalmente</option></select></label>
        <label className="field span-3">Observações<textarea name="description" defaultValue={expense?.description ?? ""} placeholder="Detalhes úteis sobre esta despesa" /></label>
      </div>
      <div className="form-section">
        <h4>Quem participa desta divisão?</h4>
        <div className="member-check-grid">
          {members.map((member) => (
            <label className="member-check" key={member.id}>
              <input name="members" type="checkbox" value={member.id} checked={selected.has(member.id)} onChange={() => toggle(member.id)} />
              <span>{member.name}</span>
            </label>
          ))}
        </div>
      </div>
      {parsedAmount > 0 && (
        <div className="form-section">
          <h4>{mode === "equal" ? `Divisão automática: aproximadamente R$ ${equalValue.toFixed(2)} por pessoa` : "Informe o valor de cada pessoa"}</h4>
          {mode === "custom" && (
            <div className="form-grid cols-3">
              {members.filter((member) => selected.has(member.id)).map((member) => (
                <label className="field" key={member.id}>{member.name}<input name={`share_${member.id}`} inputMode="decimal" value={custom[member.id] ?? ""} onChange={(event) => setCustom({ ...custom, [member.id]: event.target.value })} placeholder="0,00" /></label>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="form-section">
        <label className="inline-check"><input name="estimated" type="checkbox" defaultChecked={expense?.estimated} /> O valor ainda é uma estimativa</label>
      </div>
      <div className="form-actions"><button className="button primary" type="submit">{expense ? "Salvar alterações" : "Adicionar despesa"}</button></div>
    </form>
  );
}
