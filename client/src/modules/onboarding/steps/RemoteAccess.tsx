import { SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { WhatIsThis } from "../../../ui/deploy";
import { AppOffer, useDiscovery } from "../discovery";

// Ways to reach this install from outside the home network without opening
// a port: a tunnel or a tailnet.
export function RemoteAccess() {
  const discovery = useDiscovery();
  const offers = discovery.inSlot("remote-access");
  if (!offers.length) return null;
  return (
    <Stack gap="xs" data-remote-access>
      <Title order={5}>Reaching it from outside</Title>
      <WhatIsThis>
        A tunnel or a private network lets you open this page away from home without opening a port on your router.
      </WhatIsThis>
      <Text size="sm" c="dimmed">
        Optional. Inside your network the address above is enough.
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {offers.map((app) => (
          <AppOffer key={app.id} app={app} onDeployed={discovery.refresh} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}
