import MarkdownIt from "markdown-it";

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

export function renderMarkdown(source: string): string {
  return md.render(source);
}

let mermaidLoaded = false;

export async function renderMermaidBlocks(
  container: HTMLElement
): Promise<void> {
  const mermaidEls = container.querySelectorAll("pre.mermaid");
  if (mermaidEls.length === 0) return;

  if (!mermaidLoaded) {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      themeVariables: {
        darkMode: true,
        background: "#1e1e2e",
        primaryColor: "#89b4fa",
        primaryTextColor: "#cdd6f4",
        primaryBorderColor: "#45475a",
        lineColor: "#6c7086",
        secondaryColor: "#cba6f7",
        tertiaryColor: "#313244",
      },
    });
    mermaidLoaded = true;
  }

  const { default: mermaid } = await import("mermaid");
  await mermaid.run({ nodes: mermaidEls as NodeListOf<HTMLElement> });

  // Wrap rendered mermaid diagrams with pan/zoom containers
  const svgs = container.querySelectorAll("pre.mermaid svg");
  for (const svg of svgs) {
    const pre = svg.parentElement;
    if (!pre || pre.querySelector(".mermaid-viewport")) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "mermaid-viewport";

    const inner = document.createElement("div");
    inner.className = "mermaid-inner";

    pre.replaceChild(wrapper, svg);
    inner.appendChild(svg);
    wrapper.appendChild(inner);

    let scale = 1;
    let panX = 0;
    let panY = 0;

    function applyTransform() {
      inner.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    // Zoom with mouse wheel
    wrapper.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(0.2, Math.min(5, scale * delta));

      // Zoom toward cursor position
      const rect = wrapper.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      panX = cx - (cx - panX) * (newScale / scale);
      panY = cy - (cy - panY) * (newScale / scale);
      scale = newScale;

      applyTransform();
    }, { passive: false });

    // Pan with mouse drag
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      panX = startPanX + (e.clientX - startX);
      panY = startPanY + (e.clientY - startY);
      applyTransform();
    }

    function onMouseUp() {
      if (dragging) {
        dragging = false;
        wrapper.style.cursor = "";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      }
    }

    wrapper.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startPanX = panX;
      startPanY = panY;
      wrapper.style.cursor = "grabbing";
      e.preventDefault();
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });

    // Double-click to reset
    wrapper.addEventListener("dblclick", () => {
      scale = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    });
  }
}
