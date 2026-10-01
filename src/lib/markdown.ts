import MarkdownIt from "markdown-it";
import { loadMermaid, wrapInViewport } from "./mermaid";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

// Custom fence renderer for mermaid blocks.
//
// The source goes into the <pre> HTML-escaped and stays escaped: mermaid.run
// reads the element's innerHTML and entity-decodes it, so `<tenant>` or `<br/>`
// in a label reaches the parser exactly as written. Injected raw, the browser
// would parse them as tags first, and the diagram would fail to parse.
const defaultFence =
  md.renderer.rules.fence ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim() === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
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

export interface NoteHeading {
  level: number;
  text: string;
  // 0-based source line the heading starts on.
  line: number;
}

export interface NoteLink {
  // The href exactly as written, before any resolution.
  href: string;
  // 0-based source line of the block the link sits in.
  line: number;
}

// The headings and links of a note, read off the same parser that renders it.
// Sharing the parser is the point: the outline's Nth entry has to be the
// preview's Nth <h1>–<h6>, and a regex over the source disagrees with
// markdown-it about setext headings, headings in lists and `#` inside fences.
export function noteStructure(source: string): {
  headings: NoteHeading[];
  links: NoteLink[];
} {
  const headings: NoteHeading[] = [];
  const links: NoteLink[] = [];
  const tokens = md.parse(source, {});
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open") {
      const inline = tokens[i + 1];
      const text = (inline?.children ?? [])
        .filter((c) => c.type === "text" || c.type === "code_inline")
        .map((c) => c.content)
        .join("")
        .trim();
      headings.push({
        level: Number(token.tag.slice(1)),
        text: text || inline?.content || "",
        line: token.map?.[0] ?? 0,
      });
    } else if (token.type === "inline" && token.children) {
      for (const child of token.children) {
        if (child.type !== "link_open") continue;
        const href = child.attrGet("href");
        if (href) links.push({ href, line: token.map?.[0] ?? 0 });
      }
    }
  }
  return { headings, links };
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
