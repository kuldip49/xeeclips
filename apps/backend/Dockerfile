FROM node:22-alpine

# font-noto: full unicode coverage for transcripts and the libass fallback chain.
# font-inter: the caption & headline face the editor asks for by name (see
# src/modules/editing/fonts.ts, which verifies it with fc-match at render time).
RUN apk add --no-cache ffmpeg font-noto font-inter font-eb-garamond

# Install the optional retriever only for deployments authorized to use it.
# yt-dlp comes from the Alpine repository of the base image, so its version is whatever that
# repository ships at build time (logged at startup as event=youtube_import_config). To update it,
# rebuild the image (`docker compose build --no-cache backend && docker compose up -d backend`)
# and re-run the YouTube acceptance checks; never `apk upgrade` inside a running container.
ARG ENABLE_YOUTUBE_IMPORT=false
RUN if [ "$ENABLE_YOUTUBE_IMPORT" = "true" ]; then apk add --no-cache yt-dlp; fi

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY apps/backend apps/backend
COPY packages/shared packages/shared

WORKDIR /app/apps/backend

RUN npm run prisma:generate
RUN npm run build

# In-house, procedurally generated background-music beds: the fallback when the
# curated library has nothing for a mood. Curated tracks live in the mood folders
# under assets/music and are indexed separately into curated.json, so this never
# overwrites them.
RUN node scripts/generate-music-library.cjs assets/music-generated \
 && node scripts/scan-music-library.cjs assets/music --no-loudness

EXPOSE 4000

CMD ["sh", "-c", "npm run db:migrate && npm run start"]
