// The mermaid fence renderer (src/lib/markdown.ts).
//
// A ```mermaid block becomes a `<pre class="mermaid">` that mermaid.run later
// reads back through innerHTML and entity-decodes. So the source has to go in
// escaped: anything left raw is parsed as HTML by the browser first, and a
// label like `acme/<tenant>` turns into a `<tenant>` element whose closing
// tag lands at the end of the diagram, which then fails to parse. These checks
// pin that the fence output is escaped and decodes back to the exact source.
//
// No Electron and no DOM: markdown-it runs in node, and mermaid itself is only
// loaded lazily, never by this import.
//
// Run: node --experimental-strip-types test/markdown.mjs
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// src/lib imports its siblings without an extension (`./mermaid`), the way
// Vite resolves them. Node's ESM loader does not, so point relative,
// extensionless specifiers at the `.ts` file.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) {
          try { return await next(specifier + ".ts", context); } catch {}
        }
        return next(specifier, context);
      }
    `)
);

// A URL, not a bare path: on Windows the ESM loader reads "C:" as a scheme.
const { renderMarkdown } = await import(
  pathToFileURL(path.join(root, "src", "lib", "markdown.ts")).href
);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
};

// What mermaid.run does to the <pre>'s innerHTML before parsing.
const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const source = [
  "flowchart LR",
  '  A["acme/<tenant>"] --> B["order/<kind>/<uuid>"]',
  '  B --> C["line one<br/>line two"]',
  '  C --> D["literal &lt;x&gt; & more"]',
  "",
].join("\n");

const html = renderMarkdown("```mermaid\n" + source + "```\n");
const m = html.match(/^<pre class="mermaid">([\s\S]*)<\/pre>\n?$/);

check("renders a single pre.mermaid", !!m, m ? "" : JSON.stringify(html));
const body = m ? m[1] : "";
check("no raw tag from a label", !/<(?!\/?pre\b)/.test(body), JSON.stringify(body));
check("placeholder is escaped", body.includes("acme/&lt;tenant&gt;"));
check("<br/> is escaped", body.includes("line one&lt;br/&gt;line two"));
check("quotes are escaped", body.includes("&quot;acme/"));
check("existing entity is escaped again", body.includes("&amp;lt;x&amp;gt; &amp; more"));
check("decodes back to the exact source", decode(body) === source);

// Other fences keep markdown-it's default renderer.
const code = renderMarkdown("```js\nconst a = '<b>';\n```\n");
check("non-mermaid fence untouched", code.includes('<code class="language-js">'), code);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
