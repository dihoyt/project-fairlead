import { Alert, Button, Code, CopyButton, Group, SimpleGrid, Stack, Text } from "@mantine/core";

// Shown once: only their hashes are kept, so this is the one chance to
// write them down.
export function TotpRecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <Stack gap="sm">
      <Alert color="yellow" variant="light" title="Save your recovery codes">
        Each one signs you in once if you lose your authenticator. They will not be shown again.
      </Alert>
      <SimpleGrid cols={2} spacing={4}>
        {codes.map((code) => (
          <Code key={code} fz="sm" ta="center">
            {code}
          </Code>
        ))}
      </SimpleGrid>
      <Group justify="space-between">
        <CopyButton value={codes.join("\n")}>
          {({ copied, copy }) => (
            <Button size="xs" variant="default" onClick={copy}>
              {copied ? "Copied" : "Copy all"}
            </Button>
          )}
        </CopyButton>
        <Button size="xs" onClick={onDone}>
          I saved them
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        You can make a new set later from your account page.
      </Text>
    </Stack>
  );
}
