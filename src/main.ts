#!/usr/bin/env node

import { run } from "./cli/cli.js";

const exitCode = run(process.argv.slice(2));
process.exitCode = exitCode;
