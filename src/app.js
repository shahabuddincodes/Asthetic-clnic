// Builds the Express app. Kept separate from server.js so tests can create it in memory.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { settings } from './config.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';
import { errorHandler, HttpError } from './errors.js';

export function createApp({ db, notifier, now = () => Date.now(), origins = settings.allowedOrigins }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', settings.trustProxy);
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || origins.includes('*') || origins.includes(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Manage-Token'],
    maxAge: 600,
  }));
  app.use(express.json({ limit: '20kb' }));

  const ctx = { db, notifier, now };
  app.use('/api', publicRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'No such endpoint.')));
  app.use(errorHandler);
  return app;
}
