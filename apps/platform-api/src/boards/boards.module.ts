import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { BoardsController } from './boards.controller';
import { BoardsService } from './boards.service';

@Module({
  imports: [DashboardModule],
  controllers: [BoardsController],
  providers: [BoardsService],
})
export class BoardsModule {}
