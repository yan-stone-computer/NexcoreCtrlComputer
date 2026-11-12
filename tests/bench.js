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
const inlinePlan = JSON.stringify({
  mode: "run",
  steps: [
    {
      act: {
        surface: "browser",
        action: "fill",
        target: { role: "textbox", name: "Name" },
        text: "Ada"
      }
    },
    {
      act: {
        surface: "browser",
        action: "click",
        target: { role: "button", name: "Save" }
      }
    }
  ]
});
const programCall = JSON.stringify({
  mode: "program_run",
  programName: "browser.fill-and-save",
  params: { value: "Ada" }
});
const inlineBytes = Buffer.byteLength(inlinePlan);
const programBytes = Buffer.byteLength(programCall);
console.log(JSON.stringify({
  snapshot: {
    fixture: "30-node synthetic accessibility tree",
    rawBytes,
    compactBytes,
    reductionPercent: Number((100 - (compactBytes / rawBytes) * 100).toFixed(1)),
    estimatedRawTokens: Math.ceil(rawBytes / 4),
    estimatedCompactTokens: Math.ceil(compactBytes / 4)
  },
  programReplay: {
    fixture: "two-step browser plan",
    inlineBytes,
    programBytes,
    reductionPercent: Number((100 - (programBytes / inlineBytes) * 100).toFixed(1)),
    estimatedInlineTokens: Math.ceil(inlineBytes / 4),
    estimatedProgramTokens: Math.ceil(programBytes / 4)
  }
}, null, 2));
