// navigator.clipboard exists only in a secure context, and the console is
// often first reached over plain http (a NodePort or LAN address), where
// every copy button would silently do nothing. The fallback copies through a
// hidden textarea and execCommand, which browsers still allow on a click.
export function copyWithTextarea(text: string): Promise<void> {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy") ? Promise.resolve() : Promise.reject(new Error("copy was refused"));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    area.remove();
  }
}

export function installClipboardFallback(nav: Navigator = navigator): void {
  if ("clipboard" in nav && nav.clipboard) return;
  Object.defineProperty(nav, "clipboard", {
    configurable: true,
    value: { writeText: copyWithTextarea },
  });
}
