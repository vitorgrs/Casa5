// Sugestões para conciliar um Pix recebido com parcelas em aberto. Função
// pura: a decisão final é sempre de quem concilia na tela "Conta da casa".
// Sem imports com alias para poder ser testada direto pelo Node.

export type ReconciliationMember = {
  id: string;
  name: string;
  email: string | null;
  payer_identifiers: string[] | null;
};

export type ReconciliationShare = {
  id: string;
  member_id: string;
  amount: number;
};

export type ReconciliationMovement = {
  available: number;
  payer_name: string | null;
  payer_email: string | null;
  payer_document: string | null;
};

export type ReconciliationSuggestion = {
  memberId: string | null;
  reason: "identifier" | "name" | "amount" | null;
  suggestedShareIds: string[];
  candidateShareIds: string[];
};

const toCents = (value: number) => Math.round(value * 100);

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digits(value: string) {
  return value.replace(/\D/g, "");
}

function matchesIdentifier(member: ReconciliationMember, movement: ReconciliationMovement) {
  const identifiers = [member.email ?? "", ...(member.payer_identifiers ?? [])]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const email = movement.payer_email?.trim().toLowerCase();
  if (email && identifiers.includes(email)) return true;
  const document = movement.payer_document ? digits(movement.payer_document) : "";
  // CPF completo; a API às vezes devolve só parte dele, que não basta.
  return document.length >= 11 && identifiers.some((value) => digits(value) === document);
}

function matchesName(member: ReconciliationMember, movement: ReconciliationMovement) {
  if (!movement.payer_name) return false;
  const payer = ` ${normalizeText(movement.payer_name)} `;
  const tokens = normalizeText(member.name).split(" ").filter((token) => token.length > 1);
  // Todas as partes do nome cadastrado precisam aparecer: "Gabriel" sozinho
  // seria ambíguo entre dois moradores.
  return tokens.length >= 2 && tokens.every((token) => payer.includes(` ${token} `));
}

export function suggestReconciliation(
  movement: ReconciliationMovement,
  members: ReconciliationMember[],
  openShares: ReconciliationShare[],
): ReconciliationSuggestion {
  const available = toCents(movement.available);
  const byIdentifier = members.filter((member) => matchesIdentifier(member, movement));
  const byName = byIdentifier.length ? [] : members.filter((member) => matchesName(member, movement));
  const identified = byIdentifier.length === 1 ? byIdentifier[0] : byName.length === 1 ? byName[0] : null;
  const fitting = openShares.filter((share) => toCents(share.amount) <= available);

  if (identified) {
    const memberShares = fitting.filter((share) => share.member_id === identified.id);
    const others = fitting.filter((share) => share.member_id !== identified.id);
    const exact = memberShares.filter((share) => toCents(share.amount) === available);
    const memberTotal = memberShares.reduce((total, share) => total + toCents(share.amount), 0);
    const suggested =
      exact.length === 1
        ? [exact[0].id]
        : memberShares.length > 0 && memberTotal === available
          ? memberShares.map((share) => share.id)
          : [];
    return {
      memberId: identified.id,
      reason: byIdentifier.length === 1 ? "identifier" : "name",
      suggestedShareIds: suggested,
      candidateShareIds: [...memberShares, ...others].map((share) => share.id),
    };
  }

  const exact = fitting.filter((share) => toCents(share.amount) === available);
  return {
    memberId: exact.length === 1 ? exact[0].member_id : null,
    reason: exact.length === 1 ? "amount" : null,
    suggestedShareIds: exact.length === 1 ? [exact[0].id] : [],
    candidateShareIds: [...exact, ...fitting.filter((share) => !exact.includes(share))].map(
      (share) => share.id,
    ),
  };
}
