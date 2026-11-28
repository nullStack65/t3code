// Starts the local app and seeds it, then stays up so specs can be written and re-run quickly:
//   node serve.ts &   then   T3_QA_REUSE=1 playwright test ...
import globalSetup from "./global-setup.ts";

const stop = await globalSetup();
console.log("T3 QA app is up; stop this process to end it.");
const end = () => {
  stop?.();
  process.exit(0);
};
process.on("SIGINT", end);
process.on("SIGTERM", end);
setInterval(() => {}, 1 << 30);
