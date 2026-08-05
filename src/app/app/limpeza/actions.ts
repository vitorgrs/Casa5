"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";

export async function createChore(formData: FormData) {
  const { profile, supabase } = await requireAdmin();
  const memberIds = formData.getAll("members").map(String);
  const { data: chore, error } = await supabase
    .from("chores")
    .insert({
      household_id: profile.household_id,
      title: String(formData.get("title") ?? "").trim(),
      description: String(formData.get("description") ?? "") || null,
      points: Number(formData.get("points") ?? 10),
      frequency: String(formData.get("frequency") ?? "weekly"),
      weekday: formData.get("weekday") === "" ? null : Number(formData.get("weekday")),
      due_time: String(formData.get("due_time") ?? "") || null,
      created_by: profile.id
    })
    .select("id")
    .single();

  if (error || !chore) throw new Error(error?.message ?? "Não foi possível criar a tarefa.");
  if (memberIds.length) {
    const { error: assignmentError } = await supabase.from("chore_assignments").insert(
      memberIds.map((memberId, index) => ({ chore_id: chore.id, member_id: memberId, rotation_order: index + 1 }))
    );
    if (assignmentError) throw new Error(assignmentError.message);
  }

  revalidatePath("/app/limpeza");
}

export async function checkInChore(formData: FormData) {
  const { profile, supabase } = await requireAdmin();
  const choreId = String(formData.get("chore_id"));
  const memberId = String(formData.get("member_id"));
  const referenceDate = String(formData.get("reference_date") ?? new Date().toISOString().slice(0, 10));
  const { data: chore } = await supabase.from("chores").select("points,title").eq("id", choreId).single();
  if (!chore) throw new Error("Tarefa não encontrada.");

  const { error } = await supabase.from("chore_logs").upsert({
    chore_id: choreId,
    member_id: memberId,
    reference_date: referenceDate,
    completed_at: new Date().toISOString(),
    points_awarded: chore.points,
    note: String(formData.get("note") ?? "") || null,
    created_by: profile.id
  }, { onConflict: "chore_id,member_id,reference_date" });
  if (error) throw new Error(error.message);

  revalidatePath("/app/limpeza");
}

export async function deleteChore(formData: FormData) {
  const { profile, supabase } = await requireAdmin();
  const { error } = await supabase.from("chores").delete().eq("id", String(formData.get("chore_id"))).eq("household_id", profile.household_id);
  if (error) throw new Error(error.message);
  revalidatePath("/app/limpeza");
}
