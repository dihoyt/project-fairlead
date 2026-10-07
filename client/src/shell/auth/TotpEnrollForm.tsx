import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Center, Code, Group, Image, Loader, Stack, Text, TextInput } from "@mantine/core";
import QRCode from "qrcode";
import type { TotpEnrollment } from "@contracts/auth";
import { apiRequest } from "../../ui/api";

interface Props {
  onEnrolled: (recoveryCodes: string[]) => void;
  onCancel?: () => void;
}

// Asks for a fresh secret on mount; nothing is turned on until a code from
// the app confirms it was scanned correctly.
export function TotpEnrollForm({ onEnrolled, onCancel }: Props) {
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiRequest("POST /api/auth/totp/enroll")
      .then(async (result) => {
        if (!live) return;
        setEnrollment(result);
        const image = await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 200 });
        if (live) setQr(image);
      })
      .catch((err: Error) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest("POST /api/auth/totp/confirm", { body: { code } });
      onEnrolled(result.recoveryCodes);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (enrollment === null) return error ? <Alert color="red">{error}</Alert> : <Loader size="sm" />;
  return (
    <form onSubmit={submit}>
      <Stack gap="sm">
        <Text size="sm">Scan this with an authenticator app, then enter the six-digit code it shows.</Text>
        <Center>{qr ? <Image src={qr} alt="Authenticator QR code" w={200} h={200} /> : <Loader size="sm" />}</Center>
        <Text size="xs" c="dimmed">
          Or enter this key by hand:
        </Text>
        <Code block fz="sm" style={{ wordBreak: "break-all" }}>
          {enrollment.secret.replace(/(.{4})/g, "$1 ").trim()}
        </Code>
        {error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : null}
        <TextInput
          label="Code"
          value={code}
          onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          required
          autoFocus
        />
        <Group justify="flex-end">
          {onCancel ? (
            <Button variant="subtle" size="xs" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="xs" loading={busy} disabled={code.length !== 6}>
            Turn on two-factor
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
