import { useContext, useState } from "react";
import { Button, Tooltip } from "@mantine/core";
import { IconRocket } from "@tabler/icons-react";
import type { DeployButtonProps } from "../contracts";
import { SessionContext } from "../session";
import { DeployDialog } from "./DeployDialog";

export function DeployButton({ appId, initial, label = "Deploy", size = "sm", onDeployed }: DeployButtonProps) {
  const session = useContext(SessionContext);
  const [opened, setOpened] = useState(false);
  // Outside the signed-in shell (the wizard renders inside it, tests may
  // not) the server's admin check is the only gate.
  const admin = session?.me.admin ?? true;
  const button = (
    <Button
      size={size}
      variant="light"
      leftSection={<IconRocket size={size === "xs" ? 14 : 16} />}
      disabled={!admin}
      onClick={() => setOpened(true)}
    >
      {label}
    </Button>
  );

  if (!admin) {
    return (
      <Tooltip label="Only admins can deploy apps">
        <span>{button}</span>
      </Tooltip>
    );
  }
  return (
    <>
      {button}
      {opened ? (
        <DeployDialog
          appId={appId}
          opened={opened}
          onClose={() => setOpened(false)}
          initial={initial}
          onDeployed={onDeployed}
        />
      ) : null}
    </>
  );
}
