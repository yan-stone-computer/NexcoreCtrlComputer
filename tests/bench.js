import { compactDesktopSnapshot } from "../src/index.js";

const tree = {
  role: "window",
  name: "Fixture",
  children: Array.from({ length: 30 }, (_, index) => ({
    ref_id: `@sbench:e${index + 1}`,
    role: index % 3 === 0 ? "button" : index % 3 === 1 ? "textfield" : "group",
    name: `Control ${index + 1}`,
    value: index % 3 === 1 ? `value-${index}` : undefined,
    states: ["enabled", "visible"],
    available_actions: ["Click", "SetFocus"],
    children: index % 3 === 2 ? [] : undefined
  }))
};

const raw = JSON.stringify({ app: "Fixture", tree }, null, 2);
const compact = compactDesktopSnapshot({ tree }).text;
const rawBytes = Buffer.byteLength(raw);
const compactBytes = Buffer.byteLength(compact);
console.log(JSON.stringify({
  fixture: "30-node synthetic accessibility tree",
  rawBytes,
  compactBytes,
  reductionPercent: Number((100 - (compactBytes / rawBytes) * 100).toFixed(1)),
  estimatedRawTokens: Math.ceil(rawBytes / 4),
  estimatedCompactTokens: Math.ceil(compactBytes / 4)
}, null, 2));
