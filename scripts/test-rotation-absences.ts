import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, rotationMemberForDate } from "../src/lib/chore-rotation.ts";
import {
  laundryAssignmentsForDate,
  type LaundryRotationVersion,
} from "../src/lib/laundry-rotation.ts";
import { isMemberAway, type MemberAbsence } from "../src/lib/member-absences.ts";

const members = ["vitor", "belo", "savio", "patrick", "william"].map((id, index) => ({
  id,
  name: id,
  initials: id.slice(0, 2).toUpperCase(),
  color_key: "violet",
  rotation_order: index + 1,
}));

function dailySequence(start: string, from: string, days: number, absences: MemberAbsence[]) {
  return Array.from({ length: days }, (_, index) =>
    rotationMemberForDate(addDays(from, index), start, members, [], absences)?.id ?? "-",
  );
}

test("escala diária sem ausências mantém o cálculo direto", () => {
  assert.deepEqual(dailySequence("2026-11-27", "2026-11-27", 7, []), [
    "vitor", "belo", "savio", "patrick", "william", "vitor", "belo",
  ]);
});

test("escala diária pula quem está fora e devolve a mesma posição na volta", () => {
  const absences = [{ member_id: "belo", left_on: "2026-11-28", returned_on: "2026-12-03" }];
  // Mesmo resultado de public.daily_rotation_assignee no banco.
  assert.deepEqual(dailySequence("2026-11-27", "2026-11-27", 12, absences), [
    "vitor", "savio", "patrick", "william", "vitor", "savio",
    "patrick", "william", "vitor", "belo", "savio", "patrick",
  ]);
});

test("ausência sem data de volta continua pulando a pessoa", () => {
  const absences = [{ member_id: "vitor", left_on: "2026-11-27", returned_on: null }];
  assert.deepEqual(dailySequence("2026-11-27", "2026-11-27", 5, absences), [
    "belo", "savio", "patrick", "william", "belo",
  ]);
});

test("saída cancelada (volta no mesmo dia da saída) não altera a escala", () => {
  const absences = [{ member_id: "belo", left_on: "2026-11-28", returned_on: "2026-11-28" }];
  assert.deepEqual(
    dailySequence("2026-11-27", "2026-11-27", 5, absences),
    dailySequence("2026-11-27", "2026-11-27", 5, []),
  );
});

test("datas anteriores à ausência não mudam", () => {
  const absences = [{ member_id: "savio", left_on: "2026-12-10", returned_on: null }];
  assert.deepEqual(
    dailySequence("2026-11-27", "2026-11-27", 13, absences),
    dailySequence("2026-11-27", "2026-11-27", 13, []),
  );
});

test("isMemberAway usa intervalo semiaberto", () => {
  const absences = [{ member_id: "belo", left_on: "2026-11-28", returned_on: "2026-12-03" }];
  assert.equal(isMemberAway("belo", "2026-11-27", absences), false);
  assert.equal(isMemberAway("belo", "2026-11-28", absences), true);
  assert.equal(isMemberAway("belo", "2026-12-02", absences), true);
  assert.equal(isMemberAway("belo", "2026-12-03", absences), false);
});

function laundryVersion(overrides: Partial<LaundryRotationVersion>): LaundryRotationVersion {
  return {
    id: "v1",
    effective_from: "2026-11-01",
    anchor_date: "2026-11-01",
    anchor_member_id: "vitor",
    gap_days: 2,
    people_per_day: 2,
    allow_incomplete_last_group: true,
    members,
    ...overrides,
  };
}

function laundryTurns(version: LaundryRotationVersion, turns: number, absences: MemberAbsence[]) {
  const step = version.gap_days + 1;
  return Array.from({ length: turns }, (_, turn) => {
    const assignment = laundryAssignmentsForDate(
      addDays(version.anchor_date, turn * step),
      [version],
      [],
      [],
      absences,
    );
    return assignment ? assignment.members.map((member) => member.id).join("+") : "-";
  });
}

test("lavanderia com grupos fixos sem ausências", () => {
  assert.deepEqual(laundryTurns(laundryVersion({}), 4, []), [
    "vitor+belo", "savio+patrick", "william", "vitor+belo",
  ]);
});

test("lavanderia com grupos fixos tira quem está fora do próprio grupo", () => {
  // Patrick fora a partir do 2º turno (04/11) e volta no 5º (13/11).
  const absences = [{ member_id: "patrick", left_on: "2026-11-04", returned_on: "2026-11-13" }];
  assert.deepEqual(laundryTurns(laundryVersion({}), 6, absences), [
    "vitor+belo", "savio", "william", "vitor+belo", "savio+patrick", "william",
  ]);
});

test("lavanderia pula um grupo inteiro fora de casa", () => {
  const absences = [{ member_id: "william", left_on: "2026-11-01", returned_on: null }];
  assert.deepEqual(laundryTurns(laundryVersion({}), 4, absences), [
    "vitor+belo", "savio+patrick", "vitor+belo", "savio+patrick",
  ]);
});

test("lavanderia circular completa a dupla com a próxima pessoa presente", () => {
  const version = laundryVersion({ allow_incomplete_last_group: false });
  assert.deepEqual(laundryTurns(version, 3, []), [
    "vitor+belo", "savio+patrick", "william+vitor",
  ]);
  const absences = [{ member_id: "savio", left_on: "2026-11-01", returned_on: null }];
  assert.deepEqual(laundryTurns(version, 3, absences), [
    "vitor+belo", "patrick+william", "vitor+belo",
  ]);
});
