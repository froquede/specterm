import type { Terminal } from "@xterm/xterm";

export interface OscOpenMarkdown {
  path: string;
  mode: "split" | "tab";
}

export function registerOscHandler(
  term: Terminal,
  onOpenMarkdown: (params: OscOpenMarkdown) => void
): void {
  term.parser.registerOscHandler(1337, (data: string) => {
    if (!data.startsWith("OpenMD;")) return false;

    const params: Record<string, string> = {};
    const parts = data.split(";").slice(1);
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        params[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
      }
    }

    if (params.path) {
      onOpenMarkdown({
        path: params.path,
        mode: (params.mode as "split" | "tab") || "split",
      });
      return true;
    }

    return false;
  });
}
