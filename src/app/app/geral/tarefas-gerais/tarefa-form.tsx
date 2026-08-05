"use client";

import { useState, useEffect } from "react";
import { createGeneralTask, updateGeneralTask } from "./actions";

type Member = { id: string; name: string; initials: string; color_key: string };

type GeneralTask = {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  assigned_to: string[];
  priority: "low" | "medium" | "high";
  status: "pending" | "in_progress" | "completed" | "cancelled";
  created_by: string;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
  expense_refund_id: string | null;
  members_data: any;
  expense?: {
    title: string;
    total_amount: number;
  };
  refund?: {
    total_amount: number | null;
    status: string;
  };
};

export function GeneralTaskForm({
  members,
  task,
  redirectTo,
  onSuccess,
}: {
  members: Member[];
  task?: GeneralTask;
  redirectTo?: string;
  onSuccess?: () => void;
}) {
  const [formData, setFormData] = useState({
    title: task?.title || '',
    description: task?.description || '',
    dueDate: task?.due_date || '',
    assignedTo: task?.assigned_to || [],
    priority: task?.priority || 'medium',
    status: task?.status || 'pending',
    expenseRefundId: task?.expense_refund_id || '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);

    const form = new FormData();
    form.append('title', formData.title);
    form.append('description', formData.description);
    form.append('due_date', formData.dueDate);
    form.append('priority', formData.priority);
    form.append('status', formData.status);
    if (formData.expenseRefundId) {
      form.append('expense_refund_id', formData.expenseRefundId);
    }
    formData.assignedTo.forEach((memberId) => {
      form.append('assigned_to', memberId);
    });

    const action = task ? updateGeneralTask : createGeneralTask;

    action(form)
      .then(() => {
        if (onSuccess) onSuccess();
        if (!task && redirectTo) {
          window.location.href = redirectTo;
        }
      })
      .catch((error) => {
        console.error('Erro ao salvar tarefa:', error);
        alert(error.message || 'Erro ao salvar tarefa.');
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  function toggleMember(memberId: string) {
    setFormData((prev) => {
      const assignedTo = [...prev.assignedTo];
      const index = assignedTo.indexOf(memberId);
      if (index > -1) {
        assignedTo.splice(index, 1);
      } else {
        assignedTo.push(memberId);
      }
      return { ...prev, assignedTo };
    });
  }

  return (
    <form onSubmit={handleSubmit} className="form-container">
      <div className="form-group">
        <label>Título</label>
        <input
          type="text"
          value={formData.title}
          onChange={(e) => setFormData({...formData, title: e.target.value})}
          required
        />
      </div>

      <div className="form-group">
        <label>Descrição</label>
        <textarea
          value={formData.description}
          onChange={(e) => setFormData({...formData, description: e.target.value})}
        />
      </div>

      <div className="form-group">
        <label>Prazo</label>
        <input
          type="date"
          value={formData.dueDate}
          onChange={(e) => setFormData({...formData, dueDate: e.target.value})}
        />
      </div>

      <div className="form-group">
        <label>Prioridade</label>
        <select
          value={formData.priority}
          onChange={(e) => setFormData({...formData, priority: e.target.value as 'low' | 'medium' | 'high'})}
        >
          <option value="low">Baixa</option>
          <option value="medium">Média</option>
          <option value="high">Alta</option>
        </select>
      </div>

      <div className="form-group">
        <label>Status</label>
        <select
          value={formData.status}
          onChange={(e) => setFormData({...formData, status: e.target.value as 'pending' | 'in_progress' | 'completed' | 'cancelled'})}
        >
          <option value="pending">Pendente</option>
          <option value="in_progress">Em andamento</option>
          <option value="completed">Concluída</option>
          <option value="cancelled">Cancelada</option>
        </select>
      </div>

      <div className="form-group">
        <label>Responsáveis</label>
        <div className="member-check-grid">
          {members.map((member) => (
            <label key={member.id} className="member-check">
              <input
                type="checkbox"
                checked={formData.assignedTo.includes(member.id)}
                onChange={() => toggleMember(member.id)}
              />
              <span>{member.name}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label>Vinculado a Reembolso</label>
        <select
          value={formData.expenseRefundId}
          onChange={(e) => setFormData({...formData, expenseRefundId: e.target.value})}
        >
          <option value="">Nenhum</option>
          {/* Lista de reembolsos será carregada dinamicamente */}
        </select>
      </div>

      <div className="form-actions">
        <button
          type="submit"
          className="button primary"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Salvando...' : task ? 'Salvar Alterações' : 'Criar Tarefa'}
        </button>
      </div>
    </form>
  );
}
