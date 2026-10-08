import { Alert, Loader } from "@mantine/core";
import { useApi } from "../../../ui";
import { LinksFields, useLinksForm } from "../LinksForm";
import { StepFrame, type StepProps } from "../shared";

export function LinksStep({ onFinish }: StepProps) {
  const overview = useApi("GET /api/admin/overview");
  const links = useLinksForm(overview.data?.settings, overview.reload);

  return (
    <StepFrame
      onFinish={async (done) => {
        if (done && !links.saved && !(await links.submit())) throw new Error("Not saved; see the error above.");
        await onFinish(done);
      }}
      intro="The tools you already use. Checks, workloads and category pages link straight into them; leave any you don't run empty."
      fullPage={{ to: "/admin/settings", label: "All settings" }}
      finishLabel="Save and continue"
    >
      {overview.loading && !overview.data ? <Loader size="sm" /> : null}
      {overview.error ? <Alert color="red">{overview.error}</Alert> : null}
      <LinksFields form={links.form} onChange={links.change} />
      {links.error ? <Alert color="red">{links.error}</Alert> : null}
    </StepFrame>
  );
}
