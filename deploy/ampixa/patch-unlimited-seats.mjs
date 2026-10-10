import { readFile, writeFile } from 'node:fs/promises';

const bundlePath = process.argv[2];
if (!bundlePath) {
  throw new Error('Pass the AFFiNE server bundle path as the first argument.');
}

let bundle = await readFile(bundlePath, 'utf8');

function replaceExactly(needle, replacement, expectedCount = 1) {
  const count = bundle.split(needle).length - 1;
  if (count !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} occurrence(s) of ${JSON.stringify(needle)}, found ${count}. ` +
        'The upstream bundle may have changed; refusing to build a partially patched image.'
    );
  }
  bundle = bundle.split(needle).join(replacement);
}

// Reconciliation drives workspace invitation/acceptance checks and readonly
// overcapacity state. Keep the maximum representable GraphQL Int as the
// sentinel so it fits the non-null quota API in this AFFiNE release.
replaceExactly(
  'g=p.seatLimit??0',
  'g="selfhost_free"===u?2147483647:p.seatLimit??0'
);

// Account-level quota data is also exposed in settings.
replaceExactly(
  'userMemberLimit(e){return"pro"===e||"lifetime_pro"===e||"selfhost_free"===e?10:3}',
  'userMemberLimit(e){return"selfhost_free"===e?2147483647:"pro"===e||"lifetime_pro"===e?10:3}'
);

// Show the unlimited sentinel as a human-readable quota rather than a huge
// integer. This string appears in both user and workspace quota formatters.
replaceExactly(
  'memberLimit:e.memberLimit.toString()',
  'memberLimit:e.memberLimit>=2147483647?"Unlimited":e.memberLimit.toString()',
  2
);

await writeFile(bundlePath, bundle);
