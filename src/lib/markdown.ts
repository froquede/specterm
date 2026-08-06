import MarkdownIt from "markdown-it";
import { loadMermaid, wrapInViewport } from "./mermaid";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

// Custom fence renderer for mermaid blocks
const defaultFence =
  md.renderer.rules.fence ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === "mermaid") {
    const escaped = md.utils
      .escapeHtml(token.content)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    return `<pre class="mermaid">${escaped}</pre>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// A relative `![alt](./diagram.png)` is written relative to the note's own
// folder, but the preview pane's document lives at dist/index.html — so
// resolve it against the note's directory the same way MarkdownPane already
// resolves relative links to other notes. Anything already absolute or
// carrying its own scheme (http:, data:, file:, ...) is left untouched.
const defaultImage =
  md.renderer.rules.image ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src");
  if (src && env?.baseDir && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("/")) {
    token.attrSet("src", `${env.baseDir}/${src}`);
  }
  return defaultImage(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string, baseDir?: string): string {
  return md.render(source, { baseDir });
}

// The mermaid library itself — loading, palette and the pan/zoom viewport —
// lives in lib/mermaid.ts, shared with the terminal diagram overlay. This is
// only the markdown-specific half: finding the blocks the fence renderer left
// behind and handing them to mermaid in place.
export async function renderMermaidBlocks(
  container: HTMLElement
): Promise<void> {
  const mermaidEls = container.querySelectorAll("pre.mermaid");
  if (mermaidEls.length === 0) return;

  const mermaid = await loadMermaid();
  await mermaid.run({ nodes: mermaidEls as NodeListOf<HTMLElement> });

  // Wrap rendered mermaid diagrams with pan/zoom containers
  for (const svg of container.querySelectorAll("pre.mermaid svg")) {
    if (svg.parentElement?.querySelector(".mermaid-viewport")) continue;
    wrapInViewport(svg);
  }
}
