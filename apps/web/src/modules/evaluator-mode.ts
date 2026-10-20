import { getDb } from "@/lib/supabase";

/**
 * Account mode ("demo" | "live") the strategy evaluators are deployed with.
 *
 * The evaluators only ever list rows for their own account mode (from OKX_TRADE_DEMO on the
 * Edge side), so the dashboard must create rows with that same mode — anything else is armed
 * forever and never evaluated. Precedence:
 * 1. explicit HIVE_EVALUATOR_MODE env (the authority when the deployment sets it);
 * 2. the mode order-submit last wrote to the orders table: the evaluators must agree with
 *    order-submit on OKX_TRADE_DEMO by ops convention, and every order row records its mode;
 * 3. null when neither is available: callers keep offering both modes instead of guessing
 *    wrong and rejecting the deployment's real mode.
 */
export async function evaluatorAccountMode(): Promise<"demo" | "live" | null> {
  const explicit = process.env.HIVE_EVALUATOR_MODE;
  if (explicit === "demo" || explicit === "live") return explicit;
  try {
    const db = getDb();
    const { data, error } = await db
      .from("orders")
      .select("mode")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && (data?.mode === "demo" || data?.mode === "live")) return data.mode;
  } catch {
    // Fall through to null: never guess.
  }
  return null;
}
