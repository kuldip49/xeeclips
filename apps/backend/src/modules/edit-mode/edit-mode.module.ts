import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EditModeAnalysisService } from './edit-mode-analysis.service';
import { EditModeController } from './edit-mode.controller';
import { EditModeService } from './edit-mode.service';

@Module({
  imports: [StorageModule],
  controllers: [EditModeController],
  providers: [EditModeService, EditModeAnalysisService]
})
export class EditModeModule {}

