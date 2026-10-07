import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { HealthModule } from "../health/health.module";
import { ProjectsModule } from "../projects/projects.module";
import { ProcessingModule } from "../processing/processing.module";
import { VideosModule } from "../videos/videos.module";
import { EditModeModule } from "../edit-mode/edit-mode.module";
import { QuickReframeModule } from '../quick-reframe/quick-reframe.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule, HealthModule, ProjectsModule, ProcessingModule, VideosModule,
    EditModeModule, QuickReframeModule]
})
export class AppModule {}
