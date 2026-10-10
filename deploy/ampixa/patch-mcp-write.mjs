import { readFile, writeFile } from 'node:fs/promises';

const bundlePath = process.argv[2];
if (!bundlePath) {
  throw new Error('Pass the AFFiNE server bundle path as the first argument.');
}

let bundle = await readFile(bundlePath, 'utf8');

function replaceExactly(needle, replacement) {
  const count = bundle.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(
      `Expected exactly one occurrence of ${JSON.stringify(needle)}, found ${count}. ` +
        'The AFFiNE bundle may have changed; refusing to apply a partial patch.'
    );
  }
  bundle = bundle.replace(needle, replacement);
}

const productionWriteGate =
  'env.dev||env.namespaces.canary||env.selfhosted&&process.env.AFFINE_MCP_WRITE_ENABLED==="true"';

replaceExactly(
  'mcpCredentialReadWriteAvailable(){return env.dev||env.namespaces.canary}',
  `mcpCredentialReadWriteAvailable(){return ${productionWriteGate}}`
);

replaceExactly(
  'if(t.accessMode===D.McpAccessMode.READ_WRITE&&!env.dev&&!env.namespaces.canary)throw new N.BadRequestException("MCP write tools are not available")',
  'if(t.accessMode===D.McpAccessMode.READ_WRITE&&!(' +
    productionWriteGate +
    '))throw new N.BadRequestException("MCP write tools are not available")'
);

replaceExactly(
  'if(r===D.McpAccessMode.READ_WRITE&&(env.dev||env.namespaces.canary)){',
  `if(r===D.McpAccessMode.READ_WRITE&&(${productionWriteGate})){`
);

await writeFile(bundlePath, bundle);
