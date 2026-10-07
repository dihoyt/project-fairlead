import type { ReactNode } from "react";
import { Center, Paper, Stack, Text, Title } from "@mantine/core";
import { product } from "../../product";

// The frame every pre-shell screen (sign-in, forced password change,
// forced two-factor) shares.
export function AuthCard({
  siteName,
  width = 380,
  children,
}: {
  siteName?: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" w={width} maw="100%">
        <Stack gap="md">
          <Stack gap={0}>
            <Title order={3}>{siteName || product.displayName}</Title>
            {siteName && siteName !== product.displayName ? (
              <Text size="xs" c="dimmed">
                {product.displayName}
              </Text>
            ) : (
              <Text size="xs" c="dimmed">
                {product.tagline}
              </Text>
            )}
          </Stack>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}
