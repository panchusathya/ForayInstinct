import { ManagerShell } from "@/app/_components/manager-shell";
import { CandidateProfileForm } from "@/app/_components/manager/profile/profile-form";

export default function Page() {
  return (
    <ManagerShell active="profile">
      <CandidateProfileForm />
    </ManagerShell>
  );
}
