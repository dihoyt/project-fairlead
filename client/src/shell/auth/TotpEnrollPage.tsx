import { useState } from "react";
import { Button, Group, Text } from "@mantine/core";
import { AuthCard } from "./AuthCard";
import { TotpEnrollForm } from "./TotpEnrollForm";
import { TotpRecoveryCodes } from "./TotpRecoveryCodes";
import { signOut } from "./signOut";

// The forced step for an account that policy says must have an
// authenticator: the session is real, but every other route refuses it
// until this is done.
export function TotpEnrollPage({ siteName, onDone }: { siteName?: string; onDone: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <AuthCard siteName={siteName} width={420}>
      {codes === null ? (
        <>
          <Text size="sm">
            Two-factor sign-in is required for your account. Set up an authenticator app to continue.
          </Text>
          <TotpEnrollForm onEnrolled={setCodes} />
        </>
      ) : (
        <TotpRecoveryCodes codes={codes} onDone={onDone} />
      )}
      <Group justify="flex-end">
        <Button variant="subtle" size="xs" onClick={() => signOut(onDone)}>
          Sign out
        </Button>
      </Group>
    </AuthCard>
  );
}
