import { createComputer } from "../src/index.js";

const computer = await createComputer({
  session: "quickstart",
  policy: {
    allowHeaded: false,
    allowCoordinates: false
  }
});

const app = process.env.NEXCORE_APP || "Calculator";
const snapshot = await computer.observe({ surface: "desktop", app, maxNodes: 40 });
console.log(snapshot.text);

// Use a fresh ref from the snapshot above:
// await computer.act({ surface: "desktop", app, action: "click", target: "@..." });

await computer.close();
