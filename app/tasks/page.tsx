import { BrowserBatchRunner } from "@/app/_components/browser-batch-runner";
import { BrowserRunCheckpoints } from "@/app/_components/browser-run-checkpoints";
import { ManagerShell } from "@/app/_components/manager-shell";

export default function TasksPage() {
  return (
    <ManagerShell active="tasks">
      <BrowserBatchRunner />
      <div className="mt-8">
        <BrowserRunCheckpoints />
      </div>
    </ManagerShell>
  );
}
