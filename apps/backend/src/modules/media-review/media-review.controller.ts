import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  HttpException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { requestIdentity } from "../auth/request-context";
import { MediaReviewService } from "./media-review.service";
import { VideoReviewError, reviewMessages } from "./media-review.policy";
import { MediaRangeNotSatisfiableError } from "../edit-mode/edit-mode.service";
const user = () => requestIdentity.getStore()!.userId!;
async function http<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof VideoReviewError)
      throw new HttpException(
        {
          code: e.code,
          message:
            reviewMessages[e.code] || "This review could not be completed.",
        },
        403,
      );
    if (e instanceof z.ZodError)
      throw new HttpException(
        {
          code: "INVALID_INPUT",
          message: "Check the review request and try again.",
        },
        400,
      );
    throw e;
  }
}
export function reviewHeaders(res: Response) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
}
export function sendReviewFile(res: Response, file: any) {
  reviewHeaders(res);
  res.status(file.partial ? 206 : 200);
  res.setHeader("Accept-Ranges", file.streamOnly ? "none" : "bytes");
  res.setHeader("Content-Type", "video/mp4");
  if (!file.streamOnly)
    res.setHeader("Content-Length", file.end - file.start + 1);
  res.setHeader(
    "Content-Disposition",
    'inline; filename="approved-review.mp4"',
  );
  if (file.partial)
    res.setHeader(
      "Content-Range",
      `bytes ${file.start}-${file.end}/${file.size}`,
    );
  res.once("close", () => file.stream.destroy());
  file.stream.on("error", () => res.destroy());
  if (file.onDelivered) {
    file.stream.once("end", () => {
      if (!res.destroyed)
        void file
          .onDelivered()
          .then(() => res.end())
          .catch(() => res.destroy());
    });
    file.stream.pipe(res, { end: false });
  } else file.stream.pipe(res);
}
@Controller("mcp/reviews")
export class MediaReviewController {
  constructor(private readonly review: MediaReviewService) {}
  @Get() settings() {
    return http(() => this.review.settings(user()));
  }
  @Get("pending-count") pending() {
    return http(() => this.review.pendingCount(user()));
  }
  @Patch("settings") setting(@Body() body: unknown) {
    return http(() =>
      this.review.setEnabled(
        user(),
        z.object({ enabled: z.boolean() }).strict().parse(body).enabled,
      ),
    );
  }
  @Post("requests") request(@Body() body: unknown) {
    return http(() => {
      const b = z
        .object({ clipId: z.uuid(), connectionId: z.uuid() })
        .strict()
        .parse(body);
      return this.review.requestFromWebsite(user(), b.clipId, b.connectionId);
    });
  }
  @Get(":id/consent") consent(@Param("id") id: string) {
    return http(() => this.review.consent(z.uuid().parse(id), user()));
  }
  @Post(":id/decision") decide(@Param("id") id: string, @Body() body: unknown) {
    return http(() => {
      const b = z
        .object({
          nonce: z.string().length(43),
          approve: z.boolean(),
          allowRevisions: z.boolean().default(false),
        })
        .strict()
        .parse(body);
      return this.review.decide(
        z.uuid().parse(id),
        user(),
        b.nonce,
        b.approve,
        b.allowRevisions,
      );
    });
  }
  @Post(":id/revoke") revoke(@Param("id") id: string) {
    return http(() => this.review.revoke(z.uuid().parse(id), user()));
  }
  @Get(":id/preview") async preview(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      sendReviewFile(
        res,
        await http(() =>
          this.review.preview(z.uuid().parse(id), user(), req.headers.range),
        ),
      );
    } catch (e) {
      if (e instanceof MediaRangeNotSatisfiableError) {
        reviewHeaders(res);
        res.status(416).setHeader("Content-Range", `bytes */${e.size}`).end();
      } else throw e;
    }
  }
}
