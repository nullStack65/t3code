// Harmless stand-in for the real lifecycle command.
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], `applied:${new Date().toISOString()}\n`);
