import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { CreateProjectDto } from "./dto/create-project.dto";

const serializeVideo = (video: {
  sizeBytes: bigint;
  bitrate?: bigint | null;
  transcript?: { id: string } | null;
  _count?: { chunks: number };
  [key: string]: unknown;
}) => {
  const { transcript, _count, ...data } = video;
  return {
    ...data,
    hasTranscript: !!transcript,
    hasChunks: (_count?.chunks ?? 0) > 0,
    sizeBytes: Number(video.sizeBytes),
    bitrate: video.bitrate == null ? video.bitrate : Number(video.bitrate)
  };
};

const serializeProject = (project: {
  videos: Array<{ sizeBytes: bigint; [key: string]: unknown }>;
  [key: string]: unknown;
}) => ({
  ...project,
  videos: project.videos.map(serializeVideo)
});

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const projects = await this.prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        videos: {
          orderBy: { createdAt: "desc" },
          include: {
            processingStages: true,
            processingJobs: { orderBy: { createdAt: "desc" }, take: 1 },
            transcript: { select: { id: true } },
            _count: { select: { chunks: true } }
          }
        }
      }
    });

    return projects.map(serializeProject);
  }

  async getById(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        videos: {
          orderBy: { createdAt: "desc" },
          include: {
            processingStages: true,
            processingJobs: { orderBy: { createdAt: "desc" }, take: 1 },
            transcript: { select: { id: true } },
            _count: { select: { chunks: true } }
          }
        }
      }
    });

    return project ? serializeProject(project) : null;
  }

  async create(input: CreateProjectDto) {
    const project = await this.prisma.project.create({
      data: input,
      include: { videos: true }
    });

    return serializeProject(project);
  }
}
