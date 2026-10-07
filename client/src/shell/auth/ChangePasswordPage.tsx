import { Button, Group, Text } from "@mantine/core";
import { AuthCard } from "./AuthCard";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { signOut } from "./signOut";

export function ChangePasswordPage({ siteName, onChanged }: { siteName?: string; onChanged: () => void }) {
  return (
    <AuthCard siteName={siteName} width={400}>
      <Text size="sm">Choose a new password before continuing. The one you signed in with was temporary.</Text>
      <ChangePasswordForm needsCurrent submitLabel="Set new password" onChanged={onChanged} />
      <Group justify="flex-end">
        <Button variant="subtle" size="xs" onClick={() => signOut(onChanged)}>
          Sign out
        </Button>
      </Group>
    </AuthCard>
  );
}
