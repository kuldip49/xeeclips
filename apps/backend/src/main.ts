import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app/app.module";
import { requestIdentity } from './modules/auth/request-context';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.use((_req: unknown, res: any, next: () => void) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    requestIdentity.run({}, next);
  });
  const frontendOrigins = (process.env.FRONTEND_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: frontendOrigins,
    credentials: true,
    // A cross-origin <video> can only seek a ranged response when the browser is
    // allowed to read these, so without them EditMode's source preview and its
    // rendered export preview both refuse to load.
    exposedHeaders: ["Accept-Ranges", "Content-Range", "Content-Length"]
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
