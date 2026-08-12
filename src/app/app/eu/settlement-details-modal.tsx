"use client";

import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

type PurchaseItemDetail = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
};

type PurchaseDetail = {
  id: string;
  boughtAt: string | null;
  payerName: string;
  debtorName: string;
  purchaseTotal: number;
  originalShareAmount: number;
  settledShareAmount: number;
  openShareAmount: number;
  items: PurchaseItemDetail[];
  participants: Array<{
    id: string;
    name: string;
    amount: number;
    settledAmount: number;
    openAmount: number;
  }>;
};

export type SettlementDetails = {
  title: string;
  sections: Array<{
    title: string;
    total: number;
    purchases: PurchaseDetail[];
  }>;
  calculation: {
    firstLabel: string;
    firstAmount: number;
    secondLabel: string;
    secondAmount: number;
    netAmount: number;
    pendingPaymentAmount: number;
    remainingAmount: number;
    resultLabel: string;
  };
};

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const interactiveSelector = "a,button,input,select,textarea,label,form,summary";

function formatDate(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  return new Date(normalized).toLocaleDateString("pt-BR");
}

export function SettlementDetailsModal({
  details,
  children,
}: {
  details: SettlementDetails;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  function openFromClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest(interactiveSelector)) return;
    setOpen(true);
  }

  function openFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <>
      <div
        className="settlement-clickable"
        role="button"
        tabIndex={0}
        aria-label={`Ver detalhes. ${details.title}`}
        onClick={openFromClick}
        onKeyDown={openFromKeyboard}
      >
        {children}
        <span className="settlement-detail-hint">Clique no cartão para ver itens e cálculo</span>
      </div>

      {open && (
        <div className="modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="modal-card settlement-details-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settlement-modal-head">
              <div>
                <span className="eyebrow">Detalhes do acerto</span>
                <h3 id={titleId}>{details.title}</h3>
              </div>
              <button
                className="button ghost small"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar detalhes"
              >
                Fechar
              </button>
            </div>

            <div className="settlement-detail-sections">
              {details.sections.map((section) => (
                <section className="settlement-detail-section" key={section.title}>
                  <div className="settlement-section-head">
                    <h4>{section.title}</h4>
                    <strong>{money.format(section.total)}</strong>
                  </div>

                  {section.purchases.length === 0 ? (
                    <div className="empty">Nenhuma compra deste lado do acerto.</div>
                  ) : (
                    <div className="settlement-purchase-list">
                      {section.purchases.map((purchase) => (
                        <article className="settlement-purchase-detail" key={purchase.id}>
                          <div className="settlement-purchase-head">
                            <div>
                              <strong>Compra paga por {purchase.payerName}</strong>
                              <small>
                                {purchase.boughtAt
                                  ? formatDate(purchase.boughtAt)
                                  : "Data não informada"}
                              </small>
                            </div>
                            <div className="item-value">
                              <strong>{money.format(purchase.purchaseTotal)}</strong>
                              <small>total da compra</small>
                            </div>
                          </div>

                          <div className="settlement-item-list">
                            {purchase.items.length === 0 && (
                              <div className="muted-text">Itens não encontrados.</div>
                            )}
                            {purchase.items.map((item) => (
                              <div className="settlement-item-row" key={item.id}>
                                <span>{item.name}</span>
                                <small>
                                  {item.quantity.toLocaleString("pt-BR")} × {money.format(item.unitPrice)}
                                </small>
                                <strong>{money.format(item.subtotal)}</strong>
                              </div>
                            ))}
                          </div>

                          <div className="settlement-share-breakdown">
                            <span>
                              Parte de {purchase.debtorName}
                              <strong>{money.format(purchase.originalShareAmount)}</strong>
                            </span>
                            <span>
                              Já abatido
                              <strong>{money.format(purchase.settledShareAmount)}</strong>
                            </span>
                            <span>
                              Desta compra ainda aberto
                              <strong>{money.format(purchase.openShareAmount)}</strong>
                            </span>
                          </div>

                          <div className="settlement-participants">
                            <strong>Divisão completa desta compra</strong>
                            <div className="settlement-participant-list">
                              {purchase.participants.length === 0 && (
                                <span className="muted-text">Divisão não encontrada.</span>
                              )}
                              {purchase.participants.map((participant) => (
                                <div className="settlement-participant-row" key={participant.id}>
                                  <span>{participant.name}</span>
                                  <small>
                                    Parte: <strong>{money.format(participant.amount)}</strong>
                                  </small>
                                  <small>
                                    Abatido: <strong>{money.format(participant.settledAmount)}</strong>
                                  </small>
                                  <small>
                                    Em aberto: <strong>{money.format(participant.openAmount)}</strong>
                                  </small>
                                </div>
                              ))}
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>

            <section className="settlement-calculation">
              <h4>Cálculo final</h4>
              <div><span>{details.calculation.firstLabel}</span><strong>{money.format(details.calculation.firstAmount)}</strong></div>
              <div><span>{details.calculation.secondLabel}</span><strong>− {money.format(details.calculation.secondAmount)}</strong></div>
              <div className="settlement-net-line"><span>Diferença após compensação</span><strong>{money.format(details.calculation.netAmount)}</strong></div>
              {details.calculation.pendingPaymentAmount > 0 && (
                <div><span>Pagamento aguardando confirmação</span><strong>− {money.format(details.calculation.pendingPaymentAmount)}</strong></div>
              )}
              <div className="settlement-final-line">
                <span>{details.calculation.resultLabel}</span>
                <strong>{money.format(details.calculation.remainingAmount)}</strong>
              </div>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
