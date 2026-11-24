// Renders the Hyper key sheet (sheet.ts) as one self-contained HTML document:
// inline CSS, icons as data URIs, no script, no network. Pure.

import { HyperSheet, SheetEntry, SheetGroup, SheetKey } from "./sheet";

const GROUP_TITLES: Record<SheetGroup, string> = {
  apps: "Apps",
  commands: "Commands",
  walkingpad: "WalkingPad app",
};
const GROUP_ORDER: SheetGroup[] = ["apps", "commands", "walkingpad"];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function iconHtml(entry: SheetEntry, className: string): string {
  if (entry.icon) {
    return `<img class="${className}" src="${escape(entry.icon)}" alt="">`;
  }
  const initial = escape(entry.owner.charAt(0).toUpperCase());
  return `<span class="${className} tile" aria-hidden="true">${initial}</span>`;
}

function keyHtml(key: SheetKey, entry: SheetEntry | undefined): string {
  const style = `--x:${key.x};--y:${key.y};--w:${key.w}`;
  const label = escape(key.label);
  if (entry) {
    return `<div class="key bound" style="${style}"><span class="label">${label}</span>${iconHtml(entry, "cap-icon")}<span class="cap-name">${escape(entry.short)}</span></div>`;
  }
  const hyper = key.hyper ? " hyper" : "";
  return `<div class="key${hyper}" style="${style}"><span class="label">${label}</span></div>`;
}

function legendHtml(entries: SheetEntry[]): string {
  return GROUP_ORDER.flatMap((group) => {
    const rows = entries.filter((entry) => entry.group === group);
    if (rows.length === 0) return [];
    const items = rows
      .map(
        (entry) =>
          `<li><kbd class="legend-cap">${escape(entry.cap)}</kbd>${iconHtml(entry, "legend-icon")}<span class="legend-name">${escape(entry.name)}</span></li>`,
      )
      .join("");
    return [
      `<section class="group group-${group}"><h2>${GROUP_TITLES[group]}</h2><ul>${items}</ul></section>`,
    ];
  }).join("");
}

const STYLE = `
@page { size: A4 landscape; margin: 10mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #111; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
kbd { font-family: inherit; }
img { display: block; object-fit: contain; }
.sheet {
  width: 277mm; height: 190mm; padding-bottom: 4mm; display: flex; flex-direction: column;
  justify-content: space-between; overflow: hidden;
}
@media screen {
  body { background: #e6e6e6; }
  .sheet { background: #fff; margin: 10mm auto; padding: 0; }
}
@media print {
  .sheet { margin: 0; }
}

.head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 0.6mm solid #111; padding-bottom: 3mm; }
.head h1 { font-size: 22pt; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
.meta { display: flex; gap: 9mm; margin: 0; }
.meta div { display: flex; gap: 2.5mm; align-items: baseline; }
.meta dt { font-size: 7pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: #555; }
.meta dd { margin: 0; font-size: 10pt; font-weight: 600; }
.meta kbd { font-size: 9.5pt; font-weight: 700; border: 0.25mm solid #111; border-radius: 1.2mm; padding: 0.4mm 1.6mm; box-shadow: 0 0.4mm 0 #111; }

.keyboard { --u: 14.5mm; position: relative; align-self: center; }
.key {
  position: absolute; left: calc(var(--x) * var(--u)); top: calc(var(--y) * var(--u));
  width: calc(var(--w) * var(--u) - 1mm); height: calc(var(--u) - 1mm);
  display: flex; align-items: center; justify-content: center;
  border: 0.25mm solid #d4d4d4; border-radius: 1.8mm; background: #f4f4f4;
  color: #8e8e8e; font-size: 7.5pt; font-weight: 500;
}
.key.bound {
  flex-direction: column; background: #fff; border: 0.35mm solid #111; color: #111;
  box-shadow: 0 0.7mm 0 #111; font-size: 0;
}
.key.bound .label { position: absolute; top: 0.9mm; left: 1.2mm; font-size: 7.5pt; font-weight: 700; line-height: 1; }
.key.bound .cap-icon { position: absolute; top: 2.3mm; left: 50%; transform: translateX(-50%); width: 4.6mm; height: 4.6mm; border-radius: 1mm; }
.key.bound .cap-name {
  position: absolute; left: 0.5mm; right: 0.5mm; bottom: 0.6mm; text-align: center;
  font-size: 5.2pt; font-weight: 600; line-height: 1.15; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.key.hyper { background: #111; border-color: #111; color: #fff; font-weight: 600; }

.legend { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 8mm; border-top: 0.3mm solid #111; padding-top: 3mm; }
.group h2 { font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #444; margin: 0 0 2mm; padding-bottom: 1mm; border-bottom: 0.2mm solid #bbb; }
.group ul { list-style: none; margin: 0; padding: 0; }
.group-apps ul { column-count: 2; column-gap: 6mm; }
.group li { display: flex; align-items: center; gap: 2.5mm; height: 6.6mm; break-inside: avoid; font-size: 9pt; }
.legend-cap {
  min-width: 6.4mm; height: 5mm; padding: 0 1.2mm; display: inline-flex; align-items: center; justify-content: center;
  border: 0.25mm solid #111; border-radius: 1mm; box-shadow: 0 0.4mm 0 #111; background: #fff; font-size: 8pt; font-weight: 700;
}
.legend-icon { width: 5mm; height: 5mm; border-radius: 1.1mm; flex: none; }
.legend-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile { display: inline-flex; align-items: center; justify-content: center; background: #111; color: #fff; font-weight: 700; font-size: 7pt; }
.key.bound .tile { font-size: 7pt; }
`;

export function renderHyperSheet(sheet: HyperSheet): string {
  const entryByCode = new Map<number, SheetEntry>();
  for (const entry of sheet.entries) {
    if (!entryByCode.has(entry.keyCode)) entryByCode.set(entry.keyCode, entry);
  }
  const keys = sheet.keyboard.keys
    .map((key) => keyHtml(key, entryByCode.get(key.keyCode)))
    .join("");
  const palette = sheet.palette
    ? `<div><dt>Palette</dt><dd><kbd>${escape(sheet.palette)}</kbd></dd></div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(sheet.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="sheet">
<header class="head">
<h1>${escape(sheet.title)}</h1>
<dl class="meta"><div><dt>Generated</dt><dd>${escape(sheet.generatedOn)}</dd></div>${palette}</dl>
</header>
<div class="keyboard" style="width:calc(var(--u) * ${sheet.keyboard.width});height:calc(var(--u) * ${sheet.keyboard.height})">${keys}</div>
<div class="legend">${legendHtml(sheet.entries)}</div>
</main>
</body>
</html>
`;
}
