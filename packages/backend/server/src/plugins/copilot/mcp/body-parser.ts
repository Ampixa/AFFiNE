import { HttpException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type RequestHandler } from 'express';

import { Config } from '../../../base';
import { extractTokenFromHeader } from '../../../core/auth/input';
import { attachmentSizeLimit } from './attachment-input';
import { McpCredentialService } from './credential';

// Install before Nest's default 100 KiB JSON parser. Only the authenticated MCP
// endpoint accepts larger JSON; unrelated APIs keep their existing limits.
export function mcpBodyParser(
  credentials: Pick<McpCredentialService, 'authenticate'>
): RequestHandler {
  const parse = json({
    limit: 4 * Math.ceil(attachmentSizeLimit() / 3) + 16 * 1024,
    inflate: false,
  });
  return async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      await credentials.authenticate(
        extractTokenFromHeader(req.get('authorization') ?? '') ?? '',
        String(req.params.workspaceId)
      );
    } catch (error) {
      res
        .status(error instanceof HttpException ? error.getStatus() : 401)
        .json({ error: 'MCP authentication required.' });
      return;
    }
    parse(req, res, error => {
      if (error) {
        res.status(error.status === 413 ? 413 : 400).json({
          error:
            error.status === 413
              ? 'MCP request exceeds the configured attachment size limit.'
              : 'Invalid MCP JSON body. Compression is not accepted.',
        });
        return;
      }
      next();
    });
  };
}

export function installMcpBodyParser(app: NestExpressApplication) {
  const path = app.get(Config).server.path.replace(/^\/+|\/+$/g, '');
  app.use(
    `${path ? `/${path}` : ''}/api/workspaces/:workspaceId/mcp`,
    mcpBodyParser(app.get(McpCredentialService))
  );
}
