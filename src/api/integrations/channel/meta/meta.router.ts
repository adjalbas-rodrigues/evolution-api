import { RouterBroker } from '@api/abstract/abstract.router';
import { metaController } from '@api/server.module';
import { ConfigService, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { createHmac, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';

const logger = new Logger('MetaRouter');

function verifyMetaSignature(configService: ConfigService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const appSecret = configService.get<WaBusiness>('WA_BUSINESS').APP_SECRET;
    if (!appSecret) {
      logger.warn('WA_BUSINESS_APP_SECRET not configured — webhook signature check skipped');
      return next();
    }
    const sigHeader = req.header('x-hub-signature-256');
    if (!sigHeader || !sigHeader.startsWith('sha256=')) {
      logger.warn('Missing or malformed X-Hub-Signature-256 header');
      return res.status(401).json({ error: 'missing signature' });
    }
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
      logger.error('rawBody not captured — global json verify callback missing in src/main.ts');
      return res.status(500).json({ error: 'internal' });
    }
    const receivedHex = sigHeader.slice('sha256='.length);
    const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    if (receivedHex.length !== expectedHex.length) {
      logger.warn('Signature length mismatch');
      return res.status(401).json({ error: 'invalid signature' });
    }
    let receivedBuf: Buffer, expectedBuf: Buffer;
    try {
      receivedBuf = Buffer.from(receivedHex, 'hex');
      expectedBuf = Buffer.from(expectedHex, 'hex');
    } catch {
      return res.status(401).json({ error: 'invalid signature format' });
    }
    if (receivedBuf.length !== expectedBuf.length || !timingSafeEqual(receivedBuf, expectedBuf)) {
      logger.warn('Invalid X-Hub-Signature-256');
      return res.status(401).json({ error: 'invalid signature' });
    }
    next();
  };
}

export class MetaRouter extends RouterBroker {
  constructor(readonly configService: ConfigService) {
    super();
    this.router
      .get(this.routerPath('webhook/meta', false), async (req, res) => {
        if (req.query['hub.verify_token'] === configService.get<WaBusiness>('WA_BUSINESS').TOKEN_WEBHOOK)
          res.send(req.query['hub.challenge']);
        else res.status(403).send('Error, wrong validation token');
      })
      .post(this.routerPath('webhook/meta', false), verifyMetaSignature(configService), async (req, res) => {
        const { body } = req;
        const response = await metaController.receiveWebhook(body);
        return res.status(200).json(response);
      });
  }

  public readonly router: Router = Router();
}
