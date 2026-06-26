#!/usr/bin/env node
/**
 * Tombstone binary for the legacy \`okf-vault\` command.
 *
 * Provides guidance to users who invoke the old command after the package upgrade.
 * It exits with code 2 (USAGE) and does not forward commands to \`okv\`.
 */

console.error("`okf-vault` is now `okv` — run `okv <command>`");
process.exit(2);
