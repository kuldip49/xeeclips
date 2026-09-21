import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app/app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
    // A cross-origin <video> can only seek a ranged response when the browser is
    // allowed to read these, so without them EditMode's source preview and its
    // rendered export preview both refuse to load.
    exposedHeaders: ["Accept-Ranges", "Content-Range", "Content-Length"]
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
