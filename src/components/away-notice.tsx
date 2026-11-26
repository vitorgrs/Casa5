import { AwayIcon } from "@/components/icons";
import { formatHouseDate } from "@/lib/chore-rotation";
import { currentOrUpcomingAbsence, type MemberAbsence } from "@/lib/member-absences";

function shortDate(iso: string) {
  return formatHouseDate(iso, { year: undefined });
}

/**
 * Aviso de quem está fora de casa (ou sai em breve). Os rodízios desta página
 * já pulam essas pessoas; o aviso explica por que a ordem mudou.
 */
export function AwayNotice({
  members,
  absences,
  today,
}: {
  members: { id: string; name: string }[];
  absences: MemberAbsence[];
  today: string;
}) {
  const entries = members
    .map((member) => ({ member, absence: currentOrUpcomingAbsence(member.id, today, absences) }))
    .filter(
      (entry): entry is { member: { id: string; name: string }; absence: MemberAbsence } =>
        entry.absence !== null,
    );
  if (entries.length === 0) return null;

  return (
    <div className="message info away-notice" role="status">
      <AwayIcon aria-hidden="true" />
      <div>
        <strong>Fora dos rodízios:</strong>{" "}
        {entries
          .map(({ member, absence }) => {
            const name = member.name.split(" ")[0];
            if (absence.left_on > today) return `${name} (sai em ${shortDate(absence.left_on)})`;
            return absence.returned_on
              ? `${name} (volta em ${shortDate(absence.returned_on)})`
              : `${name} (sem data de volta)`;
          })
          .join(", ")}
        . A vez passa para a próxima pessoa presente e, na volta, cada um retoma
        a mesma posição.
      </div>
    </div>
  );
}
