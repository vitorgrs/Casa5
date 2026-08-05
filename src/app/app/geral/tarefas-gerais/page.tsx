"use client";

import { useState } from "react";
import { createGeneralTask } from "./actions";

export default function GeneralTasksPage() {
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    dueDate: '',
    assignedTo: [] as string[],
    priority: 'medium',
    expenseRefundId: '',
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const form = new FormData();
    form.append('title', formData.title);
    form.append('description', formData.description);
    form.append('due_date', formData.dueDate);
    form.append('priority', formData.priority);
    form.append('expense_refund_id', formData.expenseRefundId);
    formData.assignedTo.forEach((memberId) => {
      form.append('assigned_to', memberId);
    });

    createGeneralTask(form);
  }

  return (
    <div className="page-container">
      <div className="page-head">
        <div>
          <span className="eyebrow">Organização</span>
          <h1>Tarefas Gerais</h1>
          <p>Gerencie demandas que precisam ser resolvidas pelos moradores, mas que não são tarefas domésticas recorrentes.</p>
        </div>
        <button
          className="button primary"
          onClick={() => setIsCreating(!isCreating)}
        >
          Nova Tarefa
        </button>
      </div>

      {isCreating && (
        <form onSubmit={handleSubmit} className="card form-container">
          <h2>Criar Nova Tarefa</h2>
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
              onChange={(e) => setFormData({...formData, priority: e.target.value})}
            >
              <option value="low">Baixa</option>
              <option value="medium">Média</option>
              <option value="high">Alta</option>
            </select>
          </div>
          <div className="form-group">
            <label>Responsáveis</label>
            <input
              type="text"
              placeholder="Selecione os responsáveis (a ser implementado)"
            />
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
          <button type="submit" className="button primary">Criar Tarefa</button>
        </form>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Lista de Tarefas</h2>
          <div className="filters">
            <input type="text" placeholder="Filtrar por título..." />
            <select>
              <option>Todos os status</option>
              <option>Pendente</option>
              <option>Em andamento</option>
              <option>Concluída</option>
              <option>Cancelada</option>
            </select>
          </div>
        </div>
        <div className="tasks-list">
          {/* Lista de tarefas será renderizada aqui */}
          <div className="empty-state">Nenhuma tarefa cadastrada.</div>
        </div>
      </div>
    </div>
  );
}
