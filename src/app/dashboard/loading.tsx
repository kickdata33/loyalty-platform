import { StatusMessage } from "@/components/ui/StatusMessage";

export default function DashboardLoading() {
  return (
    <main className="p-6">
      <StatusMessage title="กำลังโหลด…" />
    </main>
  );
}
