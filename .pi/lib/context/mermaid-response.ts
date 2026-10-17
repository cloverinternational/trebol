/** Only complete, standalone fenced blocks in a successful assistant response are eligible. */
const MAX_RESPONSE = 256_000;
const MAX_DIAGRAM = 16_000;
const MAX_BLOCKS = 16;
export type Validator = (diagram: string) => Promise<boolean>;

/**
 * mermaid is a browser library: with no DOM, dompurify's createDOMPurify()
 * hits its unsupported-window early return BEFORE defining addHook, so
 * mermaid's module init throws ("DOMPurify.addHook is not a function") and
 * repair silently no-ops in Node. Install the minimal surface dompurify's
 * window check requires (nodeType 9 document, window.Element,
 * implementation.createHTMLDocument) ONLY across the module import, then
 * remove it so the host process never observes a fake browser global.
 */
type MermaidParse = (diagram: string, opts: { suppressErrors: boolean }) => Promise<unknown>;
let mermaidImport: Promise<MermaidParse | undefined> | undefined;

async function loadMermaidParse(): Promise<MermaidParse | undefined> {
  const noop = () => {};
  const element = (tag = "div"): any => ({ tagName: String(tag).toUpperCase(), nodeType: 1, style: {}, attributes: {}, children: [], childNodes: [], firstChild: null, parentNode: null, ownerDocument: null, namespaceURI: "http://www.w3.org/1999/xhtml", appendChild(c: any) { this.children.push(c); this.childNodes.push(c); this.firstChild = this.children[0]; return c; }, removeChild(c: any) { this.children = this.children.filter((x: any) => x !== c); return c; }, setAttribute(n: string, v: unknown) { this.attributes[n] = v; }, hasAttribute: () => false, removeAttribute: noop, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop, contains: () => false, toggle: noop }, querySelector: () => null, querySelectorAll: () => [], attachShadow: () => element("#shadow"), getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }), get innerHTML() { return ""; }, set innerHTML(v: string) {}, get outerHTML() { return ""; }, get textContent() { return ""; }, set textContent(v: string) {}, get content() { return element("#content"); } });
  const document: any = { nodeType: 9, contentType: "text/html", createElement: element, createElementNS: (_ns: string, tag: string) => element(tag), createTextNode: (t: string) => ({ nodeType: 3, textContent: t, data: t }), createDocumentFragment: () => element("#fragment"), createEvent: () => ({ initEvent: noop }), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, body: element("body"), documentElement: element("html"), head: element("head"), addEventListener: noop, removeEventListener: noop, implementation: { createHTMLDocument: () => document, createDocument: () => document, hasFeature: () => true } };
  const window: any = { Element: class Element {}, Node: class Node {}, document, DOMParser: class { parseFromString(s: string) { const d = { ...document }; d.body = element("body"); return d; } }, navigator: { userAgent: "node" }, addEventListener: noop, removeEventListener: noop, requestAnimationFrame: (f: () => void) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout, setTimeout, clearTimeout, MutationObserver: class { observe() {} disconnect() {} }, getComputedStyle: () => ({ getPropertyValue: () => "" }), location: { href: "http://localhost/" } };
  window.window = window;
  window.self = window;
  const hadWindow = typeof globalThis.window !== "undefined";
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const installed: Array<[PropertyKey, unknown]> = [];
  const install = () => {
    for (const key of ["window", "document", "Element", "Node", "DOMParser", "MutationObserver", "requestAnimationFrame", "getComputedStyle"]) {
      installed.push([key, (globalThis as any)[key]]);
      (globalThis as any)[key] = (window as any)[key];
    }
    if (!navigatorDescriptor) Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  };
  const restore = () => {
    for (const [key, value] of installed) {
      if (value === undefined) delete (globalThis as any)[key];
      else (globalThis as any)[key] = value;
    }
    if (!navigatorDescriptor) {
      try { delete (globalThis as any).navigator; } catch { /* getter-only is fine: value matches Node's own */ }
    }
  };
  try {
    install();
    const mermaid = (await import("mermaid")).default;
    return (diagram, opts) => mermaid.parse(diagram, opts);
  } catch (error) {
    // Unavailable parser is not an invalid diagram, but the silent no-op must be diagnosable.
    console.error(`[mermaid-response] parser unavailable, diagram repair disabled: ${(error as Error)?.message ?? error}. Run npm install in the trebol checkout.`);
    return undefined;
  } finally {
    restore();
  }
}

/** Cached loader; parse calls after the first reuse the imported module. */
export const validateMermaid: Validator = async (diagram) => {
  mermaidImport ??= loadMermaidParse();
  const parse = await mermaidImport;
  if (!parse) return true; // unavailable parser is not an invalid diagram
  return Boolean(await parse(diagram, { suppressErrors: true }));
};

async function valid(diagram: string, validator: Validator): Promise<boolean | undefined> {
  try { return await validator(diagram); } catch { return undefined; } // unavailable parser is not an invalid diagram
}

/** One unambiguous token fix per diagram, always revalidated by the caller. */
function candidate(diagram: string): string | undefined {
  const lines = diagram.split("\n");
  const flow = /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)\b/.test(lines[0] ?? "");
  const sequence = /^\s*sequenceDiagram\s*$/.test(lines[0] ?? "");
  if (!flow && !sequence) return;
  let changes = 0;
  const fixed = lines.map(line => {
    // Never edit labels, quoted strings, or complex expressions.
    if (/["'\[\]{}|]/.test(line)) return line;
    if (flow && /^\s*[A-Za-z][\w-]*\s+--\s+>\s+[A-Za-z][\w-]*\s*$/.test(line)) {
      changes++;
      return line.replace(/--\s+>/, "-->");
    }
    if (sequence && /^\s*[A-Za-z][\w-]*\s*->>\s*[A-Za-z][\w-]*\s+[^:\s][^:]*$/.test(line)) {
      changes++;
      return line.replace(/(->>\s*[A-Za-z][\w-]*)\s+/, "$1: ");
    }
    return line;
  });
  return changes === 1 ? fixed.join("\n") : undefined;
}

export async function repairMermaidResponse(text: string, validator: Validator = validateMermaid): Promise<string> {
  if (!text || text.length > MAX_RESPONSE || !/(?:```|~~~)mermaid/.test(text)) return text;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let fence: { char: string; count: number; start: number; mermaid: boolean } | undefined;
  let count = 0;
  const replacements: Array<{ start: number; end: number; content: string }> = [];
  let offset = 0;
  for (const line of lines) {
    const start = offset; offset += line.length;
    if (!fence) {
      const open = /^( {0,3})(`{3,}|~{3,})([^\n]*)\r?\n?$/.exec(line);
      if (open) fence = { char: open[2][0], count: open[2].length, start: offset, mermaid: open[3].trim() === "mermaid" && open[1] === "" };
      continue;
    }
    if (!new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.count},}\\s*$`).test(line.trimEnd())) continue;
    if (fence.mermaid && ++count <= MAX_BLOCKS) {
      const original = text.slice(fence.start, start);
      if (original.length <= MAX_DIAGRAM && (await valid(original, validator)) === false) {
        const fixed = candidate(original);
        if (fixed && (await valid(fixed, validator)) === true) replacements.push({ start: fence.start, end: start, content: fixed });
      }
    }
    fence = undefined;
  }
  for (const { start, end, content } of replacements.reverse()) text = text.slice(0, start) + content + text.slice(end);
  return text;
}
