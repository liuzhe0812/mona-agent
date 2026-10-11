export interface ZCodePlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
