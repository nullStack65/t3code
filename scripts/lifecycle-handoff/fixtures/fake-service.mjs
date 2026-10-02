// Harmless stand-in for relaunching T3: the "service" comes back and writes a
// readiness marker the supervisor can observe.
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], `ready:${process.pid}\n`);
