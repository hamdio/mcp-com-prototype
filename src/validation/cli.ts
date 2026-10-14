import { formatReport, NOMINAL, runValidation } from "./run.ts";

const report = await runValidation(NOMINAL);
console.log(formatReport(report));
process.exitCode = report.pass ? 0 : 1;
