import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post
} from "@nestjs/common";
import { CreateProjectDto } from "./dto/create-project.dto";
import { ProjectsService } from "./projects.service";

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  listProjects() {
    return this.projectsService.list();
  }

  @Get(":id")
  async getProject(@Param("id") id: string) {
    const project = await this.projectsService.getById(id);

    if (!project) {
      throw new NotFoundException("Project not found");
    }

    return project;
  }

  @Post()
  createProject(@Body() body: CreateProjectDto) {
    if (!body.name?.trim()) {
      throw new BadRequestException("Project name is required");
    }

    return this.projectsService.create({
      name: body.name.trim(),
      description: body.description?.trim() || undefined
    });
  }
}
