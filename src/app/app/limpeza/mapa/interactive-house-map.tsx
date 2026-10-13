"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FormActionMessage } from "@/components/form-action-message";
import { SubmitButton } from "@/components/submit-button";
import { todayIso } from "@/lib/chore-rotation";
import {
  initialFormActionState,
  type FormActionState,
} from "@/lib/form-action-state";
import { confirmStoveCleaning } from "../stove-cleaning-actions";
import {
  changeHouseCleaningTurn,
  initializeHouseCleaningMap,
  registerHouseCleaning,
  saveHouseCleaningRotation,
} from "./actions";
import styles from "./interactive-house-map.module.css";

export type HouseAreaSlug =
  | "sala"
  | "quarto_1"
  | "quarto_2"
  | "suite"
  | "banheiro_social"
  | "banheiro_suite"
  | "corredor"
  | "cozinha"
  | "area_servico"
  | "quarto_fundos"
  | "banheiro_servico";

export type HouseMapMember = {
  id: string;
  name: string;
  initials: string;
  color_key: string;
};

export type HouseMapHistoryEntry = {
  id: string;
  memberIdsSnapshot: string[];
  memberNamesSnapshot: string[];
  cleanedOn: string;
  cleanedAt: string;
  nextMemberIdsSnapshot: string[];
  nextMemberNamesSnapshot: string[];
  note: string | null;
};

export type HouseMapArea = {
  id: string;
  slug: HouseAreaSlug;
  name: string;
  order: number;
  peoplePerTurn: 1 | 2;
  allowIncomplete: boolean;
  cleaningMode: "fixed" | "flexible" | "balanced" | "round_robin";
  minCleaners: 1 | 2;
  maxCleaners: 1 | 2;
  currentStartMemberId: string | null;
  currentSince: string | null;
  turnNumber: number | string | null;
  rotationMembers: HouseMapMember[];
  suggestedMembers: HouseMapMember[];
  currentMembers: HouseMapMember[];
  nextMembers: HouseMapMember[];
  history: HouseMapHistoryEntry[];
  configurationReady: boolean;
};

export type HouseMapStoveHistoryEntry = {
  id: string;
  memberId?: string | null;
  memberNameSnapshot: string;
  cleanedAt: string;
  nextMemberId?: string | null;
  nextMemberNameSnapshot?: string | null;
  note: string | null;
};

export type HouseMapStove = {
  members: HouseMapMember[];
  currentMemberId: string | null;
  currentSince: string | null;
  currentTurnNumber: number | string | null;
  history: HouseMapStoveHistoryEntry[];
  configurationReady: boolean;
};

export type InteractiveHouseMapProps = {
  members: HouseMapMember[];
  areas: HouseMapArea[];
  stove: HouseMapStove;
  canManage: boolean;
  currentMemberId: string | null;
  houseMutationsReady: boolean;
  stoveMutationsReady: boolean;
  loadError: string | null;
};

type SelectedTarget = HouseAreaSlug | "fogao";

type MapTarget = {
  slug: SelectedTarget;
  label: string;
  shortLabel: string;
  polygon?: string;
};

const MAP_TARGETS: MapTarget[] = [
  {
    slug: "sala",
    label: "Sala",
    shortLabel: "Sala",
    polygon:
      "205,93 381,93 381,299 649,299 649,421 502,421 502,590 482,590 482,699 205,699",
  },
  {
    slug: "quarto_1",
    label: "Quarto 1",
    shortLabel: "Q1",
    polygon: "395,92 635,92 635,281 395,281",
  },
  {
    slug: "quarto_2",
    label: "Quarto 2",
    shortLabel: "Q2",
    polygon: "660,92 927,92 927,365 660,365",
  },
  {
    slug: "suite",
    label: "Quarto da suíte",
    shortLabel: "Suíte",
    polygon: "663,380 930,380 930,680 663,680",
  },
  {
    slug: "banheiro_social",
    label: "Banheiro social",
    shortLabel: "B. social",
    polygon: "506,432 646,432 646,578 506,578",
  },
  {
    slug: "banheiro_suite",
    label: "Banheiro da suíte",
    shortLabel: "B. suíte",
    polygon: "508,595 647,595 647,696 518,811 508,811",
  },
  {
    slug: "corredor",
    label: "Corredor",
    shortLabel: "Corredor",
    polygon: "410,704 498,704 498,981 410,981",
  },
  {
    slug: "cozinha",
    label: "Cozinha",
    shortLabel: "Cozinha",
    polygon:
      "220,1005 532,1005 532,1286 151,1286 151,1222 218,1222 218,1005",
  },
  {
    slug: "area_servico",
    label: "Área de serviço",
    shortLabel: "Serviço",
    polygon: "548,1006 713,1006 713,1112 548,1112",
  },
  {
    slug: "quarto_fundos",
    label: "Quarto de serviço",
    shortLabel: "Q. serviço",
    polygon: "733,1006 951,1006 951,1285 733,1285",
  },
  {
    slug: "banheiro_servico",
    label: "Banheiro de serviço",
    shortLabel: "B. serviço",
    polygon: "555,1130 714,1130 714,1286 555,1286",
  },
  {
    slug: "fogao",
    label: "Fogão",
    shortLabel: "Fogão",
  },
];

const HOUSE_ACTION_TIMEOUT_MS = 20_000;

type MapActionTarget = SelectedTarget | "initialize";
type MapActionState = FormActionState & {
  targetKey: MapActionTarget | null;
  attemptId: string;
};

const initialMapActionState: MapActionState = {
  ...initialFormActionState,
  targetKey: null,
  attemptId: "initial",
};

type HouseAction = (
  previousState: FormActionState,
  formData: FormData,
) => Promise<FormActionState>;

async function runWithClientTimeout(
  action: HouseAction,
  previousState: MapActionState,
  formData: FormData,
  fallbackTarget: MapActionTarget,
): Promise<MapActionState> {
  const submittedTarget = String(formData.get("area_slug") ?? "");
  const targetKey = MAP_TARGETS.some(
    (target) => target.slug === submittedTarget,
  )
    ? (submittedTarget as SelectedTarget)
    : fallbackTarget;
  const attemptId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FormActionState>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        status: "error",
        message:
          "A ação não respondeu a tempo. O mapa será atualizado para conferir o resultado.",
      });
    }, HOUSE_ACTION_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([action(previousState, formData), timeout]);
    return { ...result, targetKey, attemptId };
  } catch {
    return {
      status: "error" as const,
      message:
        "Não foi possível concluir a ação. Seus dados foram mantidos; confira o mapa antes de tentar novamente.",
      targetKey,
      attemptId,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function initializeMapWithTimeout(
  previousState: MapActionState,
  formData: FormData,
) {
  return runWithClientTimeout(
    initializeHouseCleaningMap,
    previousState,
    formData,
    "initialize",
  );
}

function saveRotationWithTimeout(
  previousState: MapActionState,
  formData: FormData,
) {
  return runWithClientTimeout(
    saveHouseCleaningRotation,
    previousState,
    formData,
    "sala",
  );
}

function changeTurnWithTimeout(
  previousState: MapActionState,
  formData: FormData,
) {
  return runWithClientTimeout(
    changeHouseCleaningTurn,
    previousState,
    formData,
    "sala",
  );
}

function confirmCleaningWithTimeout(
  previousState: MapActionState,
  formData: FormData,
) {
  return runWithClientTimeout(
    registerHouseCleaning,
    previousState,
    formData,
    "sala",
  );
}

function confirmStoveWithTimeout(
  previousState: MapActionState,
  formData: FormData,
) {
  return runWithClientTimeout(
    confirmStoveCleaning,
    previousState,
    formData,
    "fogao",
  );
}

function isUncertainResult(state: FormActionState) {
  if (state.status !== "error") return false;
  const message = state.message.toLocaleLowerCase("pt-BR");
  return (
    message.includes("não respondeu a tempo") ||
    message.includes("demorou") ||
    message.includes("sincroniz") ||
    message.includes("conferir o resultado") ||
    message.includes("conferir o mapa")
  );
}

function useRefreshAfterResult(state: MapActionState) {
  const router = useRouter();

  useEffect(() => {
    if (state.status === "idle") return;

    const uncertain = isUncertainResult(state);
    if (state.status !== "success" && !uncertain) return;

    router.refresh();
    if (!uncertain) return;

    const retryIds = [2_000, 5_000, 10_000].map((delay) =>
      window.setTimeout(() => router.refresh(), delay),
    );
    return () => retryIds.forEach((id) => window.clearTimeout(id));
  }, [router, state.attemptId, state.message, state.status]);
}

function formatDate(value: string | null) {
  if (!value) return "Ainda não registrado";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00-03:00`)
    : new Date(value);

  if (Number.isNaN(date.getTime())) return "Data não informada";
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  });
}

function shortName(name: string) {
  return name.trim().split(/\s+/).filter(Boolean)[0] ?? name;
}

function memberNames(members: HouseMapMember[]) {
  if (members.length === 0) return "Ninguém definido";
  return new Intl.ListFormat("pt-BR", {
    style: "long",
    type: "conjunction",
  }).format(members.map((member) => member.name));
}

function snapshotNames(names: string[]) {
  if (names.length === 0) return "Morador não informado";
  return new Intl.ListFormat("pt-BR", {
    style: "long",
    type: "conjunction",
  }).format(names);
}

function initialCleanerIds(
  area: HouseMapArea,
  currentMemberId: string | null,
) {
  if (area.cleaningMode === "round_robin") {
    return area.currentMembers.map((member) => member.id);
  }
  if (area.cleaningMode === "fixed") {
    return area.rotationMembers
      .slice(0, area.maxCleaners)
      .map((member) => member.id);
  }
  if (area.cleaningMode === "balanced" && area.suggestedMembers.length > 0) {
    return area.suggestedMembers
      .slice(0, area.maxCleaners)
      .map((member) => member.id);
  }
  if (
    currentMemberId &&
    area.rotationMembers.some((member) => member.id === currentMemberId)
  ) {
    return [currentMemberId];
  }
  return area.rotationMembers
    .slice(0, area.minCleaners)
    .map((member) => member.id);
}

function MemberAvatars({ members }: { members: HouseMapMember[] }) {
  if (members.length === 0) return null;

  return (
    <div className={styles.avatarStack} aria-hidden="true">
      {members.map((member) => (
        <span
          className={`avatar avatar-${member.color_key}`}
          key={member.id}
        >
          {member.initials}
        </span>
      ))}
    </div>
  );
}

function TurnCard({
  eyebrow,
  members,
  detail,
  muted = false,
}: {
  eyebrow: string;
  members: HouseMapMember[];
  detail: string;
  muted?: boolean;
}) {
  return (
    <div className={`${styles.turnCard} ${muted ? styles.turnCardMuted : ""}`}>
      <span className={styles.eyebrow}>{eyebrow}</span>
      <div className={styles.turnIdentity}>
        <MemberAvatars members={members} />
        <div>
          <strong>{memberNames(members)}</strong>
          <small>{detail}</small>
        </div>
      </div>
    </div>
  );
}

function HistoryList({
  history,
  showNextTeam,
}: {
  history: HouseMapHistoryEntry[];
  showNextTeam: boolean;
}) {
  return (
    <details className={styles.history} open={history.length > 0}>
      <summary>Últimas limpezas ({history.length})</summary>
      <div className={styles.historyList}>
        {history.map((entry) => (
          <div className={styles.historyRow} key={entry.id}>
            <div>
              <strong>{snapshotNames(entry.memberNamesSnapshot)}</strong>
              <small>{entry.note || "Limpeza confirmada"}</small>
            </div>
            <div>
              <strong>{formatDate(entry.cleanedOn)}</strong>
              {showNextTeam && (
                <small>
                  {entry.nextMemberNamesSnapshot.length > 0
                    ? `Próximos: ${snapshotNames(entry.nextMemberNamesSnapshot)}`
                    : "Próximo grupo ainda não definido"}
                </small>
              )}
            </div>
          </div>
        ))}
        {history.length === 0 && (
          <div className={styles.emptyHistory}>Nenhuma limpeza registrada.</div>
        )}
      </div>
    </details>
  );
}

function HouseAreaPanel({
  area,
  allMembers,
  canManage,
  currentMemberId,
  mutationsReady,
  confirmState,
  confirmAction,
  confirmPending,
  saveState,
  saveAction,
  savePending,
  turnState,
  turnAction,
  turnPending,
}: {
  area: HouseMapArea;
  allMembers: HouseMapMember[];
  canManage: boolean;
  currentMemberId: string | null;
  mutationsReady: boolean;
  confirmState: MapActionState;
  confirmAction: (formData: FormData) => void;
  confirmPending: boolean;
  saveState: MapActionState;
  saveAction: (formData: FormData) => void;
  savePending: boolean;
  turnState: MapActionState;
  turnAction: (formData: FormData) => void;
  turnPending: boolean;
}) {
  const [draftMembers, setDraftMembers] = useState(area.rotationMembers);
  const [peoplePerTurn, setPeoplePerTurn] = useState<1 | 2>(area.peoplePerTurn);
  const [allowIncomplete, setAllowIncomplete] = useState(area.allowIncomplete);
  const [memberToAdd, setMemberToAdd] = useState("");
  const [targetStartMemberId, setTargetStartMemberId] = useState(
    area.currentStartMemberId ?? area.rotationMembers[0]?.id ?? "",
  );
  const [turnNote, setTurnNote] = useState("");
  const [cleanedAt, setCleanedAt] = useState(todayIso());
  const [cleaningNote, setCleaningNote] = useState("");
  const [selectedCleanerIds, setSelectedCleanerIds] = useState(() =>
    initialCleanerIds(area, currentMemberId),
  );
  const persistedRotationKey = area.rotationMembers
    .map((member) => member.id)
    .join("|");
  const suggestedKey = area.suggestedMembers
    .map((member) => member.id)
    .join("|");
  const areaSyncKey = [
    area.id,
    String(area.turnNumber ?? ""),
    area.currentStartMemberId ?? "",
    area.peoplePerTurn,
    area.allowIncomplete ? "1" : "0",
    area.cleaningMode,
    area.minCleaners,
    area.maxCleaners,
    persistedRotationKey,
    suggestedKey,
  ].join(":");

  useEffect(() => {
    setDraftMembers(area.rotationMembers);
    setPeoplePerTurn(area.peoplePerTurn);
    setAllowIncomplete(area.allowIncomplete);
    setMemberToAdd("");
    setTargetStartMemberId(
      area.currentStartMemberId ?? area.rotationMembers[0]?.id ?? "",
    );
    setTurnNote("");
    setCleanedAt(todayIso());
    setCleaningNote("");
    setSelectedCleanerIds(initialCleanerIds(area, currentMemberId));
  }, [areaSyncKey]);

  useEffect(() => {
    if (
      confirmState.status === "success" &&
      confirmState.targetKey === area.slug
    ) {
      setCleanedAt(todayIso());
      setCleaningNote("");
      setSelectedCleanerIds(initialCleanerIds(area, currentMemberId));
    }
  }, [area.slug, confirmState.attemptId, confirmState.status, confirmState.targetKey]);

  useEffect(() => {
    if (
      turnState.status === "success" &&
      turnState.targetKey === area.slug
    ) {
      setTurnNote("");
    }
  }, [area.slug, turnState.attemptId, turnState.status, turnState.targetKey]);

  const availableMembers = useMemo(() => {
    const selectedIds = new Set(draftMembers.map((member) => member.id));
    return allMembers.filter((member) => !selectedIds.has(member.id));
  }, [allMembers, draftMembers]);

  const orderValid = draftMembers.length >= peoplePerTurn;
  const latestCleaning = area.history[0] ?? null;
  const isRoundRobin = area.cleaningMode === "round_robin";
  const isFixed = area.cleaningMode === "fixed";
  const cleanerCountValid =
    selectedCleanerIds.length >= area.minCleaners &&
    selectedCleanerIds.length <= area.maxCleaners;
  const currentUserMayRegister = Boolean(
    canManage ||
      (currentMemberId && selectedCleanerIds.includes(currentMemberId)),
  );
  const turnStartCandidates = area.allowIncomplete
    ? area.rotationMembers.filter(
        (_member, index) => index % area.peoplePerTurn === 0,
      )
    : area.rotationMembers;

  function moveMember(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draftMembers.length) return;

    setDraftMembers((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  function removeMember(memberId: string) {
    setDraftMembers((current) =>
      current.filter((member) => member.id !== memberId),
    );
  }

  function addMember() {
    const member = allMembers.find((candidate) => candidate.id === memberToAdd);
    if (!member || draftMembers.some((candidate) => candidate.id === member.id)) {
      return;
    }
    setDraftMembers((current) => [...current, member]);
    setMemberToAdd("");
  }

  function toggleCleaner(memberId: string) {
    if (isFixed || isRoundRobin) return;
    setSelectedCleanerIds((current) => {
      if (current.includes(memberId)) {
        return current.filter((id) => id !== memberId);
      }
      if (current.length >= area.maxCleaners) return current;
      return [...current, memberId];
    });
  }

  const modeSummary =
    area.cleaningMode === "fixed"
      ? `${memberNames(area.rotationMembers)} é responsável por este cômodo.`
      : area.cleaningMode === "flexible"
        ? `A limpeza pode ser registrada por ${memberNames(area.rotationMembers)}, individualmente ou em conjunto quando permitido.`
        : area.cleaningMode === "balanced"
          ? `A casa sugere ${area.maxCleaners === 2 ? "a próxima dupla" : "a próxima pessoa"} priorizando quem participou menos das limpezas anteriores.`
          : "A vez segue a ordem configurada e avança depois de cada confirmação.";

  return (
    <div className={styles.panelBody}>
      <div className={styles.panelHeading}>
        <div>
          <span className={styles.eyebrow}>Cômodo selecionado</span>
          <h2>{area.name}</h2>
        </div>
        <span
          className={`${styles.statusPill} ${
            area.configurationReady ? styles.statusReady : styles.statusPending
          }`}
        >
          {area.configurationReady ? "Regra ativa" : "Configuração pendente"}
        </span>
      </div>

      {area.configurationReady ? (
        <>
          {isRoundRobin ? (
            <div className={styles.turnGrid}>
              <TurnCard
                eyebrow={area.currentMembers.length > 1 ? "Dupla da vez" : "Pessoa da vez"}
                members={area.currentMembers}
                detail={
                  area.currentSince
                    ? `Nesta vez desde ${formatDate(area.currentSince)}`
                    : "Aguardando a primeira limpeza"
                }
              />
              <TurnCard
                eyebrow={area.nextMembers.length > 1 ? "Próxima dupla" : "Próxima pessoa"}
                members={area.nextMembers}
                detail="Entra quando a limpeza atual for confirmada"
                muted
              />
            </div>
          ) : (
            <div className={styles.turnGrid}>
              <TurnCard
                eyebrow={
                  area.cleaningMode === "balanced"
                    ? area.maxCleaners === 2
                      ? "Dupla sugerida para esta vez"
                      : "Pessoa sugerida para esta vez"
                    : "Quem pode limpar"
                }
                members={
                  area.cleaningMode === "balanced"
                    ? area.suggestedMembers
                    : area.rotationMembers
                }
                detail={modeSummary}
              />
              <div className={`${styles.turnCard} ${styles.turnCardMuted}`}>
                <span className={styles.eyebrow}>Como funciona</span>
                <div className={styles.ruleText}>
                  <strong>
                    {area.minCleaners === area.maxCleaners
                      ? area.minCleaners === 2
                        ? "Sempre em dupla"
                        : "Uma pessoa por limpeza"
                      : "Uma pessoa ou a dupla"}
                  </strong>
                  <small>
                    Quem participou seleciona o próprio nome e registra a data.
                  </small>
                </div>
              </div>
            </div>
          )}

          {latestCleaning && (
            <div className={styles.latestCleaning}>
              <span>Última limpeza</span>
              <strong>{snapshotNames(latestCleaning.memberNamesSnapshot)}</strong>
              <small>{formatDate(latestCleaning.cleanedOn)}</small>
            </div>
          )}

          {area.turnNumber !== null && (
            <form
              action={confirmAction}
              className={styles.confirmForm}
            >
              <input type="hidden" name="area_slug" value={area.slug} />
              {selectedCleanerIds.map((memberId) => (
                <input
                  type="hidden"
                  name="cleaner_member_ids"
                  value={memberId}
                  key={memberId}
                />
              ))}
              <input
                type="hidden"
                name="expected_turn_number"
                value={String(area.turnNumber)}
              />
              <div className={styles.formIntro}>
                <strong>Quem limpou este cômodo?</strong>
                <small>
                  {isRoundRobin
                    ? `Confirme a equipe da vez: ${memberNames(area.currentMembers)}.`
                    : "Selecione quem realmente participou; o registro ficará no histórico."}
                </small>
              </div>
              {!isRoundRobin && (
                <fieldset className={styles.cleanerPicker}>
                  <legend>
                    {area.maxCleaners === 2 ? "Participantes" : "Responsável"}
                  </legend>
                  <div className={styles.cleanerOptions}>
                    {area.rotationMembers.map((member) => {
                      const selected = selectedCleanerIds.includes(member.id);
                      const atLimit =
                        !selected && selectedCleanerIds.length >= area.maxCleaners;
                      return (
                        <label
                          className={`${styles.cleanerOption} ${
                            selected ? styles.cleanerOptionSelected : ""
                          }`}
                          key={member.id}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={isFixed || atLimit}
                            onChange={() => toggleCleaner(member.id)}
                          />
                          <span className={`avatar avatar-${member.color_key}`}>
                            {member.initials}
                          </span>
                          <span>{member.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <small>
                    Selecione de {area.minCleaners} a {area.maxCleaners} pessoa(s).
                  </small>
                </fieldset>
              )}
              <label className="field">
                Data da limpeza
                <input
                  type="date"
                  name="cleaned_on"
                  value={cleanedAt}
                  max={todayIso()}
                  onChange={(event) => setCleanedAt(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                Observação
                <input
                  name="note"
                  value={cleaningNote}
                  maxLength={300}
                  placeholder="Opcional"
                  onChange={(event) => setCleaningNote(event.target.value)}
                />
              </label>
              <SubmitButton
                pendingLabel="Confirmando..."
                disabled={
                  !mutationsReady ||
                  !cleanerCountValid ||
                  !currentUserMayRegister
                }
              >
                ✓ Registrar limpeza
              </SubmitButton>
              {!currentUserMayRegister && cleanerCountValid && (
                <p className={styles.permissionHint}>
                  Para registrar, seu nome precisa estar entre quem limpou. Um
                  administrador também pode confirmar por outra pessoa.
                </p>
              )}
              {!cleanerCountValid && (
                <p className={styles.permissionHint}>
                  Escolha {area.minCleaners === area.maxCleaners
                    ? `exatamente ${area.minCleaners}`
                    : `entre ${area.minCleaners} e ${area.maxCleaners}`} pessoa(s).
                </p>
              )}
              {!confirmPending && confirmState.targetKey === area.slug && (
                <FormActionMessage state={confirmState} inline />
              )}
            </form>
          )}
        </>
      ) : (
        <div className={styles.areaEmpty}>
          <strong>Rodízio ainda não iniciado</strong>
          <p>
            {canManage
              ? "Aplique a configuração deste cômodo para começar a registrar as limpezas."
              : "O administrador ainda precisa configurar este cômodo."}
          </p>
        </div>
      )}

      {canManage && isRoundRobin && (
        <details
          className={styles.settings}
          open={!area.configurationReady ? true : undefined}
        >
          <summary>⚙ Configurar rodízio deste cômodo</summary>
          <div className={styles.settingsBody}>
            {!mutationsReady && (
              <div className={`message error ${styles.settingsLoadGuard}`} role="alert">
                As alterações estão desativadas até os dados deste rodízio carregarem por completo.
              </div>
            )}
            <form
              action={saveAction}
              className={styles.orderForm}
            >
              <input type="hidden" name="area_slug" value={area.slug} />
              {draftMembers.map((member) => (
                <input
                  type="hidden"
                  name="member_ids"
                  value={member.id}
                  key={member.id}
                />
              ))}

              <div className={styles.settingFields}>
                <label className="field">
                  Pessoas por vez
                  <select
                    name="people_per_turn"
                    value={peoplePerTurn}
                    onChange={(event) =>
                      setPeoplePerTurn(Number(event.target.value) as 1 | 2)
                    }
                  >
                    <option value={1}>Uma pessoa</option>
                    <option value={2}>Dupla</option>
                  </select>
                </label>
                <label className={styles.checkboxField}>
                  <input
                    type="checkbox"
                    name="allow_incomplete_last_group"
                    value="true"
                    checked={allowIncomplete}
                    onChange={(event) => setAllowIncomplete(event.target.checked)}
                  />
                  <span>
                    Permitir que o último grupo tenha apenas uma pessoa
                  </span>
                </label>
              </div>

              <div className={styles.orderList}>
                {draftMembers.map((member, index) => (
                  <div className={styles.orderRow} key={member.id}>
                    <span className={styles.orderPosition}>{index + 1}</span>
                    <span className={`avatar avatar-${member.color_key}`}>
                      {member.initials}
                    </span>
                    <div className={styles.orderMemberName}>
                      <strong>{member.name}</strong>
                      <small>Posição {index + 1} na sequência</small>
                    </div>
                    <div className={styles.orderActions}>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={index === 0}
                        onClick={() => moveMember(index, -1)}
                        aria-label={`Mover ${member.name} para cima`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={index === draftMembers.length - 1}
                        onClick={() => moveMember(index, 1)}
                        aria-label={`Mover ${member.name} para baixo`}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={`icon-button ${styles.removeButton}`}
                        onClick={() => removeMember(member.id)}
                        aria-label={`Retirar ${member.name} do rodízio`}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
                {draftMembers.length === 0 && (
                  <div className={styles.orderEmpty}>
                    Inclua moradores para montar a ordem.
                  </div>
                )}
              </div>

              <div className={styles.addMemberRow}>
                <label className="field">
                  Adicionar à ordem
                  <select
                    value={memberToAdd}
                    onChange={(event) => setMemberToAdd(event.target.value)}
                    disabled={availableMembers.length === 0}
                  >
                    <option value="">
                      {availableMembers.length > 0
                        ? "Selecione um morador"
                        : "Todos já foram incluídos"}
                    </option>
                    {availableMembers.map((member) => (
                      <option value={member.id} key={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="button ghost"
                  disabled={!memberToAdd}
                  onClick={addMember}
                >
                  + Incluir
                </button>
              </div>

              <SubmitButton
                className="button secondary"
                pendingLabel="Salvando ordem..."
                disabled={!orderValid || !mutationsReady}
              >
                Salvar ordem
              </SubmitButton>
              {!savePending && saveState.targetKey === area.slug && (
                <FormActionMessage state={saveState} inline />
              )}
            </form>

            <form
              action={turnAction}
              className={styles.turnForm}
            >
              <input type="hidden" name="area_slug" value={area.slug} />
              <label className="field">
                Definir quem começa a vez
                <select
                  name="current_member_id"
                  value={targetStartMemberId}
                  onChange={(event) =>
                    setTargetStartMemberId(event.target.value)
                  }
                  disabled={turnStartCandidates.length === 0}
                  required
                >
                  {turnStartCandidates.length === 0 && (
                    <option value="">Salve uma ordem primeiro</option>
                  )}
                  {turnStartCandidates.map((member) => (
                    <option value={member.id} key={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Motivo da alteração
                <input
                  name="note"
                  value={turnNote}
                  maxLength={300}
                  placeholder="Opcional"
                  onChange={(event) => setTurnNote(event.target.value)}
                />
              </label>
              <SubmitButton
                className="button ghost"
                pendingLabel="Alterando..."
                disabled={!targetStartMemberId || !mutationsReady}
              >
                Alterar pessoa ou dupla da vez
              </SubmitButton>
              {!turnPending && turnState.targetKey === area.slug && (
                <FormActionMessage state={turnState} inline />
              )}
            </form>
          </div>
        </details>
      )}

      <HistoryList
        history={area.history}
        showNextTeam={
          area.cleaningMode === "balanced" ||
          area.cleaningMode === "round_robin"
        }
      />
    </div>
  );
}

function StovePanel({
  stove,
  mutationsReady,
  confirmState,
  confirmAction,
  confirmPending,
}: {
  stove: HouseMapStove;
  mutationsReady: boolean;
  confirmState: MapActionState;
  confirmAction: (formData: FormData) => void;
  confirmPending: boolean;
}) {
  const [note, setNote] = useState("");
  const currentMember = stove.members.find(
    (member) => member.id === stove.currentMemberId,
  );
  const currentIndex = stove.members.findIndex(
    (member) => member.id === stove.currentMemberId,
  );
  const nextMember =
    currentIndex >= 0 && stove.members.length > 0
      ? stove.members[(currentIndex + 1) % stove.members.length]
      : undefined;
  const latestCleaning = stove.history[0] ?? null;

  useEffect(() => {
    if (
      confirmState.status === "success" &&
      confirmState.targetKey === "fogao"
    ) {
      setNote("");
    }
  }, [confirmState.attemptId, confirmState.status, confirmState.targetKey]);

  return (
    <div className={styles.panelBody}>
      <div className={styles.panelHeading}>
        <div>
          <span className={styles.eyebrow}>Item selecionado</span>
          <h2>Fogão</h2>
        </div>
        <span
          className={`${styles.statusPill} ${
            stove.configurationReady ? styles.statusReady : styles.statusPending
          }`}
        >
          {stove.configurationReady ? "Rodízio ativo" : "Configuração pendente"}
        </span>
      </div>

      {stove.configurationReady && currentMember ? (
        <>
          <div className={styles.turnGrid}>
            <TurnCard
              eyebrow="Pessoa da vez"
              members={[currentMember]}
              detail={
                stove.currentSince
                  ? `Nesta vez desde ${formatDate(stove.currentSince)}`
                  : "Aguardando a primeira limpeza"
              }
            />
            <TurnCard
              eyebrow="Próxima pessoa"
              members={nextMember ? [nextMember] : []}
              detail="Entra após a confirmação atual"
              muted
            />
          </div>

          {latestCleaning && (
            <div className={styles.latestCleaning}>
              <span>Última limpeza</span>
              <strong>{latestCleaning.memberNameSnapshot}</strong>
              <small>{formatDate(latestCleaning.cleanedAt)}</small>
            </div>
          )}

          {stove.currentTurnNumber !== null && (
            <form action={confirmAction} className={styles.confirmForm}>
              <input
                type="hidden"
                name="expected_member_id"
                value={currentMember.id}
              />
              <input
                type="hidden"
                name="expected_turn_number"
                value={String(stove.currentTurnNumber)}
              />
              <div className={styles.formIntro}>
                <strong>O fogão já foi limpo?</strong>
                <small>
                  Ao confirmar, a vez passa para {nextMember?.name ?? "a próxima pessoa"}.
                </small>
              </div>
              <label className={`field ${styles.stoveNote}`}>
                Observação
                <input
                  name="note"
                  value={note}
                  maxLength={300}
                  placeholder="Opcional"
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <SubmitButton
                pendingLabel="Confirmando..."
                disabled={!mutationsReady}
              >
                ✓ Confirmar que {shortName(currentMember.name)} limpou
              </SubmitButton>
              {!confirmPending && confirmState.targetKey === "fogao" && (
                <FormActionMessage state={confirmState} inline />
              )}
            </form>
          )}
        </>
      ) : (
        <div className={styles.areaEmpty}>
          <strong>Rodízio do fogão ainda não iniciado</strong>
          <p>A configuração completa continua disponível na página do fogão.</p>
        </div>
      )}

      <div className={styles.stoveManageLink}>
        <div>
          <strong>Ordem do fogão</strong>
          <small>
            Este mapa apenas reaproveita o rodízio existente, sem duplicar a configuração.
          </small>
        </div>
        <Link className="button ghost" href="/app/limpeza/fogao">
          Abrir rodízio do fogão
        </Link>
      </div>

      {!mutationsReady && (
        <div className="message error" role="alert">
          A confirmação está desativada até o rodízio do fogão carregar por completo.
        </div>
      )}

      <details className={styles.history} open={stove.history.length > 0}>
        <summary>Últimas limpezas ({stove.history.length})</summary>
        <div className={styles.historyList}>
          {stove.history.map((entry) => (
            <div className={styles.historyRow} key={entry.id}>
              <div>
                <strong>{entry.memberNameSnapshot}</strong>
                <small>{entry.note || "Limpeza confirmada"}</small>
              </div>
              <div>
                <strong>{formatDate(entry.cleanedAt)}</strong>
                <small>
                  {entry.nextMemberNameSnapshot
                    ? `Próxima: ${entry.nextMemberNameSnapshot}`
                    : "Próxima pessoa ainda não definida"}
                </small>
              </div>
            </div>
          ))}
          {stove.history.length === 0 && (
            <div className={styles.emptyHistory}>Nenhuma limpeza registrada.</div>
          )}
        </div>
      </details>
    </div>
  );
}

export function InteractiveHouseMap({
  members,
  areas,
  stove,
  canManage,
  currentMemberId,
  houseMutationsReady,
  stoveMutationsReady,
  loadError,
}: InteractiveHouseMapProps) {
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget>(
    areas[0]?.slug ?? "sala",
  );
  const detailPanelRef = useRef<HTMLElement | null>(null);

  const [initializeState, initializeAction, initializePending] = useActionState(
    initializeMapWithTimeout,
    initialMapActionState,
  );
  const [saveState, saveAction, savePending] = useActionState(
    saveRotationWithTimeout,
    initialMapActionState,
  );
  const [turnState, turnAction, turnPending] = useActionState(
    changeTurnWithTimeout,
    initialMapActionState,
  );
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmCleaningWithTimeout,
    initialMapActionState,
  );
  const [stoveConfirmState, stoveConfirmAction, stoveConfirmPending] = useActionState(
    confirmStoveWithTimeout,
    initialMapActionState,
  );

  useRefreshAfterResult(initializeState);
  useRefreshAfterResult(saveState);
  useRefreshAfterResult(turnState);
  useRefreshAfterResult(confirmState);
  useRefreshAfterResult(stoveConfirmState);

  const selectedMapTarget =
    MAP_TARGETS.find((target) => target.slug === selectedTarget) ?? MAP_TARGETS[0];
  const mapNeedsInitialization =
    areas.length === 0 ||
    areas.some((area) => area.id === area.slug);

  function selectTarget(target: SelectedTarget, moveFocus = false) {
    setSelectedTarget(target);
    if (!window.matchMedia("(max-width: 1180px)").matches) return;

    window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (moveFocus) detailPanelRef.current?.focus({ preventScroll: true });
      detailPanelRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  }

  return (
    <section className={`card ${styles.mapCard}`}>
      <div className={styles.cardHeading}>
        <div>
          <span className={styles.eyebrow}>Casa interativa</span>
          <h1>Mapa de limpeza</h1>
          <p>
            Selecione um cômodo para consultar ou confirmar a limpeza e organizar o rodízio.
          </p>
        </div>
        <span className={styles.mapHint}>Toque em um ambiente</span>
      </div>

      {loadError && (
        <div className={`message error ${styles.loadError}`} role="alert">
          {loadError}
        </div>
      )}

      {mapNeedsInitialization && (
        <div className={styles.initializeBanner}>
          <div>
            <strong>O mapa ainda precisa ser preparado</strong>
            <span>
              A inicialização cria todos os cômodos; depois você escolhe a ordem de cada um.
            </span>
          </div>
          {canManage ? (
            <form action={initializeAction}>
              <SubmitButton
                pendingLabel="Preparando mapa..."
                disabled={!houseMutationsReady}
              >
                Preparar mapa de limpeza
              </SubmitButton>
            </form>
          ) : (
            <span className={styles.statusPill}>Aguardando administrador</span>
          )}
          {!initializePending && (
            <FormActionMessage state={initializeState} inline />
          )}
        </div>
      )}

      <div className={styles.mapLayout}>
        <div className={styles.mapColumn}>
          <figure className={styles.mapFigure}>
            <div className={styles.mapCanvas}>
              <Image
                src="/images/casa-interativa-final.png"
                width={1055}
                height={1491}
                alt="Planta tridimensional da casa vista de cima"
                className={styles.houseImage}
                sizes="(max-width: 1180px) calc(100vw - 40px), 570px"
              />
              <svg
                className={styles.regionOverlay}
                viewBox="0 0 1055 1491"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {MAP_TARGETS.filter((target) => target.polygon).map((target) => (
                  <polygon
                    key={target.slug}
                    points={target.polygon}
                    className={
                      target.slug === selectedTarget
                        ? styles.regionSelected
                        : styles.region
                    }
                    onClick={() => selectTarget(target.slug)}
                  />
                ))}
                <circle
                  cx="488"
                  cy="1271"
                  r="27"
                  className={
                    selectedTarget === "fogao"
                      ? styles.stovePinSelected
                      : styles.stovePin
                  }
                  onClick={() => selectTarget("fogao")}
                />
              </svg>
            </div>
            <figcaption>
              A área em roxo é a seleção atual. Você também pode usar a lista abaixo.
            </figcaption>
          </figure>

          <nav className={styles.roomSelector} aria-label="Ambientes da casa">
            {MAP_TARGETS.map((target) => {
              const area = areas.find((candidate) => candidate.slug === target.slug);
              const currentLabel =
                target.slug === "fogao"
                  ? stove.members.find(
                      (member) => member.id === stove.currentMemberId,
                    )?.name
                  : area?.cleaningMode === "flexible"
                    ? area.rotationMembers
                        .map((member) => shortName(member.name))
                        .join(" ou ")
                    : area?.currentMembers
                        .map((member) => shortName(member.name))
                        .join(" + ");

              return (
                <button
                  type="button"
                  key={target.slug}
                  className={`${styles.roomButton} ${
                    selectedTarget === target.slug ? styles.roomButtonSelected : ""
                  }`}
                  onClick={(event) =>
                    selectTarget(target.slug, event.detail === 0)
                  }
                  aria-current={selectedTarget === target.slug ? "true" : undefined}
                >
                  <span>{target.slug === "fogao" ? "🔥" : "⌂"}</span>
                  <div>
                    <strong>{target.label}</strong>
                    <small>
                      {currentLabel ||
                        (area?.cleaningMode === "flexible"
                          ? "Responsáveis não configurados"
                          : "Rodízio não iniciado")}
                    </small>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        <aside
          ref={detailPanelRef}
          className={styles.detailPanel}
          aria-label={`Detalhes de ${selectedMapTarget.label}`}
          tabIndex={-1}
        >
          <span className={styles.srOnly} aria-live="polite">
            {selectedMapTarget.label} selecionado
          </span>
          <div hidden={selectedTarget !== "fogao"}>
            <StovePanel
              stove={stove}
              mutationsReady={stoveMutationsReady}
              confirmState={stoveConfirmState}
              confirmAction={stoveConfirmAction}
              confirmPending={stoveConfirmPending}
            />
          </div>

          {!mapNeedsInitialization &&
            areas.map((area) => (
              <div hidden={selectedTarget !== area.slug} key={area.id}>
                <HouseAreaPanel
                  area={area}
                  allMembers={members}
                  canManage={canManage}
                  currentMemberId={currentMemberId}
                  mutationsReady={houseMutationsReady}
                  confirmState={confirmState}
                  confirmAction={confirmAction}
                  confirmPending={confirmPending}
                  saveState={saveState}
                  saveAction={saveAction}
                  savePending={savePending}
                  turnState={turnState}
                  turnAction={turnAction}
                  turnPending={turnPending}
                />
              </div>
            ))}

          {selectedTarget !== "fogao" && mapNeedsInitialization && (
            <div className={styles.unavailablePanel}>
              <span className={styles.unavailableIcon}>⌂</span>
              <h2>{selectedMapTarget.label}</h2>
              <p>
                Este cômodo aparecerá aqui assim que o mapa de limpeza for inicializado.
              </p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
