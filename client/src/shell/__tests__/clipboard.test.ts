import { afterEach, describe, expect, it, vi } from "vitest";
import { installClipboardFallback } from "../clipboard";

describe("installClipboardFallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("copies through execCommand where navigator.clipboard is missing", async () => {
    const nav = {} as Navigator;
    const exec = vi.fn((_command: string) => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    let selected = "";
    vi.spyOn(HTMLTextAreaElement.prototype, "select").mockImplementation(function (this: HTMLTextAreaElement) {
      selected = this.value;
    });

    installClipboardFallback(nav);
    await nav.clipboard.writeText("traefik.kube-system.svc.cluster.local:80");

    expect(exec).toHaveBeenCalledWith("copy");
    expect(selected).toBe("traefik.kube-system.svc.cluster.local:80");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("rejects when the browser refuses the copy", async () => {
    const nav = {} as Navigator;
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    installClipboardFallback(nav);
    await expect(nav.clipboard.writeText("x")).rejects.toThrow("copy was refused");
  });

  it("leaves a real clipboard alone", () => {
    const writeText = vi.fn();
    const nav = { clipboard: { writeText } } as unknown as Navigator;
    installClipboardFallback(nav);
    expect(nav.clipboard.writeText).toBe(writeText);
  });
});
